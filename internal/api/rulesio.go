package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/mia-clark/frpc-manager/internal/manager"
	"github.com/mia-clark/frpc-manager/pkg/config"
	"github.com/mia-clark/frpc-manager/pkg/version"
)

// RulesIOHandler serves rule-level export/parse/import under
// /api/v1/configs/{id}/proxies/{export,parse,import}.
type RulesIOHandler struct {
	m   *manager.Manager
	log *slog.Logger
}

func NewRulesIOHandler(m *manager.Manager, log *slog.Logger) *RulesIOHandler {
	return &RulesIOHandler{m: m, log: log}
}

// splitRules partitions a config's combined proxy slice into (proxies, visitors)
// optionally filtered to names (matching primary name or range alias). kind is
// "all"|"proxy"|"visitor". A nil/empty names selects everything of that kind.
func splitRules(data *config.ClientConfig, kind string, names []string) (proxies, visitors []*config.Proxy) {
	var want map[string]struct{}
	if len(names) > 0 {
		want = make(map[string]struct{}, len(names))
		for _, n := range names {
			want[n] = struct{}{}
		}
	}
	matches := func(p *config.Proxy) bool {
		if want == nil {
			return true
		}
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
	for _, p := range data.Proxies {
		if !matches(p) {
			continue
		}
		if p.IsVisitor() {
			if kind == "all" || kind == "visitor" {
				visitors = append(visitors, p)
			}
		} else {
			if kind == "all" || kind == "proxy" {
				proxies = append(proxies, p)
			}
		}
	}
	return
}

type rulesExportReq struct {
	Format string   `json:"format"` // toml | portable
	Kind   string   `json:"kind"`   // all | proxy | visitor
	Names  []string `json:"names"`
}

// Export renders selected rules as split TOML or a portable envelope.
func (h *RulesIOHandler) Export(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	var req rulesExportReq
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Kind == "" {
		req.Kind = "all"
	}
	snap, data, err := h.m.Get(id, false)
	if writeManagerError(w, err) {
		return
	}
	proxies, visitors := splitRules(data, req.Kind, req.Names)
	counts := map[string]int{"proxies": len(proxies), "visitors": len(visitors)}

	switch req.Format {
	case "portable":
		env, err := config.BuildPortableEnvelope(proxies, visitors, config.PortableSource{
			ConfigID: id, ConfigName: snap.Name, User: data.User,
			Daemon: version.Number, Frp: version.FRPVersion,
		})
		if err != nil {
			h.log.Warn("rules export: build portable envelope failed", "config_id", id, "error", err)
			WriteError(w, http.StatusInternalServerError, CodeInternal, "build envelope: "+err.Error(), nil)
			return
		}
		b, _ := json.MarshalIndent(env, "", "  ")
		WriteJSON(w, http.StatusOK, map[string]any{
			"format": "portable", "kind": req.Kind, "counts": counts,
			"portableJson": string(b),
			"filename":     filenameFor(snap.Name) + "-rules.json",
		})
	default: // toml
		pt, vt, err := config.RenderRulesTOML(proxies, visitors)
		if err != nil {
			h.log.Warn("rules export: render toml failed", "config_id", id, "error", err)
			WriteError(w, http.StatusInternalServerError, CodeInternal, "render toml: "+err.Error(), nil)
			return
		}
		WriteJSON(w, http.StatusOK, map[string]any{
			"format": "toml", "kind": req.Kind, "counts": counts,
			"proxiesToml": pt, "visitorsToml": vt,
			"filename": filenameFor(snap.Name) + "-rules.toml",
		})
	}
}

type rulesParseReq struct {
	Content string `json:"content"`
	Format  string `json:"format"` // accepted but ignored; always auto-detect
}

// Parse dry-runs a paste: detects format, lists items, derives pair visitors
// for stcp/xtcp/sudp proxies, and flags name conflicts against this config.
func (h *RulesIOHandler) Parse(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	var req rulesParseReq
	if !decodeJSON(w, r, &req) {
		return
	}
	_, data, err := h.m.Get(id, false)
	if writeManagerError(w, err) {
		return
	}
	// ApplyRuleImport keys conflicts off a single flat namespace over ALL of
	// data.Proxies (proxies and visitors share one name space), so judge
	// conflicts the same way here to stay in lockstep with apply.
	exist := map[string]bool{}
	for _, p := range data.Proxies {
		exist[p.Name] = true
	}

	parsed, perr := config.ParseRules([]byte(req.Content))
	if perr != nil {
		WriteJSON(w, http.StatusOK, map[string]any{
			"detectedFormat": "unknown", "items": []any{}, "globalError": perr.Error(),
		})
		return
	}

	sourceUser := ""
	if parsed.Source != nil {
		sourceUser = parsed.Source.User
	}
	used := map[int]bool{}
	suggested := map[string]bool{} // suggested-visitor names chosen within this batch
	items := make([]map[string]any, 0, len(parsed.Proxies))
	for _, p := range parsed.Proxies {
		item := map[string]any{
			"name":    p.Name,
			"type":    p.Type,
			"summary": ruleSummary(p),
		}
		if p.IsVisitor() {
			item["kind"] = "visitor"
			item["raw"] = mustMarshal(config.ClientVisitorToV1(p))
			item["conflict"] = conflictTag(exist[p.Name])
		} else {
			item["kind"] = "proxy"
			conv, e := config.ClientProxyToV1(p)
			if e != nil || len(conv) == 0 {
				item["error"] = "无法转换该代理"
			} else {
				item["raw"] = mustMarshal(conv[0])
			}
			item["conflict"] = conflictTag(exist[p.Name])
			if config.Pairable(p) {
				item["pairable"] = true
				port := h.m.SuggestVisitorBindPort(p.Type, "0.0.0.0", 10000, used)
				sv := config.DerivePairVisitor(p, sourceUser, "0.0.0.0", port)
				// DerivePairVisitor mirrors the proxy name; since apply uses one
				// flat namespace, pick a name that collides with neither existing
				// rules nor an earlier suggestion in this batch so the default
				// "create" action succeeds and the preview shows the real name.
				sv.Name = uniqueSuggestedName(p.Name, exist, suggested)
				suggested[sv.Name] = true
				item["suggestedVisitor"] = mustMarshal(config.ClientVisitorToV1(sv))
			}
		}
		items = append(items, item)
	}

	resp := map[string]any{"detectedFormat": parsed.Format, "items": items}
	if parsed.Source != nil {
		resp["source"] = parsed.Source
	}
	WriteJSON(w, http.StatusOK, resp)
}

type rulesImportItem struct {
	Kind    string                     `json:"kind"`
	Action  string                     `json:"action"`
	NewName string                     `json:"newName,omitempty"`
	Proxy   *config.TypedProxyConfig   `json:"proxy,omitempty"`
	Visitor *config.TypedVisitorConfig `json:"visitor,omitempty"`
}

type rulesImportReq struct {
	Items []rulesImportItem `json:"items"`
}

// Import commits a resolved batch (one write + one reload + one event).
func (h *RulesIOHandler) Import(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	var req rulesImportReq
	if !decodeJSON(w, r, &req) {
		return
	}
	resolved := make([]manager.RuleImportItem, 0, len(req.Items))
	for _, it := range req.Items {
		var p *config.Proxy
		switch {
		case it.Visitor != nil:
			p = config.ClientVisitorFromV1(*it.Visitor)
		case it.Proxy != nil:
			p = config.ClientProxyFromV1(*it.Proxy)
		default:
			continue // empty item -> skip silently
		}
		resolved = append(resolved, manager.RuleImportItem{
			Action: it.Action, NewName: it.NewName, Proxy: p,
		})
	}
	sum, err := h.m.ApplyRuleImport(id, resolved)
	if writeManagerError(w, err) {
		return
	}
	WriteJSON(w, http.StatusOK, sum)
}

// --- small helpers ---

func ruleSummary(p *config.Proxy) string {
	if p.IsVisitor() {
		return p.Type + " · bind " + p.BindAddr + ":" + itoaSafe(p.BindPort)
	}
	if p.LocalPort != "" {
		return p.Type + " · localPort " + p.LocalPort
	}
	return p.Type
}

// uniqueSuggestedName picks a name for a derived pairing visitor that collides
// with neither existing rule names (exist) nor names already chosen in this
// batch (suggested). It tries base, then base+"-visitor", then
// base+"-visitor-2", base+"-visitor-3", … returning the first free candidate.
func uniqueSuggestedName(base string, exist, suggested map[string]bool) string {
	taken := func(n string) bool { return exist[n] || suggested[n] }
	if !taken(base) {
		return base
	}
	if cand := base + "-visitor"; !taken(cand) {
		return cand
	}
	for i := 2; ; i++ {
		cand := base + "-visitor-" + strconv.Itoa(i)
		if !taken(cand) {
			return cand
		}
	}
}

func conflictTag(exists bool) any {
	if exists {
		return "name_exists"
	}
	return nil
}

func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("null")
	}
	return b
}

func itoaSafe(n int) string { return strconv.Itoa(n) }

// filenameFor sanitizes a config name into a safe download filename stem.
// Empty input yields "config"; filesystem-unsafe characters and whitespace
// are replaced by "-".
func filenameFor(s string) string {
	if s == "" {
		return "config"
	}
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|', ' ', '\t', '\n', '\r':
			b.WriteByte('-')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
