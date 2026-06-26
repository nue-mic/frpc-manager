package manager

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/nue-mic/frpc-manager/internal/backup"
	"github.com/nue-mic/frpc-manager/internal/eventbus"
	"github.com/nue-mic/frpc-manager/pkg/config"
	"github.com/nue-mic/frpc-manager/pkg/consts"
)

// Options configures the Manager.
type Options struct {
	ProfilesDir string
	LogsDir     string
	StoresDir   string
	MetaPath    string
	Logger      *slog.Logger
	Bus         *eventbus.Bus
}

// CombinedLogFileName 是所有 frpc 实例共用的合并日志文件名。
// 完整路径由 Options.LogsDir 拼成。
const CombinedLogFileName = "frpc.log"

// Manager is the central registry of frpc instances. It owns the
// /data/profiles directory and gates every read/write to config files.
type Manager struct {
	opts Options

	mu        sync.RWMutex
	instances map[string]*instance

	meta *metaStore

	rootCtx    context.Context
	rootCancel context.CancelFunc
}

// New constructs a Manager backed by the directories in opts. It does not
// scan the profiles dir; call LoadAll for that.
func New(opts Options) (*Manager, error) {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Bus == nil {
		opts.Bus = eventbus.New(1024)
	}
	meta, err := openMetaStore(opts.MetaPath)
	if err != nil {
		return nil, fmt.Errorf("open meta: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{
		opts:       opts,
		instances:  make(map[string]*instance),
		meta:       meta,
		rootCtx:    ctx,
		rootCancel: cancel,
	}, nil
}

// Bus exposes the event bus so the API layer can subscribe.
func (m *Manager) Bus() *eventbus.Bus { return m.opts.Bus }

// LoadAll scans the profiles dir and registers every parseable file as an
// instance in the stopped state. Unreadable files are logged and skipped.
func (m *Manager) LoadAll() error {
	pattern := filepath.Join(m.opts.ProfilesDir, "*.toml")
	files, err := filepath.Glob(pattern)
	if err != nil {
		return err
	}
	// also include legacy .conf / .ini for back-compat with imported files
	for _, ext := range []string{"*.conf", "*.ini"} {
		extra, _ := filepath.Glob(filepath.Join(m.opts.ProfilesDir, ext))
		files = append(files, extra...)
	}
	for _, f := range files {
		data, err := config.UnmarshalClientConf(f)
		if err != nil {
			m.opts.Logger.Warn("skip unparseable config", slog.String("path", f), slog.Any("err", err))
			continue
		}
		id := idFromPath(f)
		if data.Name() == "" {
			data.ClientCommon.Name = id
		}
		inst := newInstance(id, f, data, m.opts.Logger, m.opts.Bus)
		m.mu.Lock()
		m.instances[id] = inst
		m.mu.Unlock()
	}
	return nil
}

// AutoStart launches every loaded instance whose config does NOT have
// frpmgr.manualStart=true. Default (unset / false) means auto-start, so
// fresh imports come up on daemon boot without extra setup. Errors are
// logged but do not abort the daemon. Instances are started in the
// order recorded by meta.json (unknown ids fall back to id order) so
// boot sequence is deterministic across restarts.
func (m *Manager) AutoStart() {
	m.mu.RLock()
	ids := make([]string, 0, len(m.instances))
	for id := range m.instances {
		ids = append(ids, id)
	}
	m.mu.RUnlock()

	order := m.meta.snapshot().Sort
	idx := make(map[string]int, len(order))
	for i, id := range order {
		idx[id] = i
	}
	sort.SliceStable(ids, func(a, b int) bool {
		ia, oka := idx[ids[a]]
		ib, okb := idx[ids[b]]
		switch {
		case oka && okb:
			return ia < ib
		case oka:
			return true
		case okb:
			return false
		default:
			return ids[a] < ids[b]
		}
	})

	for _, id := range ids {
		inst := m.get(id)
		if inst == nil {
			continue
		}
		if data := inst.Data(); data != nil && data.ManualStart {
			continue
		}
		if err := m.Start(id); err != nil {
			m.opts.Logger.Warn("auto-start failed", slog.String("id", id), slog.Any("err", err))
		}
	}
}

// Shutdown stops every running instance and releases resources.
func (m *Manager) Shutdown() {
	m.rootCancel()
	m.mu.RLock()
	ids := make([]string, 0, len(m.instances))
	for id := range m.instances {
		ids = append(ids, id)
	}
	m.mu.RUnlock()
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			if inst := m.get(id); inst != nil {
				_ = inst.stop()
				inst.cancelAutoDelete()
			}
		}(id)
	}
	wg.Wait()
}

