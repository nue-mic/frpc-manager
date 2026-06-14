package config

import (
	"path/filepath"
	"testing"

	frpconfig "github.com/fatedier/frp/pkg/config"
	v1 "github.com/fatedier/frp/pkg/config/v1"

	"github.com/mia-clark/frpc-manager/pkg/consts"
)

// TestVNetCommonRoundTrip 验证客户端公共配置里的 virtualNet.address 与
// featureGates 经过 legacy 模型往返（FromV1 -> ToV1）后不丢失。
func TestVNetCommonRoundTrip(t *testing.T) {
	in := v1.ClientCommonConfig{
		VirtualNet:   v1.VirtualNetConfig{Address: "100.86.0.2/24"},
		FeatureGates: map[string]bool{"VirtualNet": true},
	}
	legacy := ClientCommonFromV1(&in)
	out := ClientCommonToV1(&legacy)

	if out.VirtualNet.Address != "100.86.0.2/24" {
		t.Errorf("virtualNet.address 丢失: got %q, want %q", out.VirtualNet.Address, "100.86.0.2/24")
	}
	if !out.FeatureGates["VirtualNet"] {
		t.Errorf("featureGates.VirtualNet 丢失: got %v", out.FeatureGates)
	}
}

// TestVNetServerProxyRoundTrip 验证服务端 virtual_net 代理（stcp + plugin）
// 往返后插件类型与插件选项（用于 GET 回读时序列化出 type）都存活。
func TestVNetServerProxyRoundTrip(t *testing.T) {
	in := TypedProxyConfig{TypedProxyConfig: v1.TypedProxyConfig{
		Type: "stcp",
		ProxyConfigurer: &v1.STCPProxyConfig{
			ProxyBaseConfig: v1.ProxyBaseConfig{
				Name: "vnet-server",
				Type: "stcp",
				ProxyBackend: v1.ProxyBackend{
					Plugin: v1.TypedClientPluginOptions{
						Type:                "virtual_net",
						ClientPluginOptions: &v1.VirtualNetPluginOptions{Type: "virtual_net"},
					},
				},
			},
			Secretkey: "shared-key",
		},
	}}

	legacy := ClientProxyFromV1(in)
	outs, err := ClientProxyToV1(legacy)
	if err != nil {
		t.Fatalf("ClientProxyToV1 error: %v", err)
	}
	if len(outs) != 1 {
		t.Fatalf("expected 1 proxy, got %d", len(outs))
	}
	base := outs[0].GetBaseConfig()
	if base.Plugin.Type != "virtual_net" {
		t.Errorf("代理 plugin.type 丢失: got %q", base.Plugin.Type)
	}
	if _, ok := base.Plugin.ClientPluginOptions.(*v1.VirtualNetPluginOptions); !ok {
		// 关键：TypedClientPluginOptions.MarshalJSON 只序列化内层 options，
		// 若 ClientPluginOptions 为 nil，GET 回读会得到 plugin:null 丢类型。
		t.Errorf("代理 plugin 选项不是 *VirtualNetPluginOptions: got %T", base.Plugin.ClientPluginOptions)
	}
}

