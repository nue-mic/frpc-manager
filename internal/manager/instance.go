package manager

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"runtime/debug"
	"sync"
	"time"

	"github.com/fatedier/frp/client/proxy"

	"github.com/mia-clark/frp-manager-server/internal/conntrack"
	"github.com/mia-clark/frp-manager-server/internal/eventbus"
	"github.com/mia-clark/frp-manager-server/pkg/config"
	"github.com/mia-clark/frp-manager-server/pkg/consts"
	"github.com/mia-clark/frp-manager-server/pkg/util"
	"github.com/mia-clark/frp-manager-server/services"
)

// instance owns a single frpc client lifecycle. The Manager holds these
// inside a map keyed by config id.
type instance struct {
	id   string
	path string

	mu      sync.RWMutex
	data    *config.ClientConfig
	state   consts.ConfigState
	lastErr string
	startAt time.Time
	stopAt  time.Time

	// run-time fields (zero unless running)
	svc      *services.FrpClientService
	cancel   context.CancelFunc
	runWG    sync.WaitGroup
	autoDel  *time.Timer

	// proxy status cache, refreshed by statusPoller
	psMu       sync.RWMutex
	proxyStats map[string]*proxy.WorkingStatus
	// per-proxy current established connection counts, keyed by alias.
	// Populated by statusPoller via /proc/net/tcp on Linux.
	connsByName map[string]int

	logger *slog.Logger
	bus    *eventbus.Bus
}

// instanceCtx 在 parent ctx 上叠加 xlog 前缀 [inst=<id>]。Run 时调用，
// 让 frp 内部 xl.* 调用自动带上前缀，便于合并日志按实例过滤。
func (i *instance) instanceCtx(parent context.Context) context.Context {
	return services.NewInstanceContext(parent, i.id)
}

func newInstance(id, path string, data *config.ClientConfig, logger *slog.Logger, bus *eventbus.Bus) *instance {
	return &instance{
		id:          id,
		path:        path,
		data:        data,
		state:       consts.ConfigStateStopped,
		proxyStats:  make(map[string]*proxy.WorkingStatus),
		connsByName: make(map[string]int),
		logger:      logger.With(slog.String("config_id", id)),
		bus:         bus,
	}
}

// ID returns the immutable config id (file stem).
func (i *instance) ID() string { return i.id }

// Path returns the absolute path of the underlying .toml file.
func (i *instance) Path() string { return i.path }

// Data returns a snapshot of the parsed config. The returned pointer is
// owned by the instance and must not be mutated by callers.
func (i *instance) Data() *config.ClientConfig {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.data
}

// Snapshot describes the run-time status of one instance.
type Snapshot struct {
	ID        string             `json:"id"`
	Name      string             `json:"name"`
	Path      string             `json:"path"`
	State     string             `json:"state"`
	LastError string             `json:"last_error,omitempty"`
	StartedAt *time.Time         `json:"started_at,omitempty"`
	StoppedAt *time.Time         `json:"stopped_at,omitempty"`
	Proxies   []ProxySnapshot    `json:"proxies,omitempty"`
}

// ProxySnapshot is the per-proxy run-time status used in API responses.
//
// Note on traffic: frp v0.68's client library does not track per-proxy
// byte counters (those live on the frps side). We expose `CurConns`
// which is counted by reading /proc/net/tcp and matching against the
// proxy's LocalPort. For byte-level traffic, query the frps dashboard
// API on the server side instead.
type ProxySnapshot struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Status     string `json:"status"`
	RemoteAddr string `json:"remote_addr,omitempty"`
	Error      string `json:"error,omitempty"`
	LocalIP    string `json:"local_ip,omitempty"`
	LocalPort  string `json:"local_port,omitempty"`
	CurConns   int    `json:"cur_conns"`
	Disabled   bool   `json:"disabled"`
}

// Snapshot returns a JSON-friendly status view, optionally including
// per-proxy status.
func (i *instance) Snapshot(includeProxies bool) Snapshot {
	i.mu.RLock()
	s := Snapshot{
		ID:        i.id,
		Path:      i.path,
		State:     stateString(i.state),
		LastError: i.lastErr,
	}
	if i.data != nil {
		s.Name = i.data.Name()
		if s.Name == "" {
			s.Name = i.id
		}
	}
	if !i.startAt.IsZero() {
		t := i.startAt
		s.StartedAt = &t
	}
	if !i.stopAt.IsZero() {
		t := i.stopAt
		s.StoppedAt = &t
	}
	i.mu.RUnlock()

	if includeProxies {
		s.Proxies = i.proxySnapshots()
	}
	return s
}