func (m *Manager) get(id string) *instance {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.instances[id]
}

// Exists reports whether an instance with this id is registered.
func (m *Manager) Exists(id string) bool { return m.get(id) != nil }

// List returns a snapshot of every registered instance, in the order
// recorded by meta.json (unknown ids appended at the end).
func (m *Manager) List() []Snapshot {
	m.mu.RLock()
	ids := make([]string, 0, len(m.instances))
	for id := range m.instances {
		ids = append(ids, id)
	}
	m.mu.RUnlock()

	order := m.meta.snapshot().Sort
	idx := make(map[string]int, len(order))
	for i, id := range order {
		idx[id] = i
	}
	sort.SliceStable(ids, func(a, b int) bool {
		ia, oka := idx[ids[a]]
		ib, okb := idx[ids[b]]
		switch {
		case oka && okb:
			return ia < ib
		case oka:
			return true
		case okb:
			return false
		default:
			return ids[a] < ids[b]
		}
	})

	out := make([]Snapshot, 0, len(ids))
	for _, id := range ids {
		if inst := m.get(id); inst != nil {
			out = append(out, inst.Snapshot(false))
		}
	}
	return out
}

// Get returns the snapshot of a single config, optionally including
// per-proxy status.
func (m *Manager) Get(id string, includeProxies bool) (Snapshot, *config.ClientConfig, error) {
	inst := m.get(id)
	if inst == nil {
		return Snapshot{}, nil, ErrNotFound
	}
	return inst.Snapshot(includeProxies), inst.Data(), nil
}

// Create persists a new config file and registers an instance. id must
// be a clean file-name token (a-z, 0-9, dash, underscore).
func (m *Manager) Create(id string, data *config.ClientConfig) error {
	if err := validateID(id); err != nil {
		return err
	}
	if m.Exists(id) {
		return ErrExists
	}
	path := m.pathFor(id)
	if err := m.writeConfig(path, data); err != nil {
		return err
	}
	if data.Name() == "" {
		data.ClientCommon.Name = id
	}
	inst := newInstance(id, path, data, m.opts.Logger, m.opts.Bus)
	m.mu.Lock()
	m.instances[id] = inst
	m.mu.Unlock()
	// keep meta.sort in sync
	cur := m.meta.snapshot().Sort
	if !slices.Contains(cur, id) {
		cur = append(cur, id)
		_ = m.meta.setSort(cur)
	}
	return nil
}

// Update replaces the config file and live data. If the instance is
// running it is hot-reloaded so proxy add/edit/delete take effect
// immediately; a stopped instance simply picks up the new file on next
// start. Reload is best-effort — its failure is logged and surfaced via
// the instance error event, but does not fail the update itself.
func (m *Manager) Update(id string, data *config.ClientConfig) error {
	inst := m.get(id)
	if inst == nil {
		return ErrNotFound
	}
	if data.Name() == "" {
		data.ClientCommon.Name = id
	}
	if err := m.writeConfig(inst.Path(), data); err != nil {
		return err
	}
	inst.replaceData(data)
	if inst.State() == consts.ConfigStateStarted {
		if err := inst.reload(); err != nil {
			m.opts.Logger.Warn("auto-reload after update failed", slog.String("id", id), slog.Any("err", err))
		}
	}
	if m.opts.Bus != nil {
		m.opts.Bus.Publish(eventbus.TypeConfigChanged, id, nil)
	}
	return nil
}

