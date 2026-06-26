package api

import (
	"github.com/nue-mic/frpc-manager/pkg/config"
)

// toV1 converts an in-memory ClientConfig into the JSON-friendly V1
// shape used over the wire. The conversion mirrors what
// (*config.ClientConfig).Save does for TOML serialization.
func toV1(c *config.ClientConfig) *config.ClientConfigV1 {
	if c == nil {
		return nil
	}
	out := &config.ClientConfigV1{
		ClientCommonConfig: config.ClientCommonToV1(&c.ClientCommon),
		Mgr: config.Mgr{
			Name:        c.ClientCommon.Name,
			ManualStart: c.ManualStart,
			AutoDelete:  c.AutoDelete,
		},
	}
	for i, p := range c.Proxies {
		if p.IsVisitor() {
			v := config.ClientVisitorToV1(p)
			v.Mgr.Sort = i + 1
			out.Visitors = append(out.Visitors, v)
		} else {
			pxs, err := config.ClientProxyToV1(p)
			if err != nil {
				continue
			}
			out.Proxies = append(out.Proxies, pxs...)
		}
	}
	return out
}

// fromV1 inflates a wire-shape ClientConfigV1 back into the in-memory
// ClientConfig used by services/client.go.
func fromV1(v *config.ClientConfigV1) *config.ClientConfig {
	if v == nil {
		return nil
	}
	c := &config.ClientConfig{}
	c.ClientCommon = config.ClientCommonFromV1(&v.ClientCommonConfig)
	c.ClientCommon.Name = v.Mgr.Name
	c.ManualStart = v.Mgr.ManualStart
	c.AutoDelete = v.Mgr.AutoDelete

	ignore := make(map[string]struct{})
	for _, pv := range v.Proxies {
		p := config.ClientProxyFromV1(pv)
		if p.IsRange() {
			for _, alias := range p.GetAlias() {
				if alias != p.Name {
					ignore[alias] = struct{}{}
				}
			}
		}
		c.Proxies = append(c.Proxies, p)
	}
	// drop synthesized range expansions
	filtered := c.Proxies[:0]
	for _, p := range c.Proxies {
		if _, skip := ignore[p.Name]; skip {
			continue
		}
		filtered = append(filtered, p)
	}
	c.Proxies = filtered

	for _, vv := range v.Visitors {
		c.Proxies = append(c.Proxies, config.ClientVisitorFromV1(vv))
	}
	return c
}
