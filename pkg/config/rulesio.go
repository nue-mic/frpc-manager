package config

import (
	"encoding/json"

	"github.com/pelletier/go-toml/v2"

	"github.com/nue-mic/frpc-manager/pkg/consts"
)

// PortableSource records where an exported rule bundle came from. It carries
// the frp `user` so the importer can derive a visitor's serverUser.
type PortableSource struct {
	ConfigID   string `json:"configId,omitempty"`
	ConfigName string `json:"configName,omitempty"`
	User       string `json:"user,omitempty"`
	Daemon     string `json:"daemon,omitempty"`
	Frp        string `json:"frp,omitempty"`
}

// PortableEnvelope is the "规定格式 v1": a self-describing, version-tagged JSON
// bundle of proxies/visitors used to move rules between frpc-manager systems.
// proxies/visitors are upstream camelCase objects (their Typed* MarshalJSON).
type PortableEnvelope struct {
	FrpcManagerExport string               `json:"frpcManagerExport"`
	Kind              string               `json:"kind"`
	ExportedAt        string               `json:"exportedAt,omitempty"`
	Source            PortableSource       `json:"source"`
	Proxies           []TypedProxyConfig   `json:"proxies,omitempty"`
	Visitors          []TypedVisitorConfig `json:"visitors,omitempty"`
}

// BuildPortableEnvelope converts in-memory proxies/visitors into a v1 envelope.
// proxies are non-visitor *Proxy; visitors are Role=="visitor" *Proxy. Either
// slice may be nil. Range proxies are expanded via ClientProxyToV1.
func BuildPortableEnvelope(proxies, visitors []*Proxy, src PortableSource) (*PortableEnvelope, error) {
	env := &PortableEnvelope{FrpcManagerExport: "v1", Kind: "rules", Source: src}
	for _, p := range proxies {
		conv, err := ClientProxyToV1(p)
		if err != nil {
			return nil, err
		}
		env.Proxies = append(env.Proxies, conv...)
	}
	for _, v := range visitors {
		env.Visitors = append(env.Visitors, ClientVisitorToV1(v))
	}
	return env, nil
}

type proxiesDoc struct {
	Proxies []TypedProxyConfig `json:"proxies,omitempty"`
}
type visitorsDoc struct {
	Visitors []TypedVisitorConfig `json:"visitors,omitempty"`
}

// RenderRulesTOML renders the given rules as two independent TOML fragments:
// a [[proxies]] block and a [[visitors]] block (either empty when its slice is
// empty). proxies are non-visitor *Proxy; visitors are Role=="visitor" *Proxy.
// It reuses the exact toMap+toml.Marshal path that saveTOML uses, so field
// names/casing match the canonical frpc.toml.
func RenderRulesTOML(proxies, visitors []*Proxy) (proxiesTOML, visitorsTOML string, err error) {
	var pxs []TypedProxyConfig
	for _, p := range proxies {
		conv, e := ClientProxyToV1(p)
		if e != nil {
			return "", "", e
		}
		pxs = append(pxs, conv...)
	}
	if len(pxs) > 0 {
		obj, e := toMap(&proxiesDoc{Proxies: pxs}, "json")
		if e != nil {
			return "", "", e
		}
		b, e := toml.Marshal(obj)
		if e != nil {
			return "", "", e
		}
		proxiesTOML = string(b)
	}
	var vss []TypedVisitorConfig
	for _, v := range visitors {
		vss = append(vss, ClientVisitorToV1(v))
	}
	if len(vss) > 0 {
		obj, e := toMap(&visitorsDoc{Visitors: vss}, "json")
		if e != nil {
			return "", "", e
		}
		b, e := toml.Marshal(obj)
		if e != nil {
			return "", "", e
		}
		visitorsTOML = string(b)
	}
	return proxiesTOML, visitorsTOML, nil
}

// ParsedRules is the structured result of ParseRules. Proxies is the combined
// list; visitors appear in it with Role=="visitor" (use (*Proxy).IsVisitor()).
type ParsedRules struct {
	Format  string          // "portable" | "toml" | "ini" | "unknown"
	Source  *PortableSource // non-nil for portable; {User} for toml/ini
	Proxies []*Proxy
}

// ParseRules auto-detects and parses a pasted rule bundle. Order: portable JSON
// (must carry frpcManagerExport) → TOML/INI via UnmarshalClientConf. A parse
// failure returns (&ParsedRules{Format:"unknown"}, err) so callers can surface
// the message without treating it as a 500.
func ParseRules(content []byte) (*ParsedRules, error) {
	// 1) portable JSON
	var probe struct {
		FrpcManagerExport string `json:"frpcManagerExport"`
	}
	if json.Unmarshal(content, &probe) == nil && probe.FrpcManagerExport != "" {
		var env PortableEnvelope
		if err := json.Unmarshal(content, &env); err != nil {
			return &ParsedRules{Format: "unknown"}, err
		}
		out := &ParsedRules{Format: "portable", Source: &env.Source}
		for _, tp := range env.Proxies {
			out.Proxies = append(out.Proxies, ClientProxyFromV1(tp))
		}
		for _, tv := range env.Visitors {
			out.Proxies = append(out.Proxies, ClientVisitorFromV1(tv))
		}
		return out, nil
	}
	// 2) TOML / INI fragment or full frpc config
	conf, err := UnmarshalClientConf(content)
	if err != nil {
		return &ParsedRules{Format: "unknown"}, err
	}
	format := "toml"
	if conf.LegacyFormat {
		format = "ini"
	}
	return &ParsedRules{
		Format:  format,
		Source:  &PortableSource{User: conf.User},
		Proxies: conf.Proxies,
	}, nil
}

// Pairable reports whether p is an stcp/xtcp/sudp PROXY (not visitor) and can
// therefore be turned into a configured visitor on another system.
func Pairable(p *Proxy) bool {
	if p.IsVisitor() {
		return false
	}
	switch p.Type {
	case consts.ProxyTypeSTCP, consts.ProxyTypeXTCP, consts.ProxyTypeSUDP:
		return true
	}
	return false
}

// DerivePairVisitor builds the matching visitor for a pairable proxy. It mirrors
// the proxy's secretKey, encryption and compression (the latter two MUST match
// on both ends or frp tunnels silently fail), maps serverName=proxy.name and
// serverUser=the source frp user. bindAddr/bindPort are caller-chosen.
func DerivePairVisitor(p *Proxy, serverUser, bindAddr string, bindPort int) *Proxy {
	v := &Proxy{}
	v.Name = p.Name
	v.Type = p.Type
	v.UseEncryption = p.UseEncryption
	v.UseCompression = p.UseCompression
	v.Role = "visitor"
	v.SK = p.SK
	v.ServerName = p.Name
	v.ServerUser = serverUser
	v.BindAddr = bindAddr
	v.BindPort = bindPort
	if p.Type == consts.ProxyTypeXTCP {
		v.Protocol = "quic"
	}
	return v
}