// Delete stops the instance (if running), removes the file and updates
// meta.json.
func (m *Manager) Delete(id string) error {
	inst := m.get(id)
	if inst == nil {
		return ErrNotFound
	}
	_ = inst.stop()
	inst.cancelAutoDelete()

	if err := os.Remove(inst.Path()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	m.mu.Lock()
	delete(m.instances, id)
	m.mu.Unlock()
	_ = m.meta.dropIDs(id)
	if m.opts.Bus != nil {
		m.opts.Bus.Publish(eventbus.TypeConfigDeleted, id, nil)
	}
	return nil
}

// Start launches the instance. No-op if already running.
func (m *Manager) Start(id string) error {
	inst := m.get(id)
	if inst == nil {
		return ErrNotFound
	}
	return inst.start(m.rootCtx)
}

// Stop terminates the instance. No-op if already stopped.
func (m *Manager) Stop(id string) error {
	inst := m.get(id)
	if inst == nil {
		return ErrNotFound
	}
	return inst.stop()
}

// Reload hot-reloads the underlying frp service after re-parsing the file.
func (m *Manager) Reload(id string) error {
	inst := m.get(id)
	if inst == nil {
		return ErrNotFound
	}
	return inst.reload()
}

// ReadRaw returns the raw bytes of the config file on disk.
func (m *Manager) ReadRaw(id string) ([]byte, error) {
	inst := m.get(id)
	if inst == nil {
		return nil, ErrNotFound
	}
	return os.ReadFile(inst.Path())
}

// WriteRaw replaces the config file with raw TOML/INI bytes after a
// syntactic parse check. Live data is refreshed on success.
func (m *Manager) WriteRaw(id string, b []byte) error {
	inst := m.get(id)
	if inst == nil {
		return ErrNotFound
	}
	data, err := config.UnmarshalClientConf(b)
	if err != nil {
		return fmt.Errorf("parse: %w", err)
	}
	if data.Name() == "" {
		data.ClientCommon.Name = id
	}
	if err := writeAtomic(inst.Path(), b); err != nil {
		return err
	}
	inst.replaceData(data)
	return nil
}

// Reorder persists the visual ordering used by the API list response.
func (m *Manager) Reorder(order []string) error {
	// ignore unknown ids
	known := make(map[string]struct{})
	m.mu.RLock()
	for id := range m.instances {
		known[id] = struct{}{}
	}
	m.mu.RUnlock()
	cleaned := make([]string, 0, len(order))
	for _, id := range order {
		if _, ok := known[id]; ok {
			cleaned = append(cleaned, id)
		}
	}
	return m.meta.setSort(cleaned)
}

// ProfilesDir reports the directory the manager owns.
func (m *Manager) ProfilesDir() string { return m.opts.ProfilesDir }

// MetaPath reports the on-disk path of meta.json (branding, sort, …). Used by
// the export endpoint so a backup carries the operator's branding too.
func (m *Manager) MetaPath() string { return m.opts.MetaPath }

// VisitorConflict describes an existing visitor whose local listener collides
// with a candidate one (same protocol family + bindPort + overlapping addr).
type VisitorConflict struct {
	ConfigID   string
	ConfigName string
	Name       string
	Type       string
	BindAddr   string
	BindPort   int
}

// visitorProto maps a visitor type to its local-listener protocol family.
// STCP/XTCP listen on TCP, SUDP on UDP (frp client/visitor/{stcp,xtcp,sudp}.go),
// so STCP and XTCP on the same addr:port DO collide, while SUDP is independent.
func visitorProto(t string) string {
	switch strings.ToLower(strings.TrimSpace(t)) {
	case "stcp", "xtcp":
		return "tcp"
	case "sudp":
		return "udp"
	default:
		return ""
	}
}

// normBindAddr resolves an empty bind address to frp's actual default for a
// visitor listener: 127.0.0.1 (loopback only), NOT 0.0.0.0. frp v0.69.1
// pkg/config/v1/visitor.go fills an empty BindAddr with 127.0.0.1, so an empty
// value must not be treated as a wildcard (that would falsely collide with a
// specific LAN IP on the same port).
func normBindAddr(a string) string {
	if a = strings.TrimSpace(a); a == "" {
		return "127.0.0.1"
	}
	return a
}

func isWildcardAddr(a string) bool { return a == "0.0.0.0" || a == "::" || a == "*" }

// addrsOverlap reports whether two bind addresses on the same port collide.
// A wildcard (0.0.0.0 / :: / *) binds every interface so it overlaps any
// address; two distinct specific addresses do not collide.
//
// Limitations (this is a best-effort pre-check; frp's own net.Listen is the
// final authority at start time): comparison is literal — a hostname and an
// equivalent IP ("localhost" vs "127.0.0.1") are not recognized as the same
// (false negative), and IPv4 0.0.0.0 is treated as overlapping any address
// including IPv6-only ones (rare false positive). Both are fail-safe-ish given
// the UI now defaults every bind address to 0.0.0.0.
func addrsOverlap(a, b string) bool {
	a, b = normBindAddr(a), normBindAddr(b)
	return a == b || isWildcardAddr(a) || isWildcardAddr(b)
}

// visitorScan returns the first existing visitor (across all instances) whose
// local listener collides with proto+bindPort+bindAddr and for which
// skip(configID, visitorName) is false. Instances are visited in id order so
// the reported conflict is deterministic when several would match.
func (m *Manager) visitorScan(proto string, bindPort int, bindAddr string, skip func(id, name string) bool) *VisitorConflict {
	if proto == "" || bindPort <= 0 {
		return nil
	}
	type pair struct {
		id   string
		inst *instance
	}
	m.mu.RLock()
	pairs := make([]pair, 0, len(m.instances))
	for id, inst := range m.instances {
		pairs = append(pairs, pair{id, inst})
	}
	m.mu.RUnlock()
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].id < pairs[j].id })

	for _, pr := range pairs {
		data := pr.inst.Data()
		if data == nil {
			continue
		}
		for _, p := range data.Proxies {
			if !p.IsVisitor() || p.BindPort != bindPort || visitorProto(p.Type) != proto {
				continue
			}
			if skip(pr.id, p.Name) || !addrsOverlap(p.BindAddr, bindAddr) {
				continue
			}
			name := data.Name()
			if name == "" {
				name = pr.id
			}
			return &VisitorConflict{
				ConfigID: pr.id, ConfigName: name, Name: p.Name,
				Type: p.Type, BindAddr: normBindAddr(p.BindAddr), BindPort: p.BindPort,
			}
		}
	}
	return nil
}

