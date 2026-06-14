package services

import (
	"testing"

	v1 "github.com/fatedier/frp/pkg/config/v1"
	"github.com/fatedier/frp/pkg/policy/featuregate"
)

func TestVNetPlatformError(t *testing.T) {
	withAddr := &v1.ClientCommonConfig{VirtualNet: v1.VirtualNetConfig{Address: "100.86.0.2/24"}}
	noAddr := &v1.ClientCommonConfig{}

	if err := vnetPlatformError("windows", withAddr); err == nil {
		t.Errorf("windows + vnet address 应返回错误，实际为 nil")
	}
	if err := vnetPlatformError("linux", withAddr); err != nil {
		t.Errorf("linux + vnet address 不应报错，实际: %v", err)
	}
	if err := vnetPlatformError("darwin", withAddr); err != nil {
		t.Errorf("darwin + vnet address 不应报错，实际: %v", err)
	}
	if err := vnetPlatformError("windows", noAddr); err != nil {
		t.Errorf("windows 但未配 vnet 不应报错，实际: %v", err)
	}
}

func TestApplyFeatureGates(t *testing.T) {
	// nil / empty 应安全返回
	if err := applyFeatureGates(nil); err != nil {
		t.Errorf("nil common 不应报错: %v", err)
	}
	if err := applyFeatureGates(&v1.ClientCommonConfig{}); err != nil {
		t.Errorf("空 featureGates 不应报错: %v", err)
	}

	// 应用 {VirtualNet:true} 后，frp 进程级 feature gate 应被启用
	common := &v1.ClientCommonConfig{FeatureGates: map[string]bool{"VirtualNet": true}}
	if err := applyFeatureGates(common); err != nil {
		t.Fatalf("applyFeatureGates error: %v", err)
	}
	if !featuregate.Enabled(featuregate.VirtualNet) {
		t.Errorf("应用 featureGates 后 VirtualNet 仍未启用")
	}
}
