package api

import (
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"

	"github.com/mia-clark/frpc-manager/internal/manager"
	"github.com/mia-clark/frpc-manager/pkg/config"
)

// checkVisitorConflict guards visitor create/update against a cross-instance
// local-port collision: another instance's visitor of the same protocol family
// (STCP/XTCP=TCP, SUDP=UDP) already listening on the same bindAddr:bindPort.
// excludeName is the visitor being edited (skipped on its own instance) or ""
// on create. Returns true (and writes a 409) when a conflict was found.
func (h *ProxiesHandler) checkVisitorConflict(w http.ResponseWriter, id, excludeName string, v *config.TypedVisitorConfig) bool {
	if v == nil || v.VisitorConfigurer == nil {
		return false
	}
	base := v.GetBaseConfig()
	c := h.m.VisitorBindConflict(id, excludeName, base.Type, base.BindAddr, base.BindPort)
	if c == nil {
		return false
	}
	WriteError(w, http.StatusConflict, CodeVisitorPortConflict,
		fmt.Sprintf("本地端口 %s:%d 已被实例「%s」的访客「%s」(%s) 占用，无法保存；同协议族(TCP/UDP)的访客不能复用同一本地端口",
			c.BindAddr, c.BindPort, c.ConfigName, c.Name, strings.ToUpper(c.Type)),
		map[string]any{
			"config_id": c.ConfigID, "config_name": c.ConfigName,
			"name": c.Name, "type": c.Type, "bind_addr": c.BindAddr, "bind_port": c.BindPort,
		})
	return true
}

// withProxies returns a copy of src with its proxy list replaced. Every other
// field (ClientCommon, LogFile, ManualStart, …) is preserved.
//
// Each *Proxy is cloned so the result is fully decoupled from the live pointers
// Get() handed back: manager.Update -> writeConfig calls ClientConfig.Complete,
// which mutates each proxy in place (*p = pruned). Reusing the instance's live
// objects would let a write-failure path leave the in-memory state altered
// without a reload. Cloning mirrors how Create/Update go through fresh fromV1
// objects, keeping these batch endpoints just as safe.
func withProxies(src *config.ClientConfig, proxies []*config.Proxy) *config.ClientConfig {
	cp := *src
	cloned := make([]*config.Proxy, len(proxies))
	for i, p := range proxies {
		np := *p
		cloned[i] = &np
	}
	cp.Proxies = cloned
	return &cp
}

// proxyMatches reports whether p is targeted by name (its primary Name or, for
// range proxies, any expanded alias) according to the want set.
func proxyMatches(p *config.Proxy, want map[string]struct{}) bool {
	if _, ok := want[p.Name]; ok {
		return true
	}
	for _, a := range p.GetAlias() {
		if _, ok := want[a]; ok {
			return true
		}
	}
	return false
}

func proxyName(p config.TypedProxyConfig) string {
	if p.ProxyConfigurer == nil {
		return ""
	}
	return p.GetBaseConfig().Name
}

func visitorName(v config.TypedVisitorConfig) string {
	if v.VisitorConfigurer == nil {
		return ""
	}
	return v.GetBaseConfig().Name
}

// ProxiesHandler serves /api/v1/configs/{id}/proxies/*.
type ProxiesHandler struct {
	m   *manager.Manager
	log *slog.Logger
}

// NewProxiesHandler creates a ProxiesHandler.
func NewProxiesHandler(m *manager.Manager, log *slog.Logger) *ProxiesHandler {
	return &ProxiesHandler{m: m, log: log}
}

// List returns each proxy plus its current runtime status.
func (h *ProxiesHandler) List(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	snap, _, err := h.m.Get(id, true)
	if writeManagerError(w, err) {
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"items": snap.Proxies})
}

// Get fetches a single proxy definition by name.
func (h *ProxiesHandler) Get(w http.ResponseWriter, r *http.Request) {
	id, name := pathID(r), pathName(r)
	_, data, err := h.m.Get(id, false)
	if writeManagerError(w, err) {
		return
	}
	v := toV1(data)
	// search in both proxies and visitors
	for _, p := range v.Proxies {
		if proxyName(p) == name {
			WriteJSON(w, http.StatusOK, p)
			return
		}
	}
	for _, vv := range v.Visitors {
		if visitorName(vv) == name {
			WriteJSON(w, http.StatusOK, vv)
			return
		}
	}
	WriteError(w, http.StatusNotFound, CodeProxyNotFound, "proxy not found", nil)
}

// proxyReq holds the wire payload for create/update.
type proxyReq struct {
	Proxy   *config.TypedProxyConfig   `json:"proxy,omitempty"`
	Visitor *config.TypedVisitorConfig `json:"visitor,omitempty"`
}

