package services

import (
	"runtime"

	frpconfig "github.com/fatedier/frp/pkg/config"
	"github.com/fatedier/frp/pkg/config/v1/validation"
)

// VerifyClientConfig validates the frp client config file
func VerifyClientConfig(path string) error {
	cfg, proxyCfgs, visitorCfgs, _, err := frpconfig.LoadClientConfig(path, false)
	if err != nil {
		return err
	}
	// vnet 前置：先把 featureGates 应用到全局门，否则配了 virtualNet.address 的
	// 配置会被 validation 以 "VirtualNet feature is not enabled" 拒绝；再做平台守卫。
	if err := applyFeatureGates(cfg); err != nil {
		return err
	}
	if err := vnetPlatformError(runtime.GOOS, cfg); err != nil {
		return err
	}
	_, err = validation.ValidateAllClientConfig(cfg, proxyCfgs, visitorCfgs, nil)
	return err
}
