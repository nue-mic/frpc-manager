package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nue-mic/frpc-manager/internal/backup"
	"github.com/nue-mic/frpc-manager/internal/manager"
)

// Timeouts for channel operations.
const (
	testTimeout    = 20 * time.Second
	listTimeout    = 30 * time.Second
	restoreTimeout = 5 * time.Minute
)

// maxBrowseObjects caps how many backup objects a browse returns.
const maxBrowseObjects = 500

// BackupHandler implements /api/v1/backup/* — storage channels, schedules and
// run history for the scheduled-backup subsystem.
type BackupHandler struct {
	m       *manager.Manager
	sched   *backup.Scheduler
	restore func([]byte) (map[string]any, error) // restore configs+meta from a zip blob
	log     *slog.Logger
}

// NewBackupHandler wires the handler. sched must be non-nil; restore restores an
// /export/all zip blob (shared with the import handler).
func NewBackupHandler(m *manager.Manager, sched *backup.Scheduler, restore func([]byte) (map[string]any, error), log *slog.Logger) *BackupHandler {
	return &BackupHandler{m: m, sched: sched, restore: restore, log: log}
}

// ---- response views (secrets masked) ----

// channelView renders a channel without its secrets, exposing only *_set flags
// so the UI can show "configured" without ever echoing the credential.
func channelView(ch backup.Channel) map[string]any {
	v := map[string]any{
		"id":         ch.ID,
		"name":       ch.Name,
		"kind":       ch.Kind,
		"created_at": ch.CreatedAt,
		"updated_at": ch.UpdatedAt,
	}
	switch ch.Kind {
	case backup.KindS3:
		if ch.S3 != nil {
			v["s3"] = map[string]any{
				"endpoint":              ch.S3.Endpoint,
				"region":                ch.S3.Region,
				"bucket":                ch.S3.Bucket,
				"access_key_id":         ch.S3.AccessKeyID,
				"prefix":                ch.S3.Prefix,
				"use_ssl":               ch.S3.UseSSL,
				"path_style":            ch.S3.PathStyle,
				"secret_access_key_set": strings.TrimSpace(ch.S3.SecretAccessKey) != "",
			}
		}
	case backup.KindWebDAV:
		if ch.WebDAV != nil {
			v["webdav"] = map[string]any{
				"base_url":     ch.WebDAV.BaseURL,
				"username":     ch.WebDAV.Username,
				"prefix":       ch.WebDAV.Prefix,
				"password_set": strings.TrimSpace(ch.WebDAV.Password) != "",
			}
		}
	}
	return v
}

func (h *BackupHandler) scheduleView(s backup.Schedule, running map[string]bool, last map[string]backup.RunRecord) map[string]any {
	v := map[string]any{
		"id":            s.ID,
		"name":          s.Name,
		"enabled":       s.Enabled,
		"cron":          s.Cron,
		"channel_id":    s.ChannelID,
		"path_template": s.EffectiveTemplate(),
		"retention":     s.Retention,
		"created_at":    s.CreatedAt,
		"updated_at":    s.UpdatedAt,
		"running":       running[s.ID],
	}
	if lr, ok := last[s.ID]; ok {
		v["last_run"] = lr
	}
	return v
}

func (h *BackupHandler) runningSet() map[string]bool {
	out := map[string]bool{}
	for _, id := range h.sched.RunningSchedules() {
		out[id] = true
	}
	return out
}

// lastRuns maps schedule id → its most recent run (history is newest-first).
func (h *BackupHandler) lastRuns() map[string]backup.RunRecord {
	out := map[string]backup.RunRecord{}
	for _, r := range h.m.ListBackupRuns(0) {
		if _, ok := out[r.ScheduleID]; !ok {
			out[r.ScheduleID] = r
		}
	}
	return out
}

func (h *BackupHandler) reload() {
	if err := h.sched.Reload(); err != nil {
		h.log.Warn("backup scheduler reload failed", slog.Any("err", err))
	}
}

// ---- channels ----

// ListChannels GET /backup/channels
func (h *BackupHandler) ListChannels(w http.ResponseWriter, r *http.Request) {
	chans := h.m.ListBackupChannels()
	out := make([]map[string]any, 0, len(chans))
	for _, c := range chans {
		out = append(out, channelView(c))
	}
	WriteJSON(w, http.StatusOK, map[string]any{"channels": out})
}