func (i *instance) proxySnapshots() []ProxySnapshot {
	data := i.Data()
	if data == nil {
		return nil
	}
	i.psMu.RLock()
	defer i.psMu.RUnlock()
	out := make([]ProxySnapshot, 0, len(data.Proxies))
	for _, p := range data.Proxies {
		for _, alias := range p.GetAlias() {
			ps := ProxySnapshot{
				Name:      alias,
				Type:      p.Type,
				LocalIP:   p.LocalIP,
				LocalPort: p.LocalPort,
				Disabled:  p.Disabled,
			}
			if st, ok := i.proxyStats[alias]; ok && st != nil {
				ps.Status = st.Phase
				ps.RemoteAddr = st.RemoteAddr
				ps.Error = st.Err
			}
			ps.CurConns = i.connsByName[alias]
			out = append(out, ps)
		}
	}
	return out
}

// State returns the current lifecycle state.
func (i *instance) State() consts.ConfigState {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.state
}

// setState assigns a new state under lock and returns whether it changed.
func (i *instance) setState(s consts.ConfigState) bool {
	i.mu.Lock()
	prev := i.state
	if i.state == s {
		i.mu.Unlock()
		return false
	}
	i.state = s
	switch s {
	case consts.ConfigStateStarted:
		i.startAt = time.Now()
	case consts.ConfigStateStopped:
		i.stopAt = time.Now()
	}
	i.mu.Unlock()
	if i.bus != nil {
		i.bus.Publish(eventbus.TypeInstanceState, i.id, eventbus.InstanceStateData{
			State:     stateString(s),
			PrevState: stateString(prev),
		})
	}
	return true
}

// replaceData swaps the parsed config without touching run-time state.
func (i *instance) replaceData(d *config.ClientConfig) {
	i.mu.Lock()
	i.data = d
	i.mu.Unlock()
}

// start launches the frpc service in a background goroutine. It is a no-op
// if the instance is already running.
func (i *instance) start(ctx context.Context) error {
	i.mu.Lock()
	if i.state == consts.ConfigStateStarted || i.state == consts.ConfigStateStarting {
		i.mu.Unlock()
		return errors.New("already running")
	}
	i.state = consts.ConfigStateStarting
	i.lastErr = ""
	i.mu.Unlock()

	svc, err := services.NewFrpClientService(i.path)
	if err != nil {
		i.recordError(err)
		i.setState(consts.ConfigStateStopped)
		return fmt.Errorf("init frp service: %w", err)
	}

	runCtx, cancel := context.WithCancel(ctx)
	i.mu.Lock()
	i.svc = svc
	i.cancel = cancel
	i.mu.Unlock()

	i.runWG.Add(2)
	go i.runLoop(runCtx, svc)
	go i.statusPoller(runCtx, svc)

	i.setState(consts.ConfigStateStarted)
	i.logger.Info("instance started")
	return nil
}

// stop signals the run loop to terminate and waits for goroutines to
// drain.
func (i *instance) stop() error {
	i.mu.Lock()
	if i.state == consts.ConfigStateStopped || i.state == consts.ConfigStateStopping {
		i.mu.Unlock()
		return nil
	}
	i.state = consts.ConfigStateStopping
	cancel := i.cancel
	svc := i.svc
	i.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if svc != nil {
		svc.Stop(false)
	}
	i.runWG.Wait()

	i.mu.Lock()
	i.svc = nil
	i.cancel = nil
	i.mu.Unlock()

	i.clearProxyStats()
	i.setState(consts.ConfigStateStopped)
	i.logger.Info("instance stopped")
	return nil
}

// reload triggers a hot-reload of the underlying frp service. Caller must
// have already updated the on-disk file.
func (i *instance) reload() error {
	i.mu.RLock()
	svc := i.svc
	state := i.state
	i.mu.RUnlock()
	if state != consts.ConfigStateStarted || svc == nil {
		return errors.New("not running")
	}
	if err := svc.Reload(); err != nil {
		i.recordError(err)
		return err
	}
	// reparse the file so external API views match the new state
	if d, err := config.UnmarshalClientConf(i.path); err == nil {
		i.replaceData(d)
	}
	return nil
}

