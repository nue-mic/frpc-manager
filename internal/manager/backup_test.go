package manager

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/nue-mic/frpc-manager/internal/backup"
	"github.com/nue-mic/frpc-manager/internal/eventbus"
)

func sampleChannel(name string) backup.Channel {
	return backup.Channel{
		Name: name, Kind: backup.KindS3,
		S3: &backup.S3Config{Endpoint: "e", Bucket: "b", AccessKeyID: "ak", SecretAccessKey: "sk"},
	}
}

func TestBackupChannelScheduleRunCRUD(t *testing.T) {
	m := newImportTestManager(t)

	ch, err := m.UpsertBackupChannel(sampleChannel("r2"))
	if err != nil {
		t.Fatalf("upsert channel: %v", err)
	}
	if ch.ID == "" || ch.CreatedAt == 0 || ch.UpdatedAt == 0 {
		t.Fatalf("channel missing id/timestamps: %+v", ch)
	}
	if got := m.ListBackupChannels(); len(got) != 1 {
		t.Fatalf("list channels = %d, want 1", len(got))
	}

	// Update keeps id + CreatedAt, bumps name.
	ch.Name = "r2-renamed"
	upd, err := m.UpsertBackupChannel(ch)
	if err != nil {
		t.Fatalf("update channel: %v", err)
	}
	if upd.ID != ch.ID || upd.CreatedAt != ch.CreatedAt {
		t.Fatalf("update changed id/createdAt: %+v", upd)
	}
	if upd.Name != "r2-renamed" {
		t.Fatalf("update name not applied")
	}

	// Schedule referencing the channel.
	sc, err := m.UpsertBackupSchedule(backup.Schedule{
		Name: "每日", Cron: "@daily", ChannelID: ch.ID, Retention: 3,
	})
	if err != nil || sc.ID == "" {
		t.Fatalf("upsert schedule: %v id=%q", err, sc.ID)
	}
	if got, ok := m.GetBackupSchedule(sc.ID); !ok || got.Name != "每日" {
		t.Fatalf("get schedule failed")
	}

	// Run history appends + caps.
	for i := 0; i < backup.RunHistoryCap+5; i++ {
		_ = m.AppendBackupRun(backup.RunRecord{ID: backup.NewID("run"), ScheduleID: sc.ID, Status: backup.StatusSuccess})
	}
	runs := m.ListBackupRuns(0)
	if len(runs) != backup.RunHistoryCap {
		t.Fatalf("run history not capped: %d, want %d", len(runs), backup.RunHistoryCap)
	}

	// Delete schedule then channel.
	if err := m.DeleteBackupSchedule(sc.ID); err != nil {
		t.Fatalf("delete schedule: %v", err)
	}
	if err := m.DeleteBackupChannel(ch.ID); err != nil {
		t.Fatalf("delete channel: %v", err)
	}
	if len(m.ListBackupChannels()) != 0 || len(m.ListBackupSchedules()) != 0 {
		t.Fatalf("delete left residue")
	}

	// Deleting a missing id is ErrNotFound.
	if err := m.DeleteBackupChannel("nope"); err == nil {
		t.Fatalf("expected ErrNotFound deleting missing channel")
	}
}

func TestBackupPersistsAcrossReopen(t *testing.T) {
	tmp := t.TempDir()
	metaPath := filepath.Join(tmp, "meta.json")
	silent := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	open := func() *Manager {
		for _, d := range []string{"logs", "profiles", "stores"} {
			_ = os.MkdirAll(filepath.Join(tmp, d), 0o755)
		}
		m, err := New(Options{
			LogsDir: filepath.Join(tmp, "logs"), ProfilesDir: filepath.Join(tmp, "profiles"),
			StoresDir: filepath.Join(tmp, "stores"), MetaPath: metaPath,
			Logger: silent, Bus: eventbus.New(16),
		})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		return m
	}

	m1 := open()
	ch, _ := m1.UpsertBackupChannel(sampleChannel("dav"))
	_, _ = m1.UpsertBackupSchedule(backup.Schedule{Name: "d", Cron: "@daily", ChannelID: ch.ID})

	// Reopen on the same meta.json — simulates a daemon restart / update.
	m2 := open()
	if len(m2.ListBackupChannels()) != 1 {
		t.Fatalf("channel not persisted across reopen")
	}
	if len(m2.ListBackupSchedules()) != 1 {
		t.Fatalf("schedule not persisted across reopen")
	}
	// Secret survives the round-trip (required for backup/restore migration).
	got, _ := m2.GetBackupChannel(ch.ID)
	if got.S3 == nil || got.S3.SecretAccessKey != "sk" {
		t.Fatalf("secret not persisted: %+v", got.S3)
	}
}

