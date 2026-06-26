package manager

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nue-mic/frpc-manager/internal/backup"
)

// Meta is the persisted daemon-level metadata stored at /data/meta.json.
// It tracks the user-defined display order. Whether an instance auto-
// starts on daemon boot is now driven by frpmgr.manualStart inside each
// config file; the legacy AutoStart list is kept only so old meta.json
// files round-trip without losing the key.
type Meta struct {
	Version      int              `json:"version"`
	AutoStart    []string         `json:"auto_start"`
	Sort         []string         `json:"sort"`
	LogViewSince map[string]int64 `json:"log_view_since,omitempty"`
	// Branding holds the operator-customizable UI brand name and browser
	// title. nil / empty fields resolve to the Default* constants on read.
	Branding *Branding `json:"branding,omitempty"`
	// SystemConfig holds operator overrides for runtime daemon settings,
	// layered on top of the FRPCMGR_* env defaults. nil fields use the env value.
	SystemConfig *SystemConfig `json:"system_config,omitempty"`
	// Backup holds the scheduled-backup configuration: storage channels,
	// schedules and a rolling run history. Persisted so it survives restart /
	// update; channels+schedules also travel with /export/all backups.
	Backup *BackupData `json:"backup,omitempty"`
}

// BackupData is the persisted scheduled-backup state.
type BackupData struct {
	Channels  []backup.Channel   `json:"channels,omitempty"`
	Schedules []backup.Schedule  `json:"schedules,omitempty"`
	Runs      []backup.RunRecord `json:"runs,omitempty"`
}

func cloneBackupData(b BackupData) BackupData {
	return BackupData{
		Channels:  backup.CloneChannels(b.Channels),
		Schedules: backup.CloneSchedules(b.Schedules),
		Runs:      backup.CloneRuns(b.Runs),
	}
}

// SystemConfig holds operator overrides for runtime daemon settings, persisted
// in meta.json so a Web UI change survives restarts. Each field is a pointer:
// nil means "fall back to the FRPCMGR_* env value", a set value overrides it.
type SystemConfig struct {
	LogLevel          *string   `json:"log_level,omitempty"` // trace|debug|info|warn|error
	SelfUpdateEnabled *bool     `json:"self_update_enabled,omitempty"`
	DocsEnabled       *bool     `json:"docs_enabled,omitempty"`
	CORSOrigins       *[]string `json:"cors_origins,omitempty"`
}

func cloneSystemConfig(c SystemConfig) SystemConfig {
	out := SystemConfig{}
	if c.LogLevel != nil {
		v := *c.LogLevel
		out.LogLevel = &v
	}
	if c.SelfUpdateEnabled != nil {
		v := *c.SelfUpdateEnabled
		out.SelfUpdateEnabled = &v
	}
	if c.DocsEnabled != nil {
		v := *c.DocsEnabled
		out.DocsEnabled = &v
	}
	if c.CORSOrigins != nil {
		v := append([]string(nil), *c.CORSOrigins...)
		out.CORSOrigins = &v
	}
	return out
}

// Branding is the persisted, operator-editable UI branding. Stored inside
// meta.json so it survives browser cache clears and re-logins. Empty fields
// resolve to the Default* constants via Effective().
type Branding struct {
	AppName     string `json:"app_name,omitempty"`
	AppSubtitle string `json:"app_subtitle,omitempty"`
	HTMLTitle   string `json:"html_title,omitempty"`
}

// Default branding values — the single source of truth, matching the
// strings the frontend previously hard-coded. Used as fallback whenever a
// field is unset/empty.
const (
	DefaultAppName     = "FRPC"
	DefaultAppSubtitle = "客户端管理面板"
	DefaultHTMLTitle   = "FRPC · 内网穿透客户端管理控制台"
)

// Effective returns a copy with every empty field filled from the defaults,
// i.e. a branding that is always safe to render directly.
func (b Branding) Effective() Branding {
	out := b
	if strings.TrimSpace(out.AppName) == "" {
		out.AppName = DefaultAppName
	}
	if strings.TrimSpace(out.AppSubtitle) == "" {
		out.AppSubtitle = DefaultAppSubtitle
	}
	if strings.TrimSpace(out.HTMLTitle) == "" {
		out.HTMLTitle = DefaultHTMLTitle
	}
	return out
}

