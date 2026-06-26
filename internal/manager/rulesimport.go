package manager

import (
	"strconv"

	"github.com/nue-mic/frpc-manager/pkg/config"
)

// SuggestVisitorBindPort returns the first port >= start that collides with no
// existing visitor (same protocol family + bindAddr) AND is not already in the
// caller-provided `used` set (so batched suggestions don't duplicate). The
// chosen port is added to `used`. Falls back to `start` if nothing is free in
// a sane range.
func (m *Manager) SuggestVisitorBindPort(vType, bindAddr string, start int, used map[int]bool) int {
	if start <= 0 {
		start = 10000
	}
	if used == nil {
		used = map[int]bool{}
	}
	for port := start; port <= 65535; port++ {
		if used[port] {
			continue
		}
		if m.VisitorBindConflict("", "", vType, bindAddr, port) != nil {
			continue
		}
		used[port] = true
		return port
	}
	used[start] = true
	return start
}

// RuleImportItem is one resolved import action. Proxy is an in-memory *Proxy
// already converted from the wire payload (visitor items have Role=="visitor").
type RuleImportItem struct {
	Action  string // "create" | "overwrite" | "rename" | "skip"
	NewName string // required when Action=="rename"
	Proxy   *config.Proxy
}

type RuleImportResult struct {
	Name      string `json:"name"`
	FinalName string `json:"finalName"`
	Status    string `json:"status"` // created|overwritten|renamed|skipped|failed
	Error     string `json:"error,omitempty"`
}

type RuleImportSummary struct {
	Applied int                `json:"applied"`
	Skipped int                `json:"skipped"`
	Failed  int                `json:"failed"`
	Results []RuleImportResult `json:"results"`
}

// ApplyRuleImport applies a batch of import items to config id in one shot:
// it mutates a cloned proxy slice, performs per-item conflict handling, then
// does a single Update (one write + one hot-reload + one config.changed event).
// best-effort: a single bad item is recorded as "failed"/"skipped" and the rest
// proceed. The whole call only errors on a fatal Update failure.
func (m *Manager) ApplyRuleImport(id string, items []RuleImportItem) (RuleImportSummary, error) {
	var sum RuleImportSummary
	_, data, err := m.Get(id, false)
	if err != nil {
		return sum, err
	}
	// clone current proxies so a write failure can't leave live state mutated
	next := make([]*config.Proxy, 0, len(data.Proxies)+len(items))
	idxByName := map[string]int{}
	for _, p := range data.Proxies {
		np := *p
		next = append(next, &np)
		idxByName[np.Name] = len(next) - 1
	}
	usedBinds := map[string]bool{} // proto|addr|port within this batch

	bindKey := func(p *config.Proxy) string {
		return visitorProto(p.Type) + "|" + normBindAddr(p.BindAddr) + "|" + itoa(p.BindPort)
	}
	addVisitorOK := func(p *config.Proxy) (bool, string) {
		if !p.IsVisitor() {
			return true, ""
		}
		if c := m.VisitorBindConflict(id, "", p.Type, p.BindAddr, p.BindPort); c != nil {
			return false, "本地端口冲突:已被实例「" + c.ConfigName + "」访客「" + c.Name + "」占用"
		}
		if usedBinds[bindKey(p)] {
			return false, "本地端口与本批次另一访客重复"
		}
		usedBinds[bindKey(p)] = true
		return true, ""
	}

	for _, it := range items {
		if it.Proxy == nil {
			sum.Failed++
			sum.Results = append(sum.Results, RuleImportResult{Status: "failed", Error: "空规则"})
			continue
		}
		name := it.Proxy.Name
		switch it.Action {
		case "skip":
			sum.Skipped++
			sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "skipped"})
		case "create":
			if _, exists := idxByName[name]; exists {
				sum.Failed++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "failed", Error: "同名已存在"})
				continue
			}
			if ok, msg := addVisitorOK(it.Proxy); !ok {
				sum.Failed++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "failed", Error: msg})
				continue
			}
			next = append(next, it.Proxy)
			idxByName[name] = len(next) - 1
			sum.Applied++
			sum.Results = append(sum.Results, RuleImportResult{Name: name, FinalName: name, Status: "created"})
		case "overwrite":
			if ok, msg := addVisitorOK(it.Proxy); !ok {
				sum.Failed++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "failed", Error: msg})
				continue
			}
			if i, exists := idxByName[name]; exists {
				next[i] = it.Proxy
				sum.Applied++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, FinalName: name, Status: "overwritten"})
			} else {
				next = append(next, it.Proxy)
				idxByName[name] = len(next) - 1
				sum.Applied++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, FinalName: name, Status: "created"})
			}
		case "rename":
			nn := it.NewName
			if nn == "" || nn == name {
				sum.Failed++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "failed", Error: "重命名需要新名称"})
				continue
			}
			if _, exists := idxByName[nn]; exists {
				sum.Failed++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "failed", Error: "新名称已存在"})
				continue
			}
			it.Proxy.Name = nn
			if ok, msg := addVisitorOK(it.Proxy); !ok {
				sum.Failed++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "failed", Error: msg})
				continue
			}
			next = append(next, it.Proxy)
			idxByName[nn] = len(next) - 1
			sum.Applied++
			sum.Results = append(sum.Results, RuleImportResult{Name: name, FinalName: nn, Status: "renamed"})
		default:
			sum.Failed++
			sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "failed", Error: "未知动作:" + it.Action})
		}
	}

	if sum.Applied == 0 {
		return sum, nil // 没有任何变更,不触发写盘
	}
	updated := withProxiesData(data, next)
	if err := m.Update(id, updated); err != nil {
		return sum, err
	}
	return sum, nil
}

func itoa(n int) string { return strconv.Itoa(n) }

// withProxiesData returns a shallow copy of data with Proxies replaced.
func withProxiesData(src *config.ClientConfig, proxies []*config.Proxy) *config.ClientConfig {
	cp := *src
	cp.Proxies = proxies
	return &cp
}
