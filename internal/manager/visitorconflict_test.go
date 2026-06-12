package manager

import (
	"testing"

	"github.com/mia-clark/frpc-manager/pkg/config"
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