func defaultMeta() *Meta {
	return &Meta{
		Version:      1,
		AutoStart:    []string{},
		Sort:         []string{},
		LogViewSince: map[string]int64{},
	}
}

type metaStore struct {
	path string
	mu   sync.Mutex
	data *Meta
}

func openMetaStore(path string) (*metaStore, error) {
	s := &metaStore{path: path, data: defaultMeta()}
	b, err := os.ReadFile(path)
	switch {
	case err == nil:
		_ = json.Unmarshal(b, s.data)
		if s.data.Version == 0 {
			s.data.Version = 1
		}
		if s.data.AutoStart == nil {
			s.data.AutoStart = []string{}
		}
		if s.data.Sort == nil {
			s.data.Sort = []string{}
		}
		if s.data.LogViewSince == nil {
			s.data.LogViewSince = map[string]int64{}
		}
	case errors.Is(err, os.ErrNotExist):
		// fresh install; write a stub so operators can see the file
		if err := s.flushLocked(); err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	return s, nil
}

func (s *metaStore) snapshot() Meta {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := *s.data
	m.AutoStart = append([]string(nil), s.data.AutoStart...)
	m.Sort = append([]string(nil), s.data.Sort...)
	m.LogViewSince = make(map[string]int64, len(s.data.LogViewSince))
	for k, v := range s.data.LogViewSince {
		m.LogViewSince[k] = v
	}
	if s.data.Branding != nil {
		b := *s.data.Branding
		m.Branding = &b
	}
	if s.data.SystemConfig != nil {
		c := cloneSystemConfig(*s.data.SystemConfig)
		m.SystemConfig = &c
	}
	if s.data.Backup != nil {
		b := cloneBackupData(*s.data.Backup)
		m.Backup = &b
	}
	return m
}

// systemConfig returns the raw stored overrides (no env defaults applied).
func (s *metaStore) systemConfig() SystemConfig {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.SystemConfig == nil {
		return SystemConfig{}
	}
	return cloneSystemConfig(*s.data.SystemConfig)
}

// setSystemConfig persists the overrides wholesale (atomic write).
func (s *metaStore) setSystemConfig(c SystemConfig) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cc := cloneSystemConfig(c)
	s.data.SystemConfig = &cc
	return s.flushLocked()
}

// updateSystemConfig runs the whole read-modify-write under the store lock so
// two concurrent callers can't lose each other's field updates: apply receives
// a clone of the current overrides to mutate, and the result is persisted while
// the lock is still held. A nil field means "follow the env default".
func (s *metaStore) updateSystemConfig(apply func(*SystemConfig)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := SystemConfig{}
	if s.data.SystemConfig != nil {
		cur = cloneSystemConfig(*s.data.SystemConfig)
	}
	apply(&cur)
	cc := cloneSystemConfig(cur)
	s.data.SystemConfig = &cc
	return s.flushLocked()
}

// ---- scheduled-backup persistence (channels / schedules / run history) ----

func (s *metaStore) ensureBackupLocked() *BackupData {
	if s.data.Backup == nil {
		s.data.Backup = &BackupData{}
	}
	return s.data.Backup
}

func (s *metaStore) listBackupChannels() []backup.Channel {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Backup == nil {
		return nil
	}
	return backup.CloneChannels(s.data.Backup.Channels)
}

func (s *metaStore) getBackupChannel(id string) (backup.Channel, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Backup == nil {
		return backup.Channel{}, false
	}
	for _, c := range s.data.Backup.Channels {
		if c.ID == id {
			return c.Clone(), true
		}
	}
	return backup.Channel{}, false
}

// upsertBackupChannel inserts (empty ID → new) or replaces a channel, assigning
// id/timestamps. Returns the stored copy.
func (s *metaStore) upsertBackupChannel(ch backup.Channel) (backup.Channel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bd := s.ensureBackupLocked()
	now := time.Now().Unix()
	if ch.ID == "" {
		ch.ID = backup.NewID("ch")
		ch.CreatedAt = now
		ch.UpdatedAt = now
		bd.Channels = append(bd.Channels, ch.Clone())
		if err := s.flushLocked(); err != nil {
			return backup.Channel{}, err
		}
		return ch.Clone(), nil
	}
	for i := range bd.Channels {
		if bd.Channels[i].ID == ch.ID {
			ch.CreatedAt = bd.Channels[i].CreatedAt
			ch.UpdatedAt = now
			bd.Channels[i] = ch.Clone()
			if err := s.flushLocked(); err != nil {
				return backup.Channel{}, err
			}
			return ch.Clone(), nil
		}
	}
	return backup.Channel{}, ErrNotFound
}