func (i *instance) recordError(err error) {
	if err == nil {
		return
	}
	i.mu.Lock()
	i.lastErr = err.Error()
	i.mu.Unlock()
	i.logger.Warn("instance error", slog.Any("err", err))
	if i.bus != nil {
		i.bus.Publish(eventbus.TypeInstanceError, i.id, eventbus.InstanceErrorData{Message: err.Error()})
	}
}

// runLoop runs the frp client in the same goroutine that owns the svc.
// A panic is recovered, logged, and the instance transitions to stopped.
func (i *instance) runLoop(ctx context.Context, svc *services.FrpClientService) {
	defer i.runWG.Done()
	defer func() {
		if rec := recover(); rec != nil {
			i.logger.Error("frp client panicked",
				slog.Any("panic", rec),
				slog.String("stack", string(debug.Stack())),
			)
			i.recordError(fmt.Errorf("panic: %v", rec))
		}
	}()
	doneCh := make(chan struct{})
	go func() {
		// 注入 [inst=<id>] xlog 前缀，让 frp 内部输出在合并日志中可按实例分流。
		svc.Run(i.instanceCtx(ctx))
		close(doneCh)
	}()
	select {
	case <-ctx.Done():
		// caller asked us to stop (Stop / Shutdown). best-effort close.
		svc.Stop(false)
	case <-doneCh:
		// frpc terminated on its own (login fail, ctx-internal exit).
		// Surface this through state so reload / UI badges stay honest,
		// and proxy stats are cleared.
		svc.Stop(false)
		i.mu.Lock()
		// 必须 cancel ctx：否则 statusPoller 这个 goroutine 永远不退出，
		// runWG 永远归不了零，后续 stop()/Shutdown 的 runWG.Wait() 会永久阻塞，
		// 进而状态卡在「停止中」、stop 接口挂起、前端不刷新。
		if i.cancel != nil {
			i.cancel()
		}
		i.svc = nil
		i.cancel = nil
		i.mu.Unlock()
		i.clearProxyStats()
		i.setState(consts.ConfigStateStopped)
		i.logger.Info("instance exited on its own")
	}
}

func (i *instance) statusPoller(ctx context.Context, svc *services.FrpClientService) {
	defer i.runWG.Done()
	statusT := time.NewTicker(500 * time.Millisecond)
	defer statusT.Stop()
	connsT := time.NewTicker(2 * time.Second)
	defer connsT.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-statusT.C:
			i.refreshProxyStats(svc)
		case <-connsT.C:
			i.refreshConnCounts()
		}
	}
}

// refreshConnCounts walks the configured proxies, builds a set of local
// ports to look up, queries /proc/net/tcp via the conntrack package, and
// fans out diffs through the event bus.
func (i *instance) refreshConnCounts() {
	data := i.Data()
	if data == nil {
		return
	}
	type entry struct {
		alias string
		ports []uint16
		typ   string
	}
	entries := make([]entry, 0, len(data.Proxies))
	allPorts := make([]uint16, 0)
	for _, p := range data.Proxies {
		ports := parseLocalPorts(p.LocalPort)
		if len(ports) == 0 {
			continue
		}
		for _, alias := range p.GetAlias() {
			entries = append(entries, entry{alias: alias, ports: ports, typ: p.Type})
		}
		allPorts = append(allPorts, ports...)
	}
	if len(allPorts) == 0 {
		return
	}
	counts, err := conntrack.Get(allPorts)
	if err != nil {
		i.logger.Debug("conntrack failed", slog.Any("err", err))
		return
	}

	next := make(map[string]int, len(entries))
	for _, e := range entries {
		total := 0
		for _, p := range e.ports {
			total += counts[p]
		}
		next[e.alias] = total
	}

	i.psMu.Lock()
	prev := i.connsByName
	i.connsByName = next
	i.psMu.Unlock()

	if i.bus == nil {
		return
	}
	for _, e := range entries {
		if prev[e.alias] == next[e.alias] {
			continue
		}
		i.bus.Publish(eventbus.TypeProxyConnections, i.id, eventbus.ProxyConnectionsData{
			Name:     e.alias,
			Type:     e.typ,
			CurConns: next[e.alias],
		})
	}
}