func TestImportMeta_RestoresBackup(t *testing.T) {
	m := newImportTestManager(t)
	blob, _ := json.Marshal(Meta{
		Version: 1,
		Backup: &BackupData{
			Channels:  []backup.Channel{{ID: "ch1", Name: "r2", Kind: backup.KindS3, S3: &backup.S3Config{Endpoint: "e", Bucket: "b"}}},
			Schedules: []backup.Schedule{{ID: "sc1", Name: "d", Cron: "@daily", ChannelID: "ch1"}},
			Runs:      []backup.RunRecord{{ID: "run1", ScheduleID: "sc1", Status: backup.StatusSuccess}},
		},
	})
	_, _, _, bk, err := m.ImportMeta(blob)
	if err != nil || !bk {
		t.Fatalf("ImportMeta backup: bk=%v err=%v", bk, err)
	}
	if len(m.ListBackupChannels()) != 1 || len(m.ListBackupSchedules()) != 1 {
		t.Fatalf("channels/schedules not restored")
	}
	// Runs are host-local history and must NOT be restored from a backup.
	if len(m.ListBackupRuns(0)) != 0 {
		t.Fatalf("runs should not be restored from import")
	}
}

// TestBuildBackupZipRedactsSecrets proves the backup archive carries channel
// structure but NOT the secret — so credentials never ride along to the cloud
// destination or an exported download.
func TestBuildBackupZipRedactsSecrets(t *testing.T) {
	m := newImportTestManager(t)
	_, _ = m.UpsertBackupChannel(backup.Channel{
		Name: "r2", Kind: backup.KindS3,
		S3: &backup.S3Config{Endpoint: "e", Bucket: "b", AccessKeyID: "AKID", SecretAccessKey: "SUPERSECRET123"},
	})

	var buf bytes.Buffer
	if err := m.BuildBackupZip(&buf); err != nil {
		t.Fatalf("BuildBackupZip: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("zip read: %v", err)
	}
	var meta []byte
	for _, f := range zr.File {
		if f.Name == "meta.json" {
			rc, _ := f.Open()
			meta, _ = io.ReadAll(rc)
			rc.Close()
		}
	}
	if meta == nil {
		t.Fatal("meta.json missing from backup zip")
	}
	if bytes.Contains(meta, []byte("SUPERSECRET123")) {
		t.Fatal("secret leaked into backup zip")
	}
	// Structure preserved: channel name + access key id still present.
	if !bytes.Contains(meta, []byte("r2")) || !bytes.Contains(meta, []byte("AKID")) {
		t.Fatal("channel structure missing from redacted meta")
	}
	// The on-disk meta.json still holds the secret (needed for live uploads).
	got, _ := m.GetBackupChannel(m.ListBackupChannels()[0].ID)
	if got.S3 == nil || got.S3.SecretAccessKey != "SUPERSECRET123" {
		t.Fatal("redaction must not touch the live on-disk secret")
	}
}

// TestImportMergesSecretsAndDropsOrphans covers the restore semantics: a blank
// (redacted) imported secret inherits the existing same-id local secret, and a
// schedule referencing a missing channel is dropped.
func TestImportMergesSecretsAndDropsOrphans(t *testing.T) {
	m := newImportTestManager(t)
	local, _ := m.UpsertBackupChannel(backup.Channel{
		Name: "x", Kind: backup.KindS3,
		S3: &backup.S3Config{Endpoint: "e", Bucket: "b", SecretAccessKey: "LOCALSECRET"},
	})

	blob, _ := json.Marshal(Meta{
		Version: 1,
		Backup: &BackupData{
			Channels: []backup.Channel{
				{ID: local.ID, Name: "x-renamed", Kind: backup.KindS3,
					S3: &backup.S3Config{Endpoint: "e", Bucket: "b", SecretAccessKey: ""}}, // redacted
			},
			Schedules: []backup.Schedule{
				{ID: "sc_ok", Name: "good", Cron: "@daily", ChannelID: local.ID},
				{ID: "sc_orphan", Name: "orphan", Cron: "@daily", ChannelID: "ghost"},
			},
		},
	})
	if _, _, _, bk, err := m.ImportMeta(blob); err != nil || !bk {
		t.Fatalf("ImportMeta: bk=%v err=%v", bk, err)
	}

	got, _ := m.GetBackupChannel(local.ID)
	if got.Name != "x-renamed" {
		t.Fatalf("structure not updated on import")
	}
	if got.S3 == nil || got.S3.SecretAccessKey != "LOCALSECRET" {
		t.Fatalf("blank imported secret should inherit local secret, got %q", got.S3.SecretAccessKey)
	}
	scheds := m.ListBackupSchedules()
	if len(scheds) != 1 || scheds[0].Name != "good" {
		t.Fatalf("orphan schedule not dropped: %+v", scheds)
	}
}

// TestUpdateBackupScheduleAtomic verifies the in-lock RMW keeps unrelated fields.
func TestUpdateBackupScheduleAtomic(t *testing.T) {
	m := newImportTestManager(t)
	ch, _ := m.UpsertBackupChannel(sampleChannel("c"))
	sc, _ := m.UpsertBackupSchedule(backup.Schedule{Name: "d", Cron: "0 3 * * *", ChannelID: ch.ID, Retention: 7})

	got, err := m.UpdateBackupSchedule(sc.ID, func(s *backup.Schedule) { s.Enabled = !s.Enabled })
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if !got.Enabled {
		t.Fatalf("enabled not toggled")
	}
	// Toggling enabled must not disturb cron/retention/name.
	if got.Cron != "0 3 * * *" || got.Retention != 7 || got.Name != "d" {
		t.Fatalf("unrelated fields changed: %+v", got)
	}
	if _, err := m.UpdateBackupSchedule("missing", func(*backup.Schedule) {}); err == nil {
		t.Fatalf("expected ErrNotFound for missing id")
	}
}