func (s *metaStore) deleteBackupChannel(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Backup == nil {
		return ErrNotFound
	}
	bd := s.data.Backup
	out := bd.Channels[:0:0]
	found := false
	for _, c := range bd.Channels {
		if c.ID == id {
			found = true
			continue
		}
		out = append(out, c)
	}
	if !found {
		return ErrNotFound
	}
	bd.Channels = out
	return s.flushLocked()
}

func (s *metaStore) listBackupSchedules() []backup.Schedule {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Backup == nil {
		return nil
	}
	return backup.CloneSchedules(s.data.Backup.Schedules)
}

func (s *metaStore) getBackupSchedule(id string) (backup.Schedule, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Backup == nil {
		return backup.Schedule{}, false
	}
	for _, sc := range s.data.Backup.Schedules {
		if sc.ID == id {
			return sc, true
		}
	}
	return backup.Schedule{}, false
}

func (s *metaStore) upsertBackupSchedule(sc backup.Schedule) (backup.Schedule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bd := s.ensureBackupLocked()
	now := time.Now().Unix()
	if sc.ID == "" {
		sc.ID = backup.NewID("sc")
		sc.CreatedAt = now
		sc.UpdatedAt = now
		bd.Schedules = append(bd.Schedules, sc)
		if err := s.flushLocked(); err != nil {
			return backup.Schedule{}, err
		}
		return sc, nil
	}
	for i := range bd.Schedules {
		if bd.Schedules[i].ID == sc.ID {
			sc.CreatedAt = bd.Schedules[i].CreatedAt
			sc.UpdatedAt = now
			bd.Schedules[i] = sc
			if err := s.flushLocked(); err != nil {
				return backup.Schedule{}, err
			}
			return sc, nil
		}
	}
	return backup.Schedule{}, ErrNotFound
}

// updateBackupSchedule applies a mutation to a schedule in-place under the
// store lock (atomic read-modify-write), avoiding lost updates from concurrent
// edits. Returns the updated copy or ErrNotFound.
func (s *metaStore) updateBackupSchedule(id string, apply func(*backup.Schedule)) (backup.Schedule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Backup == nil {
		return backup.Schedule{}, ErrNotFound
	}
	for i := range s.data.Backup.Schedules {
		if s.data.Backup.Schedules[i].ID == id {
			apply(&s.data.Backup.Schedules[i])
			s.data.Backup.Schedules[i].ID = id
			s.data.Backup.Schedules[i].UpdatedAt = time.Now().Unix()
			sc := s.data.Backup.Schedules[i]
			if err := s.flushLocked(); err != nil {
				return backup.Schedule{}, err
			}
			return sc, nil
		}
	}
	return backup.Schedule{}, ErrNotFound
}

// updateBackupChannel applies a mutation to a channel in-place under the store
// lock (atomic), so a partial update merges against the live stored value
// (incl. its secret) rather than an API-layer stale snapshot.
func (s *metaStore) updateBackupChannel(id string, apply func(*backup.Channel)) (backup.Channel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Backup == nil {
		return backup.Channel{}, ErrNotFound
	}
	for i := range s.data.Backup.Channels {
		if s.data.Backup.Channels[i].ID == id {
			apply(&s.data.Backup.Channels[i])
			s.data.Backup.Channels[i].ID = id
			s.data.Backup.Channels[i].UpdatedAt = time.Now().Unix()
			ch := s.data.Backup.Channels[i].Clone()
			if err := s.flushLocked(); err != nil {
				return backup.Channel{}, err
			}
			return ch, nil
		}
	}
	return backup.Channel{}, ErrNotFound
}

func (s *metaStore) deleteBackupSchedule(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Backup == nil {
		return ErrNotFound
	}
	bd := s.data.Backup
	out := bd.Schedules[:0:0]
	found := false
	for _, sc := range bd.Schedules {
		if sc.ID == id {
			found = true
			continue
		}
		out = append(out, sc)
	}
	if !found {
		return ErrNotFound
	}
	bd.Schedules = out
	return s.flushLocked()
}