// parseLocalPorts converts a "22" or "8000-8010,9000" style frp port
// spec into a flat slice of uint16 ports. Anything that fails to parse
// is silently skipped.
func parseLocalPorts(spec string) []uint16 {
	if spec == "" {
		return nil
	}
	out := []uint16{}
	for _, segment := range splitOn(spec, ',') {
		segment = trimSpace(segment)
		if segment == "" {
			continue
		}
		if dash := indexOf(segment, '-'); dash >= 0 {
			lo, ok1 := atoiU16(segment[:dash])
			hi, ok2 := atoiU16(segment[dash+1:])
			if !ok1 || !ok2 || hi < lo {
				continue
			}
			for p := lo; p <= hi; p++ {
				out = append(out, p)
				if p == 65535 {
					break
				}
			}
			continue
		}
		if v, ok := atoiU16(segment); ok {
			out = append(out, v)
		}
	}
	return out
}

func splitOn(s string, sep byte) []string {
	out := []string{}
	cur := ""
	for i := 0; i < len(s); i++ {
		if s[i] == sep {
			out = append(out, cur)
			cur = ""
			continue
		}
		cur += string(s[i])
	}
	out = append(out, cur)
	return out
}

func trimSpace(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}

func indexOf(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}

func atoiU16(s string) (uint16, bool) {
	if s == "" {
		return 0, false
	}
	var n uint32
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
		n = n*10 + uint32(s[i]-'0')
		if n > 65535 {
			return 0, false
		}
	}
	return uint16(n), true
}

func (i *instance) refreshProxyStats(svc *services.FrpClientService) {
	data := i.Data()
	if data == nil {
		return
	}
	next := make(map[string]*proxy.WorkingStatus, len(data.Proxies))
	typeByName := make(map[string]string, len(data.Proxies))
	for _, p := range data.Proxies {
		for _, alias := range p.GetAlias() {
			if st, ok := svc.GetProxyStatus(alias); ok {
				next[alias] = st
				typeByName[alias] = p.Type
			}
		}
	}
	i.psMu.Lock()
	prev := i.proxyStats
	i.proxyStats = next
	i.psMu.Unlock()

	if i.bus == nil {
		return
	}
	for name, st := range next {
		old := prev[name]
		if !proxyStatusChanged(old, st) {
			continue
		}
		i.bus.Publish(eventbus.TypeProxyStatus, i.id, eventbus.ProxyStatusData{
			Name:       name,
			Type:       typeByName[name],
			Status:     st.Phase,
			RemoteAddr: st.RemoteAddr,
			Error:      st.Err,
		})
	}
}

func proxyStatusChanged(a, b *proxy.WorkingStatus) bool {
	if a == nil || b == nil {
		return a != b
	}
	return a.Phase != b.Phase || a.Err != b.Err || a.RemoteAddr != b.RemoteAddr
}

func (i *instance) clearProxyStats() {
	i.psMu.Lock()
	i.proxyStats = make(map[string]*proxy.WorkingStatus)
	i.psMu.Unlock()
}

// scheduleAutoDelete arms a one-shot timer that deletes the config file
// when it expires. fn is invoked from the timer goroutine; the Manager
// passes a closure that performs the actual delete + meta update.
func (i *instance) scheduleAutoDelete(d time.Duration, fn func()) {
	i.cancelAutoDelete()
	if d <= 0 {
		return
	}
	i.mu.Lock()
	i.autoDel = time.AfterFunc(d, fn)
	i.mu.Unlock()
}

func (i *instance) cancelAutoDelete() {
	i.mu.Lock()
	t := i.autoDel
	i.autoDel = nil
	i.mu.Unlock()
	if t != nil {
		t.Stop()
	}
}

// idFromPath derives a config id from a file path. The id is the file
// name without its extension.
func idFromPath(path string) string {
	return util.FileNameWithoutExt(filepath.Base(path))
}

func stateString(s consts.ConfigState) string {
	switch s {
	case consts.ConfigStateStarted:
		return "started"
	case consts.ConfigStateStopped:
		return "stopped"
	case consts.ConfigStateStarting:
		return "starting"
	case consts.ConfigStateStopping:
		return "stopping"
	default:
		return "unknown"
	}
}