// VisitorBindConflict scans every instance's visitors (including this config)
// for one whose local listener would collide with the candidate (same protocol
// family + bindPort + overlapping bindAddr), excluding only the single visitor
// identified by excludeID+excludeName (the one being edited). bindPort <= 0
// means "no local listener" and never conflicts.
func (m *Manager) VisitorBindConflict(excludeID, excludeName, vType, bindAddr string, bindPort int) *VisitorConflict {
	return m.visitorScan(visitorProto(vType), bindPort, bindAddr, func(id, name string) bool {
		return id == excludeID && name == excludeName
	})
}

// ValidateVisitorBinds checks every visitor in data (the config about to be
// saved under id) for a local-port conflict — against any OTHER instance's
// visitors, and against earlier visitors within data itself. The whole config
// id is excluded from the cross-instance scan because data replaces it. Used by
// the full-config / raw-TOML save paths so a hand-authored conflict is caught
// before it is persisted. Returns the first conflict or nil.
func (m *Manager) ValidateVisitorBinds(id string, data *config.ClientConfig) *VisitorConflict {
	if data == nil {
		return nil
	}
	type vb struct {
		name, vtype, addr, proto string
		port                     int
	}
	var seen []vb
	for _, p := range data.Proxies {
		if !p.IsVisitor() {
			continue
		}
		proto := visitorProto(p.Type)
		if proto == "" || p.BindPort <= 0 {
			continue
		}
		// against other instances (the whole config id is being replaced)
		if c := m.visitorScan(proto, p.BindPort, p.BindAddr, func(cid, _ string) bool { return cid == id }); c != nil {
			return c
		}
		// against earlier visitors in this same incoming config
		for _, s := range seen {
			if s.proto == proto && s.port == p.BindPort && addrsOverlap(s.addr, p.BindAddr) {
				nm := data.Name()
				if nm == "" {
					nm = id
				}
				return &VisitorConflict{
					ConfigID: id, ConfigName: nm, Name: s.name,
					Type: s.vtype, BindAddr: normBindAddr(s.addr), BindPort: s.port,
				}
			}
		}
		seen = append(seen, vb{p.Name, p.Type, p.BindAddr, proto, p.BindPort})
	}
	return nil
}