// CreateChannel POST /backup/channels
func (h *BackupHandler) CreateChannel(w http.ResponseWriter, r *http.Request) {
	var ch backup.Channel
	if !decodeJSON(w, r, &ch) {
		return
	}
	ch.ID = "" // server-assigned
	backup.NormalizeChannel(&ch)
	if err := backup.ValidateChannel(ch); err != nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, err.Error(), nil)
		return
	}
	stored, err := h.m.UpsertBackupChannel(ch)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, "保存渠道失败："+err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusCreated, channelView(stored))
}

// UpdateChannel PUT /backup/channels/{id}. The merge (blank secret → keep
// current) happens inside the store lock against the live stored value, so two
// concurrent edits can't lose each other's fields or merge against a stale secret.
func (h *BackupHandler) UpdateChannel(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	var ch backup.Channel
	if !decodeJSON(w, r, &ch) {
		return
	}
	ch.ID = id
	backup.NormalizeChannel(&ch)
	if err := backup.ValidateChannel(ch); err != nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, err.Error(), nil)
		return
	}
	stored, err := h.m.UpdateBackupChannel(id, func(cur *backup.Channel) {
		merged := backup.MergeChannelSecrets(*cur, ch) // keep cur secret if blank
		merged.ID = cur.ID
		merged.CreatedAt = cur.CreatedAt
		backup.NormalizeChannel(&merged)
		*cur = merged
	})
	if errors.Is(err, manager.ErrNotFound) {
		WriteError(w, http.StatusNotFound, CodeNotFound, "渠道不存在", nil)
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, "保存渠道失败："+err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, channelView(stored))
}

// DeleteChannel DELETE /backup/channels/{id}
func (h *BackupHandler) DeleteChannel(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	for _, s := range h.m.ListBackupSchedules() {
		if s.ChannelID == id {
			WriteError(w, http.StatusConflict, CodeConflict,
				"该渠道被备份计划「"+s.Name+"」引用，请先修改或删除相关计划", nil)
			return
		}
	}
	err := h.m.DeleteBackupChannel(id)
	if errors.Is(err, manager.ErrNotFound) {
		WriteError(w, http.StatusNotFound, CodeNotFound, "渠道不存在", nil)
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, "删除渠道失败："+err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

// TestChannel POST /backup/channels/{id}/test — test a stored channel.
func (h *BackupHandler) TestChannel(w http.ResponseWriter, r *http.Request) {
	ch, ok := h.m.GetBackupChannel(pathID(r))
	if !ok {
		WriteError(w, http.StatusNotFound, CodeNotFound, "渠道不存在", nil)
		return
	}
	h.runTest(w, r, ch)
}

// TestChannelConfig POST /backup/channels/test — test exactly the config in the
// body. It deliberately does NOT reuse a stored secret: otherwise a caller could
// pair an existing channel's secret with an attacker-chosen endpoint/base_url
// and exfiltrate the credential. To test a saved channel with its stored secret,
// use POST /backup/channels/{id}/test (immutable target).
func (h *BackupHandler) TestChannelConfig(w http.ResponseWriter, r *http.Request) {
	var ch backup.Channel
	if !decodeJSON(w, r, &ch) {
		return
	}
	backup.NormalizeChannel(&ch)
	if err := backup.ValidateChannel(ch); err != nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, err.Error(), nil)
		return
	}
	h.runTest(w, r, ch)
}