// Create adds a new proxy (or visitor) to the config.
func (h *ProxiesHandler) Create(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	var req proxyReq
	if !decodeJSON(w, r, &req) {
		return
	}
	if (req.Proxy == nil) == (req.Visitor == nil) {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "exactly one of proxy/visitor required", nil)
		return
	}
	_, data, err := h.m.Get(id, false)
	if writeManagerError(w, err) {
		return
	}
	v := toV1(data)
	if req.Proxy != nil {
		for _, p := range v.Proxies {
			if proxyName(p) == proxyName(*req.Proxy) {
				WriteError(w, http.StatusConflict, CodeProxyExists, "proxy already exists", nil)
				return
			}
		}
		v.Proxies = append(v.Proxies, *req.Proxy)
	} else {
		for _, vv := range v.Visitors {
			if visitorName(vv) == visitorName(*req.Visitor) {
				WriteError(w, http.StatusConflict, CodeProxyExists, "visitor already exists", nil)
				return
			}
		}
		if h.checkVisitorConflict(w, id, "", req.Visitor) {
			return
		}
		v.Visitors = append(v.Visitors, *req.Visitor)
	}
	if err := h.m.Update(id, fromV1(v)); writeManagerError(w, err) {
		return
	}
	w.WriteHeader(http.StatusCreated)
}

