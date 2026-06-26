package manager

import (
	"testing"

	"github.com/nue-mic/frpc-manager/pkg/config"
)

// visitorCfg builds a ClientConfig holding one visitor of the given type/addr/port.
func visitorCfg(name, vType, bindAddr string, bindPort int) *config.ClientConfig {
	c := config.NewDefaultClientConfig()
	c.Proxies = append(c.Proxies, &config.Proxy{
		BaseProxyConf: config.BaseProxyConf{Name: name, Type: vType},
		Role:          "visitor",
		ServerName:    "svc-" + name,
		SK:            "key",
		BindAddr:      bindAddr,
		BindPort:      bindPort,
	})
	return c
}

func TestVisitorBindConflict(t *testing.T) {
	m := newImportTestManager(t)
	// 现有：c1 的 stcp 访客绑 0.0.0.0:12000；c2 的 sudp 访客绑 0.0.0.0:13000
	if err := m.Create("c1", visitorCfg("a", "stcp", "0.0.0.0", 12000)); err != nil {
		t.Fatalf("create c1: %v", err)
	}
	if err := m.Create("c2", visitorCfg("b", "sudp", "0.0.0.0", 13000)); err != nil {
		t.Fatalf("create c2: %v", err)
	}

	cases := []struct {
		name                              string
		excludeID, excludeName            string
		vType, bindAddr                   string
		bindPort                          int
		wantConflict                      bool
		wantConfigID                      string
	}{
		{"同型 STCP 同址同端口 → 冲突", "cx", "", "stcp", "0.0.0.0", 12000, true, "c1"},
		{"跨型 XTCP vs STCP 同址同端口 → 冲突(都 TCP)", "cx", "", "xtcp", "0.0.0.0", 12000, true, "c1"},
		{"SUDP vs STCP 同端口 → 不冲突(UDP/TCP 独立)", "cx", "", "sudp", "0.0.0.0", 12000, false, ""},
		{"SUDP vs SUDP 同端口 → 冲突", "cx", "", "sudp", "0.0.0.0", 13000, true, "c2"},
		{"通配 0.0.0.0 vs 具体 127.0.0.1 同端口 → 冲突", "cx", "", "stcp", "127.0.0.1", 12000, true, "c1"},
		{"不同端口 → 不冲突", "cx", "", "stcp", "0.0.0.0", 19999, false, ""},
		{"bindPort<=0 → 不冲突(不监听)", "cx", "", "stcp", "0.0.0.0", 0, false, ""},
		{"排除自身(同 id+name) → 不冲突", "c1", "a", "stcp", "0.0.0.0", 12000, false, ""},
		{"同 id 但不同 name → 仍冲突", "c1", "other", "stcp", "0.0.0.0", 12000, true, "c1"},
	}
	for _, tc := range cases {
		got := m.VisitorBindConflict(tc.excludeID, tc.excludeName, tc.vType, tc.bindAddr, tc.bindPort)
		if tc.wantConflict {
			if got == nil {
				t.Errorf("%s: 期望冲突但得到 nil", tc.name)
				continue
			}
			if got.ConfigID != tc.wantConfigID {
				t.Errorf("%s: 冲突实例 = %q, 期望 %q", tc.name, got.ConfigID, tc.wantConfigID)
			}
		} else if got != nil {
			t.Errorf("%s: 期望不冲突但得到 %+v", tc.name, got)
		}
	}
}

func twoVisitorCfg(n1, t1, a1 string, p1 int, n2, t2, a2 string, p2 int) *config.ClientConfig {
	c := config.NewDefaultClientConfig()
	for _, v := range []struct {
		n, t, a string
		p       int
	}{{n1, t1, a1, p1}, {n2, t2, a2, p2}} {
		c.Proxies = append(c.Proxies, &config.Proxy{
			BaseProxyConf: config.BaseProxyConf{Name: v.n, Type: v.t},
			Role:          "visitor", ServerName: "s-" + v.n, SK: "k", BindAddr: v.a, BindPort: v.p,
		})
	}
	return c
}

// ValidateVisitorBinds 覆盖整 config 保存路径: 跨实例冲突、排除被替换 config 自身、
// 同 config 内端口重复、空 bindAddr 归一 127.0.0.1。
func TestValidateVisitorBinds(t *testing.T) {
	m := newImportTestManager(t)
	if err := m.Create("other", visitorCfg("ov", "stcp", "0.0.0.0", 30000)); err != nil {
		t.Fatalf("create other: %v", err)
	}

	// (1) 跨实例: 新 config 的 xtcp 访客撞 other 的 stcp(都 TCP)
	if c := m.ValidateVisitorBinds("new", visitorCfg("v", "xtcp", "0.0.0.0", 30000)); c == nil || c.ConfigID != "other" {
		t.Fatalf("跨实例冲突未检出: %+v", c)
	}

	// (2) 排除整个被替换的 config: 替换 other 自身、同端口, 不应与旧值冲突
	if c := m.ValidateVisitorBinds("other", visitorCfg("ov2", "stcp", "0.0.0.0", 30000)); c != nil {
		t.Fatalf("替换自身 config 不应与旧值冲突: %+v", c)
	}

	// (3) 同 config 内两访客撞端口(stcp + xtcp 同 TCP)
	if c := m.ValidateVisitorBinds("dup", twoVisitorCfg("a", "stcp", "0.0.0.0", 40000, "b", "xtcp", "0.0.0.0", 40000)); c == nil || c.Name != "a" {
		t.Fatalf("同 config 内端口重复未检出: %+v", c)
	}

	// (4) 空 bindAddr 归一 127.0.0.1, 不与具体 LAN IP(192.168.1.9) 冲突
	if err := m.Create("lan", visitorCfg("lv", "stcp", "192.168.1.9", 50000)); err != nil {
		t.Fatalf("create lan: %v", err)
	}
	if c := m.ValidateVisitorBinds("ec", visitorCfg("ev", "stcp", "", 50000)); c != nil {
		t.Fatalf("空 bindAddr(→127.0.0.1) 不应与 192.168.1.9 冲突: %+v", c)
	}
}

// 两个不同的具体 IP 同端口同协议 → 不冲突（绑不同网卡）。
func TestVisitorBindConflict_DistinctSpecificIPs(t *testing.T) {
	m := newImportTestManager(t)
	if err := m.Create("c1", visitorCfg("a", "stcp", "192.168.1.5", 12000)); err != nil {
		t.Fatalf("create: %v", err)
	}
	if got := m.VisitorBindConflict("cx", "", "stcp", "192.168.1.6", 12000); got != nil {
		t.Fatalf("不同具体 IP 不应冲突, 得到 %+v", got)
	}
	if got := m.VisitorBindConflict("cx", "", "stcp", "192.168.1.5", 12000); got == nil {
		t.Fatalf("相同具体 IP 应冲突")
	}
}