// runTest reports the connectivity result as a 200 body {ok, error}; a failed
// test is a normal result, not an HTTP error.
func (h *BackupHandler) runTest(w http.ResponseWriter, r *http.Request, ch backup.Channel) {
	ctx, cancel := context.WithTimeout(r.Context(), testTimeout)
	defer cancel()
	if err := h.sched.TestChannel(ctx, ch); err != nil {
		WriteJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ListObjects GET /backup/channels/{id}/objects?prefix= — browse the .zip
// backups that actually exist on the channel (newest first), so an operator can
// pick one to restore. This hits the remote storage, unlike /backup/runs which
// is the host-local execution log.
func (h *BackupHandler) ListObjects(w http.ResponseWriter, r *http.Request) {
	ch, ok := h.m.GetBackupChannel(pathID(r))
	if !ok {
		WriteError(w, http.StatusNotFound, CodeNotFound, "渠道不存在", nil)
		return
	}
	up, err := backup.NewUploader(ch)
	if err != nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "渠道配置无效："+err.Error(), nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), listTimeout)
	defer cancel()
	objs, err := up.List(ctx, r.URL.Query().Get("prefix"))
	if err != nil {
		WriteError(w, http.StatusBadGateway, CodeUpstreamFailure, "列举备份失败："+err.Error(), nil)
		return
	}
	zips := make([]backup.Object, 0, len(objs))
	for _, o := range objs {
		if strings.HasSuffix(o.Key, ".zip") {
			zips = append(zips, o)
		}
	}
	sort.Slice(zips, func(i, j int) bool { return zips[i].Modified.After(zips[j].Modified) })
	truncated := false
	if len(zips) > maxBrowseObjects {
		zips = zips[:maxBrowseObjects]
		truncated = true
	}
	out := make([]map[string]any, 0, len(zips))
	for _, o := range zips {
		out = append(out, map[string]any{
			"key":      o.Key,
			"size":     o.Size,
			"modified": o.Modified.Unix(),
		})
	}
	WriteJSON(w, http.StatusOK, map[string]any{"objects": out, "truncated": truncated})
}