// Update replaces a proxy/visitor in place.
func (h *ProxiesHandler) Update(w http.ResponseWriter, r *http.Request) {
	id, name := pathID(r), pathName(r)
	var req proxyReq
	if !decodeJSON(w, r, &req) {
		return
	}
	_, data, err := h.m.Get(id, false)
	if writeManagerError(w, err) {
		return
	}
	v := toV1(data)
	replaced := false
	if req.Proxy != nil {
		for i, p := range v.Proxies {
			if proxyName(p) == name {
				v.Proxies[i] = *req.Proxy
				replaced = true
				break
			}
		}
	}
	if !replaced && req.Visitor != nil {
		if h.checkVisitorConflict(w, id, name, req.Visitor) {
			return
		}
		for i, vv := range v.Visitors {
			if visitorName(vv) == name {
				v.Visitors[i] = *req.Visitor
				replaced = true
				break
			}
		}
	}
	if !replaced {
		WriteError(w, http.StatusNotFound, CodeProxyNotFound, "proxy not found", nil)
		return
	}
	if err := h.m.Update(id, fromV1(v)); writeManagerError(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Delete removes a proxy or visitor by name.
func (h *ProxiesHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id, name := pathID(r), pathName(r)
	_, data, err := h.m.Get(id, false)
	if writeManagerError(w, err) {
		return
	}
	v := toV1(data)
	removed := false
	out := v.Proxies[:0]
	for _, p := range v.Proxies {
		if proxyName(p) == name {
			removed = true
			continue
		}
		out = append(out, p)
	}
	v.Proxies = out
	outV := v.Visitors[:0]
	for _, vv := range v.Visitors {
		if visitorName(vv) == name {
			removed = true
			continue
		}
		outV = append(outV, vv)
	}
	v.Visitors = outV
	if !removed {
		WriteError(w, http.StatusNotFound, CodeProxyNotFound, "proxy not found", nil)
		return
	}
	if err := h.m.Update(id, fromV1(v)); writeManagerError(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Toggle flips the Disabled flag on a proxy. The body may omit "enabled"
// to invert the current state.
func (h *ProxiesHandler) Toggle(w http.ResponseWriter, r *http.Request) {
	id, name := pathID(r), pathName(r)
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if r.ContentLength > 0 {
		if !decodeJSON(w, r, &body) {
			return
		}
	}
	_, data, err := h.m.Get(id, false)
	if writeManagerError(w, err) {
		return
	}
	for _, p := range data.Proxies {
		if p.Name != name {
			continue
		}
		switch {
		case body.Enabled != nil:
			p.Disabled = !*body.Enabled
		default:
			p.Disabled = !p.Disabled
		}
		if err := h.m.Update(id, data); writeManagerError(w, err) {
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	WriteError(w, http.StatusNotFound, CodeProxyNotFound, "proxy not found", nil)
}

// Reorder persists the user's chosen display order for proxies/visitors.
// The body carries the full ordered list of names; the in-memory combined
// proxy slice is re-sorted to match (one Update -> one hot-reload). Names not
// present in the list keep their current relative order at the end, so a
// stale/partial order never drops a proxy.
func (h *ProxiesHandler) Reorder(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	var body struct {
		Order []string `json:"order"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	_, data, err := h.m.Get(id, false)
	if writeManagerError(w, err) {
		return
	}
	rank := make(map[string]int, len(body.Order))
	for i, n := range body.Order {
		if _, ok := rank[n]; !ok {
			rank[n] = i
		}
	}
	rankOf := func(p *config.Proxy) int {
		if v, ok := rank[p.Name]; ok {
			return v
		}
		for _, a := range p.GetAlias() {
			if v, ok := rank[a]; ok {
				return v
			}
		}
		return len(body.Order) + 1 // unranked -> after everything, original order kept
	}
	next := make([]*config.Proxy, len(data.Proxies))
	copy(next, data.Proxies)
	sort.SliceStable(next, func(a, b int) bool {
		return rankOf(next[a]) < rankOf(next[b])
	})
	if err := h.m.Update(id, withProxies(data, next)); writeManagerError(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// BatchDelete removes every named proxy/visitor in one shot (one Update ->
// one hot-reload, instead of N deletes each triggering a reload).
func (h *ProxiesHandler) BatchDelete(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	var body struct {
		Names []string `json:"names"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if len(body.Names) == 0 {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "names is required", nil)
		return
	}
	_, data, err := h.m.Get(id, false)
	if writeManagerError(w, err) {
		return
	}
	want := make(map[string]struct{}, len(body.Names))
	for _, n := range body.Names {
		want[n] = struct{}{}
	}
	next := make([]*config.Proxy, 0, len(data.Proxies))
	removed := 0
	for _, p := range data.Proxies {
		if proxyMatches(p, want) {
			removed++
			continue
		}
		next = append(next, p)
	}
	if removed == 0 {
		WriteError(w, http.StatusNotFound, CodeProxyNotFound, "no matching proxies", nil)
		return
	}
	if err := h.m.Update(id, withProxies(data, next)); writeManagerError(w, err) {
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"deleted": removed})
}

// moveReq is the wire payload for POST /proxies/move.
type moveReq struct {
	TargetID string   `json:"target_id"`
	Names    []string `json:"names"`
}

// Move relocates the named proxies/visitors from this config to target_id.
// The destination is updated first (adding) and the source second (removing),
// so a failure mid-way can only leave duplicates — never lose a proxy.
func (h *ProxiesHandler) Move(w http.ResponseWriter, r *http.Request) {
	srcID := pathID(r)
	var req moveReq
	if !decodeJSON(w, r, &req) {
		return
	}
	switch {
	case req.TargetID == "":
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "target_id is required", nil)
		return
	case len(req.Names) == 0:
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "names is required", nil)
		return
	case req.TargetID == srcID:
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "target_id must differ from source", nil)
		return
	}
	_, srcData, err := h.m.Get(srcID, false)
	if writeManagerError(w, err) {
		return
	}
	_, dstData, err := h.m.Get(req.TargetID, false)
	if writeManagerError(w, err) {
		return
	}
	want := make(map[string]struct{}, len(req.Names))
	for _, n := range req.Names {
		want[n] = struct{}{}
	}
	var moved []*config.Proxy
	remain := make([]*config.Proxy, 0, len(srcData.Proxies))
	for _, p := range srcData.Proxies {
		if proxyMatches(p, want) {
			moved = append(moved, p)
		} else {
			remain = append(remain, p)
		}
	}
	if len(moved) == 0 {
		WriteError(w, http.StatusNotFound, CodeProxyNotFound, "no matching proxies in source", nil)
		return
	}
	// reject if any moved name already exists in the destination
	existing := make(map[string]struct{}, len(dstData.Proxies))
	for _, p := range dstData.Proxies {
		existing[p.Name] = struct{}{}
	}
	var conflicts []string
	for _, p := range moved {
		if _, ok := existing[p.Name]; ok {
			conflicts = append(conflicts, p.Name)
		}
	}
	if len(conflicts) > 0 {
		WriteError(w, http.StatusConflict, CodeProxyExists, "name already exists in target config",
			map[string]any{"names": conflicts})
		return
	}
	// withProxies clones every *Proxy, so the two configs never share pointers
	// even though we hand the same `moved` objects to the destination here.
	dstNext := make([]*config.Proxy, 0, len(dstData.Proxies)+len(moved))
	dstNext = append(dstNext, dstData.Proxies...)
	dstNext = append(dstNext, moved...)

	if err := h.m.Update(req.TargetID, withProxies(dstData, dstNext)); writeManagerError(w, err) {
		return
	}
	if err := h.m.Update(srcID, withProxies(srcData, remain)); err != nil {
		// destination already holds the proxies; surface the half-done state
		// rather than silently dropping them from the source.
		WriteError(w, http.StatusInternalServerError, CodeInternal,
			"moved to target but failed to remove from source: "+err.Error(),
			map[string]any{"target_id": req.TargetID, "moved": len(moved)})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"moved": len(moved)})
}