// TestVNetVisitorRoundTrip 验证访客 virtual_net 插件（plugin.type + destinationIP）
// 与 bindPort=-1 经 legacy 模型往返后存活。
func TestVNetVisitorRoundTrip(t *testing.T) {
	in := TypedVisitorConfig{TypedVisitorConfig: v1.TypedVisitorConfig{
		Type: "stcp",
		VisitorConfigurer: &v1.STCPVisitorConfig{
			VisitorBaseConfig: v1.VisitorBaseConfig{
				Name:       "vnet-visitor",
				Type:       "stcp",
				ServerName: "vnet-server",
				SecretKey:  "shared-key",
				BindPort:   -1,
				Plugin: v1.TypedVisitorPluginOptions{
					Type: "virtual_net",
					VisitorPluginOptions: &v1.VirtualNetVisitorPluginOptions{
						Type:          "virtual_net",
						DestinationIP: "100.86.0.1",
					},
				},
			},
		},
	}}

	legacy := ClientVisitorFromV1(in)
	out := ClientVisitorToV1(legacy)
	base := out.GetBaseConfig()

	if base.Plugin.Type != "virtual_net" {
		t.Errorf("访客 plugin.type 丢失: got %q", base.Plugin.Type)
	}
	vp, ok := base.Plugin.VisitorPluginOptions.(*v1.VirtualNetVisitorPluginOptions)
	if !ok {
		t.Fatalf("访客 plugin 选项不是 *VirtualNetVisitorPluginOptions: got %T", base.Plugin.VisitorPluginOptions)
	}
	if vp.DestinationIP != "100.86.0.1" {
		t.Errorf("访客 destinationIP 丢失: got %q", vp.DestinationIP)
	}
	if base.BindPort != -1 {
		t.Errorf("访客 bindPort 丢失: got %d, want -1", base.BindPort)
	}
}

// TestVNetSaveTOMLLoadsBackInFrp 是最关键的端到端证明：把含 vnet 的配置经
// saveTOML（toMap 反射路径，区别于 JSON MarshalJSON）落盘后，frp 自带的原生
// 加载器能完整读回三类字段——即 frp 运行时确实拿得到 vnet 配置。
func TestVNetSaveTOMLLoadsBackInFrp(t *testing.T) {
	cfg := &ClientConfig{}
	cfg.ClientCommon.Name = "vnet-node"
	cfg.ServerAddress = "frps.example.com"
	cfg.ServerPort = 7000
	cfg.VirtualNetAddress = "100.86.0.2/24"
	cfg.FeatureGates = map[string]bool{"VirtualNet": true}
	cfg.Proxies = append(cfg.Proxies, &Proxy{
		BaseProxyConf: BaseProxyConf{Name: "vnet-server", Type: "stcp", Plugin: consts.PluginVirtualNet},
		SK:            "shared-key",
	})
	cfg.Proxies = append(cfg.Proxies, &Proxy{
		BaseProxyConf: BaseProxyConf{Name: "vnet-visitor", Type: "stcp", Plugin: consts.PluginVirtualNet},
		Role:          "visitor",
		SK:            "shared-key",
		ServerName:    "vnet-server",
		BindPort:      -1,
		DestinationIP: "100.86.0.1",
	})

	path := filepath.Join(t.TempDir(), "frpc.toml")
	if err := cfg.Save(path); err != nil {
		t.Fatalf("Save: %v", err)
	}

	result, err := frpconfig.LoadClientConfigResult(path, false)
	if err != nil {
		t.Fatalf("frp LoadClientConfigResult: %v", err)
	}
	if result.Common.VirtualNet.Address != "100.86.0.2/24" {
		t.Errorf("磁盘 virtualNet.address 丢失: got %q", result.Common.VirtualNet.Address)
	}
	if !result.Common.FeatureGates["VirtualNet"] {
		t.Errorf("磁盘 featureGates.VirtualNet 丢失: got %v", result.Common.FeatureGates)
	}
	serverOK := false
	for _, p := range result.Proxies {
		b := p.GetBaseConfig()
		if b.Name == "vnet-server" && b.Plugin.Type == "virtual_net" {
			serverOK = true
		}
	}
	if !serverOK {
		t.Errorf("磁盘服务端 virtual_net 代理插件丢失")
	}
	visitorOK := false
	for _, vv := range result.Visitors {
		b := vv.GetBaseConfig()
		if b.Name != "vnet-visitor" || b.Plugin.Type != "virtual_net" || b.BindPort != -1 {
			continue
		}
		if vp, ok := b.Plugin.VisitorPluginOptions.(*v1.VirtualNetVisitorPluginOptions); ok && vp.DestinationIP == "100.86.0.1" {
			visitorOK = true
		}
	}
	if !visitorOK {
		t.Errorf("磁盘访客 virtual_net 插件 / destinationIP 丢失")
	}
}
