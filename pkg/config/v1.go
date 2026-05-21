package config

import (
	"encoding/json"

	"github.com/fatedier/frp/pkg/config/v1"
)

type ClientConfigV1 struct {
	v1.ClientCommonConfig

	Proxies  []TypedProxyConfig   `json:"proxies,omitempty"`
	Visitors []TypedVisitorConfig `json:"visitors,omitempty"`

	Mgr Mgr `json:"frpmgr,omitempty"`
}

type Mgr struct {
	Name        string     `json:"name,omitempty"`
	ManualStart bool       `json:"manualStart,omitempty"`
	AutoDelete  AutoDelete `json:"autoDelete,omitempty"`
}

type TypedProxyConfig struct {
	v1.TypedProxyConfig
	Mgr ProxyMgr `json:"frpmgr,omitempty"`
}

type TypedVisitorConfig struct {
	v1.TypedVisitorConfig
	Mgr ProxyMgr `json:"frpmgr,omitempty"`
}

type ProxyMgr struct {
	Range RangePort `json:"range,omitempty"`
	Sort  int       `json:"sort,omitempty"`
}

type RangePort struct {
	Local  string `json:"local"`
	Remote string `json:"remote"`
}

func (c *TypedProxyConfig) UnmarshalJSON(b []byte) error {
	err := c.TypedProxyConfig.UnmarshalJSON(b)
	if err != nil {
		return err
	}
	c.Mgr, err = unmarshalProxyMgr(b)
	return err
}

// MarshalJSON flattens the embedded upstream TypedProxyConfig and merges
// the frpmgr extension block into the same object, so that the JSON shape
// is round-trippable through UnmarshalJSON. Without this method Go would
// fall back to reflection and emit an unwanted "ProxyConfigurer" wrapper
// because the outer struct adds a non-anonymous field, defeating the
// promotion of v1.TypedProxyConfig.MarshalJSON.
//
// Receiver is a value (not pointer) so it works even when handlers pass a
// non-addressable copy into json.Encode via the empty `any` interface.
func (c TypedProxyConfig) MarshalJSON() ([]byte, error) {
	inner, err := c.TypedProxyConfig.MarshalJSON()
	if err != nil {
		return nil, err
	}
	if c.Mgr == (ProxyMgr{}) {
		return inner, nil
	}
	var m map[string]any
	if err := json.Unmarshal(inner, &m); err != nil {
		return nil, err
	}
	m["frpmgr"] = c.Mgr
	return json.Marshal(m)
}

func (c *TypedVisitorConfig) UnmarshalJSON(b []byte) error {
	err := c.TypedVisitorConfig.UnmarshalJSON(b)
	if err != nil {
		return err
	}
	c.Mgr, err = unmarshalProxyMgr(b)
	return err
}

// MarshalJSON mirrors TypedProxyConfig.MarshalJSON for visitors.
func (c TypedVisitorConfig) MarshalJSON() ([]byte, error) {
	inner, err := c.TypedVisitorConfig.MarshalJSON()
	if err != nil {
		return nil, err
	}
	if c.Mgr == (ProxyMgr{}) {
		return inner, nil
	}
	var m map[string]any
	if err := json.Unmarshal(inner, &m); err != nil {
		return nil, err
	}
	m["frpmgr"] = c.Mgr
	return json.Marshal(m)
}

func unmarshalProxyMgr(b []byte) (c ProxyMgr, err error) {
	s := struct {
		Mgr ProxyMgr `json:"frpmgr"`
	}{}
	if err = json.Unmarshal(b, &s); err != nil {
		return
	}
	c = s.Mgr
	return
}
