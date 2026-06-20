package config

import (
	"encoding/json"
	"strings"
	"testing"
)

func stcpProxy(name, sk string, enc bool) *Proxy {
	p := &Proxy{}
	p.Name = name
	p.Type = "stcp"
	p.SK = sk
	p.UseEncryption = enc
	return p
}

func TestBuildPortableEnvelope(t *testing.T) {
	src := PortableSource{ConfigID: "c1", ConfigName: "实例", User: "node-a", Daemon: "1.2.75", Frp: "0.69.1"}
	env, err := BuildPortableEnvelope([]*Proxy{stcpProxy("ssh", "k1", true)}, nil, src)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if env.FrpcManagerExport != "v1" || env.Kind != "rules" {
		t.Fatalf("bad header: %+v", env)
	}
	if env.Source.User != "node-a" {
		t.Fatalf("source.user lost: %+v", env.Source)
	}
	b, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(b)
	// camelCase 锚点 + secretKey 必须在
	for _, want := range []string{`"frpcManagerExport":"v1"`, `"secretKey":"k1"`, `"useEncryption":true`} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in %s", want, s)
		}
	}
}

func TestRenderRulesTOML(t *testing.T) {
	proxiesTOML, visitorsTOML, err := RenderRulesTOML(
		[]*Proxy{stcpProxy("ssh", "k1", true)},
		nil,
	)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(proxiesTOML, "[[proxies]]") || !strings.Contains(proxiesTOML, `name = 'ssh'`) {
		t.Fatalf("proxies toml wrong: %s", proxiesTOML)
	}
	if !strings.Contains(proxiesTOML, "secretKey = 'k1'") {
		t.Fatalf("secretKey missing: %s", proxiesTOML)
	}
	if visitorsTOML != "" {
		t.Fatalf("visitors should be empty, got: %s", visitorsTOML)
	}
}

func TestParseRules_PortableRoundTrip(t *testing.T) {
	src := PortableSource{User: "node-a"}
	env, _ := BuildPortableEnvelope([]*Proxy{stcpProxy("ssh", "k1", true)}, nil, src)
	b, _ := json.Marshal(env)

	pr, err := ParseRules(b)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if pr.Format != "portable" {
		t.Fatalf("format = %s", pr.Format)
	}
	if pr.Source == nil || pr.Source.User != "node-a" {
		t.Fatalf("source.user lost: %+v", pr.Source)
	}
	if len(pr.Proxies) != 1 || pr.Proxies[0].Name != "ssh" || pr.Proxies[0].SK != "k1" {
		t.Fatalf("proxy round-trip wrong: %+v", pr.Proxies)
	}
}

func TestParseRules_TOMLFragment(t *testing.T) {
	proxiesTOML, _, _ := RenderRulesTOML([]*Proxy{stcpProxy("ssh", "k1", false)}, nil)
	pr, err := ParseRules([]byte(proxiesTOML))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if pr.Format != "toml" {
		t.Fatalf("format = %s", pr.Format)
	}
	if len(pr.Proxies) != 1 || pr.Proxies[0].Type != "stcp" {
		t.Fatalf("toml parse wrong: %+v", pr.Proxies)
	}
}

func TestParseRules_Unknown(t *testing.T) {
	pr, err := ParseRules([]byte("this is not a config at all !!!"))
	if err == nil && pr.Format != "unknown" {
		t.Fatalf("expected unknown/err, got %+v / %v", pr, err)
	}
}

func TestDerivePairVisitor(t *testing.T) {
	p := stcpProxy("secret-ssh", "k1", true)
	p.UseCompression = true
	v := DerivePairVisitor(p, "node-a", "0.0.0.0", 16001)
	if !v.IsVisitor() {
		t.Fatalf("derived must be visitor")
	}
	if v.Type != "stcp" || v.ServerName != "secret-ssh" || v.SK != "k1" || v.ServerUser != "node-a" {
		t.Fatalf("mapping wrong: %+v", v)
	}
	if v.BindAddr != "0.0.0.0" || v.BindPort != 16001 {
		t.Fatalf("bind wrong: %+v", v)
	}
	// 加密/压缩强制对齐(根治两端对不齐)
	if !v.UseEncryption || !v.UseCompression {
		t.Fatalf("enc/comp must mirror proxy: %+v", v)
	}
}

func TestDerivePairVisitor_XTCPDefaultProtocol(t *testing.T) {
	p := stcpProxy("x", "k", false)
	p.Type = "xtcp"
	v := DerivePairVisitor(p, "", "0.0.0.0", 7000)
	if v.Type != "xtcp" || v.Protocol != "quic" {
		t.Fatalf("xtcp default protocol wrong: %+v", v)
	}
	if v.ServerUser != "" {
		t.Fatalf("empty source user must stay empty: %+v", v)
	}
}
