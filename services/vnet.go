package services

import (
	"fmt"

	v1 "github.com/fatedier/frp/pkg/config/v1"
	"github.com/fatedier/frp/pkg/policy/featuregate"
)

// applyFeatureGates applies a config's featureGates to frp's process-global
// feature gate registry, mirroring what the upstream CLI does in
// cmd/frpc/sub/root.go. frpc-manager talks to client.NewService directly and
// would otherwise never enable any gate, so a config that sets
// virtualNet.address would fail validation with "VirtualNet feature is not
// enabled". The registry is a process-wide singleton: once any instance turns
// VirtualNet on it stays on for the whole daemon, which is harmless because the
// feature only does anything when virtualNet.address is set per config.
func applyFeatureGates(common *v1.ClientCommonConfig) error {
	if common == nil || len(common.FeatureGates) == 0 {
		return nil
	}
	if err := featuregate.SetFromMap(common.FeatureGates); err != nil {
		return fmt.Errorf("应用 featureGates 失败: %w", err)
	}
	return nil
}

// vnetPlatformError reports a user-facing error when a virtual-network config is
// used on a platform where frp's TUN backend is unimplemented. frp only ships a
// TUN implementation for linux and darwin; everywhere else (notably windows)
// pkg/vnet/tun_unsupported.go returns "virtual net is not supported on this
// platform" at runtime, which makes the instance fail to start with an opaque
// message. Catching it here lets the daemon surface a clear, actionable error.
func vnetPlatformError(goos string, common *v1.ClientCommonConfig) error {
	if common == nil || common.VirtualNet.Address == "" {
		return nil
	}
	switch goos {
	case "linux", "darwin":
		return nil
	default:
		return fmt.Errorf("虚拟网络(VNet)仅支持 Linux/macOS，当前系统为 %s，无法创建 TUN 网卡；请移除该配置的 virtualNet.address，或改在 Linux/macOS 主机上运行", goos)
	}
}
