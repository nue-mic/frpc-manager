package manager

import (
	"log/slog"
	"time"

	"github.com/nue-mic/frpc-manager/pkg/config"
)

// ArmAutoDelete schedules a one-shot timer that deletes the config when
// it expires. Existing timers are cancelled. Pass a zero-config to clear.
func (m *Manager) ArmAutoDelete(id string) {
	inst := m.get(id)
	if inst == nil {
		return
	}
	d, err := config.Expiry(inst.Path(), inst.Data().AutoDelete)
	if err != nil || d <= 0 {
		inst.cancelAutoDelete()
		if err == nil && d <= 0 {
			m.opts.Logger.Info("auto-delete fired immediately", slog.String("id", id))
			go m.autoDeleteNow(id)
		}
		return
	}
	inst.scheduleAutoDelete(d, func() {
		m.autoDeleteNow(id)
	})
}

// autoDeleteNow stops the instance, deletes the file, and broadcasts.
func (m *Manager) autoDeleteNow(id string) {
	m.opts.Logger.Info("auto-deleting config", slog.String("id", id))
	if err := m.Delete(id); err != nil {
		m.opts.Logger.Warn("auto-delete failed", slog.String("id", id), slog.Any("err", err))
	}
}

// ArmAllAutoDelete walks every registered instance and schedules timers
// where appropriate. Called at startup and after bulk imports.
func (m *Manager) ArmAllAutoDelete() {
	m.mu.RLock()
	ids := make([]string, 0, len(m.instances))
	for id := range m.instances {
		ids = append(ids, id)
	}
	m.mu.RUnlock()
	for _, id := range ids {
		m.ArmAutoDelete(id)
	}
}

// ensure time is used (referenced via instance.scheduleAutoDelete)
var _ = time.Now