// CombinedLogPath 返回所有 frpc 实例共用的合并日志文件的绝对路径。
func (m *Manager) CombinedLogPath() string {
	return filepath.Join(m.opts.LogsDir, CombinedLogFileName)
}

// MigratePaths 把所有 instance toml 里过期的 LogFile（v1.2.22 及之前的 per-id
// .log 路径）重写为当前期望的合并日志路径。这是 v1.2.23 → v1.2.24 的升级
// 迁移：v1.2.23 把读取侧改成了 combined log，但 LoadAll 不会重写已有 toml，
// 导致旧用户升级后 frpc 仍按 toml 里的旧 log.to 写到 per-id .log，UI 读
// combined log 永远是空。这里在 LoadAll 之后、AutoStart 之前调用一次以
// 解决这个升级路径。
//
// 仅当当前 LogFile 与期望值不同（且当前值看起来是个 .log 文件 — 避免误改
// 用户自定义的 console / 空字符串等设置）时才重写。Store.Path 同理刷新。
//
// 任何单个 instance 的迁移失败只记日志, 不阻塞 daemon 启动。
func (m *Manager) MigratePaths() {
	m.mu.RLock()
	instances := make([]*instance, 0, len(m.instances))
	for _, inst := range m.instances {
		instances = append(instances, inst)
	}
	m.mu.RUnlock()

	expectedLog := filepath.ToSlash(filepath.Join(m.opts.LogsDir, CombinedLogFileName))
	for _, inst := range instances {
		data := inst.Data()
		if data == nil {
			continue
		}
		// 仅当 LogFile 是个常规 .log 文件路径且与期望不一致时迁移。
		// 跳过 "console" / "" 等用户显式表达"不写文件"的情形。
		current := filepath.ToSlash(data.LogFile)
		if current == expectedLog {
			continue
		}
		if current == "" || current == "console" {
			continue
		}
		if !strings.HasSuffix(strings.ToLower(current), ".log") {
			continue
		}
		oldPath := data.LogFile
		if err := m.writeConfig(inst.path, data); err != nil {
			m.opts.Logger.Warn("migrate LogFile failed",
				slog.String("id", inst.id), slog.Any("err", err))
			continue
		}
		m.opts.Logger.Info("migrated LogFile to combined log",
			slog.String("id", inst.id),
			slog.String("from", oldPath),
			slog.String("to", expectedLog),
		)
	}
}

func (m *Manager) pathFor(id string) string {
	return filepath.Join(m.opts.ProfilesDir, id+".toml")
}