// appendBackupRun appends a run record, trimming history to the newest cap.
func (s *metaStore) appendBackupRun(r backup.RunRecord, cap int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	bd := s.ensureBackupLocked()
	bd.Runs = append(bd.Runs, r)
	if cap > 0 && len(bd.Runs) > cap {
		bd.Runs = append([]backup.RunRecord(nil), bd.Runs[len(bd.Runs)-cap:]...)
	}
	return s.flushLocked()
}

// listBackupRuns returns run records newest-first, capped at limit (0 = all).
func (s *metaStore) listBackupRuns(limit int) []backup.RunRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Backup == nil {
		return nil
	}
	runs := s.data.Backup.Runs
	out := make([]backup.RunRecord, 0, len(runs))
	for i := len(runs) - 1; i >= 0; i-- {
		out = append(out, runs[i])
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// restoreBackupConfig overwrites channels+schedules from an imported backup
// (runs are host-local and not restored). Backups carry redacted (blank)
// secrets, so an imported channel whose secret is blank inherits the secret of
// the existing same-id channel — a same-host re-import keeps working, while a
// cross-host restore comes back with the secret unset (re-enter it). Schedules
// referencing a now-unknown channel are dropped to keep referential integrity.
func (s *metaStore) restoreBackupConfig(channels []backup.Channel, schedules []backup.Schedule) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	bd := s.ensureBackupLocked()
	if channels != nil {
		existing := make(map[string]backup.Channel, len(bd.Channels))
		for _, c := range bd.Channels {
			existing[c.ID] = c
		}
		merged := make([]backup.Channel, len(channels))
		for i, c := range channels {
			if old, ok := existing[c.ID]; ok {
				c = backup.MergeChannelSecrets(old, c) // blank imported secret → keep local
			}
			merged[i] = c.Clone()
		}
		bd.Channels = merged
	}
	if schedules != nil {
		bd.Schedules = backup.CloneSchedules(schedules)
	}
	// Drop schedules whose channel no longer exists (e.g. a channels-less or
	// hand-trimmed import) so we don't arm cron jobs that can only ever fail.
	known := make(map[string]bool, len(bd.Channels))
	for _, c := range bd.Channels {
		known[c.ID] = true
	}
	kept := bd.Schedules[:0:0]
	for _, sc := range bd.Schedules {
		if known[sc.ChannelID] {
			kept = append(kept, sc)
		}
	}
	bd.Schedules = kept
	return s.flushLocked()
}

// branding returns the raw stored branding (no defaults applied). A zero
// value means nothing has been customized yet.
func (s *metaStore) branding() Branding {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Branding == nil {
		return Branding{}
	}
	return *s.data.Branding
}

// setBranding persists the branding wholesale (atomic write).
func (s *metaStore) setBranding(b Branding) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	bc := b
	s.data.Branding = &bc
	return s.flushLocked()
}

func (s *metaStore) setSort(order []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Sort = append([]string(nil), order...)
	return s.flushLocked()
}

// dropIDs removes id from both AutoStart and Sort. Used after a config
// file is deleted.
func (s *metaStore) dropIDs(ids ...string) error {
	if len(ids) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	idset := make(map[string]struct{}, len(ids))
	for _, x := range ids {
		idset[x] = struct{}{}
	}
	s.data.AutoStart = filterOut(s.data.AutoStart, idset)
	s.data.Sort = filterOut(s.data.Sort, idset)
	for id := range idset {
		delete(s.data.LogViewSince, id)
	}
	return s.flushLocked()
}

func (s *metaStore) flushLocked() error {
	tmp := s.path + ".tmp"
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// setLogViewSince 记录"用户在 unixMilli 时刻清空了 id 的日志视图"。
// GET /logs 和 WS /logs/tail 后续会跳过时间戳早于此值的行，达到逻辑清空效果。
func (s *metaStore) setLogViewSince(id string, unixMilli int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.LogViewSince == nil {
		s.data.LogViewSince = map[string]int64{}
	}
	s.data.LogViewSince[id] = unixMilli
	return s.flushLocked()
}

// logViewSince 读取指定 id 的清空戳；不存在返回 0（表示"显示所有历史"）。
func (s *metaStore) logViewSince(id string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.LogViewSince[id]
}

func filterOut(src []string, drop map[string]struct{}) []string {
	out := src[:0:0]
	for _, x := range src {
		if _, ok := drop[x]; ok {
			continue
		}
		out = append(out, x)
	}
	return out
}
