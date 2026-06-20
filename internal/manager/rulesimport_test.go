package manager

import (
	"testing"

	"github.com/mia-clark/frpc-manager/pkg/config"
)

func TestSuggestVisitorBindPort(t *testing.T) {
	m := newImportTestManager(t)
	if err := m.Create("c1", visitorCfg("a", "stcp", "0.0.0.0", 10000)); err != nil {
		t.Fatalf("create: %v", err)
	}
	used := map[int]bool{}
	// 10000 被占用 → 应跳过
	got := m.SuggestVisitorBindPort("stcp", "0.0.0.0", 10000, used)
	if got == 10000 {
		t.Fatalf("must skip occupied 10000, got %d", got)
	}
	if !used[got] {
		t.Fatalf("suggested port must be marked used: %d", got)
	}
	// 再要一个 → 不能与上次相同
	got2 := m.SuggestVisitorBindPort("stcp", "0.0.0.0", 10000, used)
	if got2 == got {
		t.Fatalf("second suggestion duplicated: %d", got2)
	}
}

func proxyRule(name string) *config.Proxy {
	p := &config.Proxy{}
	p.Name = name
	p.Type = "tcp"
	p.LocalIP = "127.0.0.1"
	p.LocalPort = "22"
	p.RemotePort = "6000"
	return p
}

// tcpProxyCfg builds a config containing a single tcp proxy named `name`.
func tcpProxyCfg(name string) *config.ClientConfig {
	c := config.NewDefaultClientConfig()
	c.Proxies = append(c.Proxies, proxyRule(name))
	return c
}

func TestApplyRuleImport_CreateAndRename(t *testing.T) {
	m := newImportTestManager(t)
	if err := m.Create("c1", tcpProxyCfg("ssh")); err != nil { // 已存在名为 ssh 的 tcp 代理
		t.Fatalf("create: %v", err)
	}
	sum, err := m.ApplyRuleImport("c1", []RuleImportItem{
		{Action: "create", Proxy: proxyRule("web")},                  // 新建
		{Action: "rename", NewName: "ssh2", Proxy: proxyRule("ssh")}, // 重名改名
		{Action: "skip", Proxy: proxyRule("ignored")},                // 跳过
	})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if sum.Applied != 2 || sum.Skipped != 1 {
		t.Fatalf("summary wrong: %+v", sum)
	}
	_, data, _ := m.Get("c1", false)
	names := map[string]bool{}
	for _, p := range data.Proxies {
		names[p.Name] = true
	}
	if !names["web"] || !names["ssh2"] || names["ignored"] {
		t.Fatalf("applied names wrong: %v", names)
	}
}

func TestApplyRuleImport_Overwrite(t *testing.T) {
	m := newImportTestManager(t)
	_ = m.Create("c1", tcpProxyCfg("ssh"))
	repl := proxyRule("ssh")
	repl.RemotePort = "9999"
	sum, err := m.ApplyRuleImport("c1", []RuleImportItem{{Action: "overwrite", Proxy: repl}})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if sum.Applied != 1 {
		t.Fatalf("summary: %+v", sum)
	}
	_, data, _ := m.Get("c1", false)
	for _, p := range data.Proxies {
		if p.Name == "ssh" && p.RemotePort != "9999" {
			t.Fatalf("overwrite did not apply: %+v", p)
		}
	}
}