func (m *Manager) writeConfig(path string, data *config.ClientConfig) error {
	// data.Save writes either INI or TOML depending on data.LegacyFormat.
	// We force TOML for new files to keep the API surface predictable.
	data.LegacyFormat = false
	data.Complete(false)
	// frp expects log/store paths to be absolute or resolvable; we
	// rewrite them so they sit alongside profiles in /data.
	id := idFromPath(path)
	// 合并日志：所有 frpc 实例共写 frpc.log，依赖 daemon 注入的 xlog 前缀
	// [inst=<id>] 在读取侧按实例过滤。读取侧改造见 Task 7（internal/api/logs.go）。
	data.LogFile = filepath.ToSlash(filepath.Join(m.opts.LogsDir, CombinedLogFileName))
	if data.Store.IsEnabled() {
		data.Store.Path = filepath.ToSlash(filepath.Join(m.opts.StoresDir, id+".json"))
	}
	return data.Save(path)
}

func writeAtomic(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func validateID(id string) error {
	if id == "" {
		return errors.New("id must not be empty")
	}
	if strings.ContainsAny(id, `/\\:?*<>|"'`) {
		return errors.New("id contains illegal characters")
	}
	if strings.HasPrefix(id, ".") {
		return errors.New("id must not start with dot")
	}
	if len(id) > 64 {
		return errors.New("id too long")
	}
	return nil
}

// LogViewSince 返回指定 id 的"日志逻辑清空时间戳"（Unix 毫秒）。
// 用于 internal/api/logs.go 过滤合并日志时丢弃旧行。0 表示从未清空。
func (m *Manager) LogViewSince(id string) int64 {
	return m.meta.logViewSince(id)
}

// SetLogViewSince 记录用户"清空日志"操作。internal/api/logs.go 在 Clear
// 接口里调用本方法，并通过 eventbus 广播让前端立即刷新（如果需要）。
func (m *Manager) SetLogViewSince(id string, unixMilli int64) error {
	return m.meta.setLogViewSince(id, unixMilli)
}

// GetSystemConfig returns the raw stored system-config overrides (nil fields
// mean "use the env default"). The API layer merges these with appcfg.
func (m *Manager) GetSystemConfig() SystemConfig {
	return m.meta.systemConfig()
}

// SetSystemConfig persists the system-config overrides wholesale.
func (m *Manager) SetSystemConfig(c SystemConfig) error {
	return m.meta.setSystemConfig(c)
}

// UpdateSystemConfig atomically merges the overrides under the store lock via
// the apply callback, so a partial PUT (some fields set, some reset) can't race
// another concurrent update and lose fields. apply mutates a clone of the
// current overrides in place; nil fields mean "follow the env default".
func (m *Manager) UpdateSystemConfig(apply func(*SystemConfig)) error {
	return m.meta.updateSystemConfig(apply)
}

// ---- scheduled-backup config (satisfies backup.Store / Recorder) ----

// ListBackupChannels returns all configured storage channels (with secrets).
func (m *Manager) ListBackupChannels() []backup.Channel { return m.meta.listBackupChannels() }

// GetBackupChannel returns a channel by id.
func (m *Manager) GetBackupChannel(id string) (backup.Channel, bool) {
	return m.meta.getBackupChannel(id)
}

// UpsertBackupChannel inserts (empty id) or replaces a storage channel.
func (m *Manager) UpsertBackupChannel(ch backup.Channel) (backup.Channel, error) {
	return m.meta.upsertBackupChannel(ch)
}

// DeleteBackupChannel removes a storage channel by id.
func (m *Manager) DeleteBackupChannel(id string) error { return m.meta.deleteBackupChannel(id) }

// ListBackupSchedules returns all backup schedules.
func (m *Manager) ListBackupSchedules() []backup.Schedule { return m.meta.listBackupSchedules() }

// GetBackupSchedule returns a schedule by id.
func (m *Manager) GetBackupSchedule(id string) (backup.Schedule, bool) {
	return m.meta.getBackupSchedule(id)
}

// UpsertBackupSchedule inserts (empty id) or replaces a backup schedule.
func (m *Manager) UpsertBackupSchedule(sc backup.Schedule) (backup.Schedule, error) {
	return m.meta.upsertBackupSchedule(sc)
}

// DeleteBackupSchedule removes a schedule by id.
func (m *Manager) DeleteBackupSchedule(id string) error { return m.meta.deleteBackupSchedule(id) }

// UpdateBackupSchedule atomically mutates a schedule under the store lock.
func (m *Manager) UpdateBackupSchedule(id string, apply func(*backup.Schedule)) (backup.Schedule, error) {
	return m.meta.updateBackupSchedule(id, apply)
}

// UpdateBackupChannel atomically mutates a channel under the store lock.
func (m *Manager) UpdateBackupChannel(id string, apply func(*backup.Channel)) (backup.Channel, error) {
	return m.meta.updateBackupChannel(id, apply)
}

// AppendBackupRun records a completed backup run (capped history).
func (m *Manager) AppendBackupRun(r backup.RunRecord) error {
	return m.meta.appendBackupRun(r, backup.RunHistoryCap)
}

// ListBackupRuns returns the run history newest-first, capped at limit.
func (m *Manager) ListBackupRuns(limit int) []backup.RunRecord { return m.meta.listBackupRuns(limit) }

// BuildBackupZip writes a zip archive of every config file plus meta.json to w.
// It is the single source of truth for "what a backup contains", shared by the
// HTTP /export/all handler and the scheduled-backup engine.
func (m *Manager) BuildBackupZip(w io.Writer) error {
	zw := zip.NewWriter(w)
	matches, _ := filepath.Glob(filepath.Join(m.opts.ProfilesDir, "*.toml"))
	for _, ext := range []string{"*.conf", "*.ini"} {
		extra, _ := filepath.Glob(filepath.Join(m.opts.ProfilesDir, ext))
		matches = append(matches, extra...)
	}
	for _, p := range matches {
		raw, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		fw, err := zw.Create("profiles/" + filepath.Base(p))
		if err != nil {
			continue
		}
		if _, err := fw.Write(raw); err != nil {
			_ = zw.Close()
			return err
		}
	}
	// Bundle meta.json (branding / sort / system_config / backup config) so the
	// archive is self-contained. Storage-channel secrets are REDACTED first so
	// credentials never ride along into the (possibly shared) backup target or
	// an exported download. Best effort: a missing meta yields config-only.
	if metaRaw, err := os.ReadFile(m.opts.MetaPath); err == nil {
		out := redactBackupSecrets(metaRaw)
		if fw, err := zw.Create("meta.json"); err == nil {
			_, _ = fw.Write(out)
		}
	}
	return zw.Close()
}

// redactBackupSecrets parses a meta.json blob and blanks every backup channel's
// secret, returning the re-serialized bytes. On a parse error (not expected for
// our own file) it falls back to the original bytes rather than dropping the
// branding/order the archive also needs.
func redactBackupSecrets(raw []byte) []byte {
	var m Meta
	if err := json.Unmarshal(raw, &m); err != nil {
		return raw
	}
	if m.Backup != nil {
		for i := range m.Backup.Channels {
			m.Backup.Channels[i] = backup.RedactSecrets(m.Backup.Channels[i])
		}
	}
	out, err := json.MarshalIndent(&m, "", "  ")
	if err != nil {
		return raw
	}
	return out
}

// GetBranding returns the effective UI branding — stored overrides with the
// Default* constants filled in for any empty field, so callers always get a
// ready-to-render value.
func (m *Manager) GetBranding() Branding {
	return m.meta.branding().Effective()
}

// GetBrandingRaw returns the raw stored branding (no defaults applied). Used
// by the PUT handler to preserve fields the client omitted.
func (m *Manager) GetBrandingRaw() Branding {
	return m.meta.branding()
}

// SetBranding persists the UI branding. Values are trimmed and length-capped;
// an empty field is stored as empty and resolves to its default on read.
// Returns the effective branding after the write.
func (m *Manager) SetBranding(in Branding) (Branding, error) {
	in.AppName = truncateRunes(strings.TrimSpace(in.AppName), 40)
	in.AppSubtitle = truncateRunes(strings.TrimSpace(in.AppSubtitle), 60)
	in.HTMLTitle = truncateRunes(strings.TrimSpace(in.HTMLTitle), 120)
	if err := m.meta.setBranding(in); err != nil {
		return Branding{}, err
	}
	return in.Effective(), nil
}

// ImportMeta parses a meta.json blob (from an /export/all backup) and restores
// the operator branding and the instance display order from it. Call it AFTER
// the configs themselves are in place so Reorder can resolve the ids.
//
// It deliberately ignores log_view_since / auto_start (transient/legacy). Sort
// is restored because preserving the instance order across an export→import to
// another host is an explicit goal; Reorder keeps only ids that exist now, and
// any imported config not listed in the backup sort falls to the end. The
// system_config overrides (log level / self-update / docs / CORS) are restored
// too, so a backup carries the operator's full customization; self-update/docs/
// CORS take effect immediately (read live per-request) while a restored log
// level applies on the next restart (re-armed by NewRuntimeConfig).
//
// Returns whether a non-empty branding, order, system_config, and backup config
// were applied.
func (m *Manager) ImportMeta(raw []byte) (brandingRestored, orderRestored, systemConfigRestored, backupRestored bool, err error) {
	var meta Meta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return false, false, false, false, err
	}
	// Branding and order are restored independently: a failure on one is
	// recorded but never blocks the other (first error is returned).
	if meta.Branding != nil {
		b := *meta.Branding
		if strings.TrimSpace(b.AppName) != "" ||
			strings.TrimSpace(b.AppSubtitle) != "" ||
			strings.TrimSpace(b.HTMLTitle) != "" {
			if _, e := m.SetBranding(b); e != nil {
				err = e
			} else {
				brandingRestored = true
			}
		}
	}
	if len(meta.Sort) > 0 {
		if e := m.Reorder(meta.Sort); e != nil {
			if err == nil {
				err = e
			}
		} else {
			orderRestored = true
		}
	}
	// Restore runtime overrides only when at least one field is actually set;
	// an all-nil SystemConfig carries no customization worth reporting. The
	// values came from this app's validated PUT, and the read-side getters still
	// normalize (e.g. empty CORS → follow env), so we trust them as-is.
	if sc := meta.SystemConfig; sc != nil &&
		(sc.LogLevel != nil || sc.SelfUpdateEnabled != nil || sc.DocsEnabled != nil || sc.CORSOrigins != nil) {
		if e := m.SetSystemConfig(*sc); e != nil {
			if err == nil {
				err = e
			}
		} else {
			systemConfigRestored = true
		}
	}
	// Restore backup channels + schedules (runs are host-local, not restored).
	if bd := meta.Backup; bd != nil && (len(bd.Channels) > 0 || len(bd.Schedules) > 0) {
		if e := m.meta.restoreBackupConfig(bd.Channels, bd.Schedules); e != nil {
			if err == nil {
				err = e
			}
		} else {
			backupRestored = true
		}
	}
	return brandingRestored, orderRestored, systemConfigRestored, backupRestored, err
}

// truncateRunes caps s to at most max runes (not bytes), so multi-byte CJK
// brand names are not cut mid-character.
func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) > max {
		return string(r[:max])
	}
	return s
}

// Sentinel errors. Map these to HTTP statuses in the API layer.
var (
	ErrNotFound = errors.New("not found")
	ErrExists   = errors.New("already exists")
)