// Restore POST /backup/channels/{id}/restore {key} — download a backup object
// from the channel and restore configs + meta from it (same effect as importing
// that zip via /import/zip).
func (h *BackupHandler) Restore(w http.ResponseWriter, r *http.Request) {
	ch, ok := h.m.GetBackupChannel(pathID(r))
	if !ok {
		WriteError(w, http.StatusNotFound, CodeNotFound, "渠道不存在", nil)
		return
	}
	var body struct {
		Key string `json:"key"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Key) == "" {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "key 必填", nil)
		return
	}
	up, err := backup.NewUploader(ch)
	if err != nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "渠道配置无效："+err.Error(), nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), restoreTimeout)
	defer cancel()
	data, err := up.Get(ctx, body.Key)
	if err != nil {
		WriteError(w, http.StatusBadGateway, CodeUpstreamFailure, "下载备份失败："+err.Error(), nil)
		return
	}
	res, err := h.restore(data)
	if err != nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "备份文件无效（不是有效的 zip 备份）", nil)
		return
	}
	h.log.Warn("restored from backup object",
		slog.String("channel", ch.Name), slog.String("key", body.Key))
	WriteJSON(w, http.StatusOK, res)
}

// Download GET /backup/channels/{id}/download?key= — stream a backup object to
// the browser as a file attachment (the front-end fetches it as a blob so the
// Bearer header is sent).
func (h *BackupHandler) Download(w http.ResponseWriter, r *http.Request) {
	ch, ok := h.m.GetBackupChannel(pathID(r))
	if !ok {
		WriteError(w, http.StatusNotFound, CodeNotFound, "渠道不存在", nil)
		return
	}
	key := r.URL.Query().Get("key")
	if strings.TrimSpace(key) == "" {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "key 必填", nil)
		return
	}
	up, err := backup.NewUploader(ch)
	if err != nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "渠道配置无效："+err.Error(), nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), restoreTimeout)
	defer cancel()
	data, err := up.Get(ctx, key)
	if err != nil {
		WriteError(w, http.StatusBadGateway, CodeUpstreamFailure, "下载备份失败："+err.Error(), nil)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, path.Base(key)))
	_, _ = w.Write(data)
}

// ---- schedules ----

// ListSchedules GET /backup/schedules
func (h *BackupHandler) ListSchedules(w http.ResponseWriter, r *http.Request) {
	scheds := h.m.ListBackupSchedules()
	running := h.runningSet()
	last := h.lastRuns()
	out := make([]map[string]any, 0, len(scheds))
	for _, s := range scheds {
		out = append(out, h.scheduleView(s, running, last))
	}
	WriteJSON(w, http.StatusOK, map[string]any{"schedules": out})
}

// CreateSchedule POST /backup/schedules
func (h *BackupHandler) CreateSchedule(w http.ResponseWriter, r *http.Request) {
	var s backup.Schedule
	if !decodeJSON(w, r, &s) {
		return
	}
	s.ID = ""
	if !h.validateSchedule(w, s) {
		return
	}
	stored, err := h.m.UpsertBackupSchedule(s)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, "保存计划失败："+err.Error(), nil)
		return
	}
	h.reload()
	WriteJSON(w, http.StatusCreated, h.scheduleView(stored, h.runningSet(), h.lastRuns()))
}

// UpdateSchedule PUT /backup/schedules/{id} (atomic replace under the store lock).
func (h *BackupHandler) UpdateSchedule(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	var s backup.Schedule
	if !decodeJSON(w, r, &s) {
		return
	}
	s.ID = id
	if !h.validateSchedule(w, s) {
		return
	}
	stored, err := h.m.UpdateBackupSchedule(id, func(cur *backup.Schedule) {
		created := cur.CreatedAt
		*cur = s
		cur.CreatedAt = created
	})
	if errors.Is(err, manager.ErrNotFound) {
		WriteError(w, http.StatusNotFound, CodeNotFound, "备份计划不存在", nil)
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, "保存计划失败："+err.Error(), nil)
		return
	}
	h.reload()
	WriteJSON(w, http.StatusOK, h.scheduleView(stored, h.runningSet(), h.lastRuns()))
}

// validateSchedule runs schema + referential validation plus a retention-scope
// collision check (two schedules on one channel must not share a retention pool,
// or they'd delete each other's backups). Writes a 400 and returns false on fail.
func (h *BackupHandler) validateSchedule(w http.ResponseWriter, s backup.Schedule) bool {
	if err := backup.ValidateSchedule(s); err != nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, err.Error(), nil)
		return false
	}
	if _, ok := h.m.GetBackupChannel(s.ChannelID); !ok {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "所选存储渠道不存在", nil)
		return false
	}
	sig := h.sched.ScopeSignature(s)
	for _, other := range h.m.ListBackupSchedules() {
		if other.ID == s.ID {
			continue
		}
		if other.ChannelID == s.ChannelID && h.sched.ScopeSignature(other) == sig {
			WriteError(w, http.StatusBadRequest, CodeBadRequest,
				"与备份计划「"+other.Name+"」的存储路径冲突（保留策略会互相误删），请改用不同的计划名或路径模板", nil)
			return false
		}
	}
	return true
}

// DeleteSchedule DELETE /backup/schedules/{id}
func (h *BackupHandler) DeleteSchedule(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	err := h.m.DeleteBackupSchedule(id)
	if errors.Is(err, manager.ErrNotFound) {
		WriteError(w, http.StatusNotFound, CodeNotFound, "备份计划不存在", nil)
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, "删除计划失败："+err.Error(), nil)
		return
	}
	h.reload()
	WriteJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

// ToggleSchedule POST /backup/schedules/{id}/toggle (atomic flip under the lock).
func (h *BackupHandler) ToggleSchedule(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	stored, err := h.m.UpdateBackupSchedule(id, func(s *backup.Schedule) { s.Enabled = !s.Enabled })
	if errors.Is(err, manager.ErrNotFound) {
		WriteError(w, http.StatusNotFound, CodeNotFound, "备份计划不存在", nil)
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, "切换失败："+err.Error(), nil)
		return
	}
	h.reload()
	WriteJSON(w, http.StatusOK, h.scheduleView(stored, h.runningSet(), h.lastRuns()))
}

// RunSchedule POST /backup/schedules/{id}/run — trigger a manual backup now.
func (h *BackupHandler) RunSchedule(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	err := h.sched.RunNow(id)
	switch {
	case errors.Is(err, backup.ErrScheduleNotFound):
		WriteError(w, http.StatusNotFound, CodeNotFound, "备份计划不存在", nil)
	case errors.Is(err, backup.ErrAlreadyRunning):
		WriteError(w, http.StatusConflict, CodeConflict, "该备份计划正在执行中，请稍候", nil)
	case err != nil:
		WriteError(w, http.StatusInternalServerError, CodeInternal, "触发失败："+err.Error(), nil)
	default:
		WriteJSON(w, http.StatusAccepted, map[string]any{"status": "started", "schedule_id": id})
	}
}

// ListRuns GET /backup/runs?limit=50
func (h *BackupHandler) ListRuns(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	runs := h.m.ListBackupRuns(limit)
	if runs == nil {
		runs = []backup.RunRecord{}
	}
	WriteJSON(w, http.StatusOK, map[string]any{"runs": runs})
}
