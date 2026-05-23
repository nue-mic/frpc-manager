package manager

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/mia-clark/frp-manager-server/internal/eventbus"
	"github.com/mia-clark/frp-manager-server/pkg/config"
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
// running it is left running; callers can issue a separate /reload to
// apply changes.
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
	data.LogFile = filepath.ToSlash(filepath.Join(m.opts.LogsDir, id+".log"))
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

// Sentinel errors. Map these to HTTP statuses in the API layer.
var (
	ErrNotFound = errors.New("not found")
	ErrExists   = errors.New("already exists")
)
