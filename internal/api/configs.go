package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/nue-mic/frpc-manager/internal/manager"
	"github.com/nue-mic/frpc-manager/pkg/config"
)

// ConfigsHandler serves the /api/v1/configs endpoints.
type ConfigsHandler struct {
	m   *manager.Manager
	log *slog.Logger
}

// NewConfigsHandler returns a handler bound to the given manager.
func NewConfigsHandler(m *manager.Manager, log *slog.Logger) *ConfigsHandler {
	return &ConfigsHandler{m: m, log: log}
}

// configEnvelope wraps an instance snapshot plus the full V1 config in
// one response body. Used by GET /configs/{id}.
type configEnvelope struct {
	manager.Snapshot
	Config *config.ClientConfigV1 `json:"config"`
}

// createReq is the input body for POST /configs.
type createReq struct {
	ID     string                 `json:"id"`
	Config *config.ClientConfigV1 `json:"config"`
}

// List returns every registered config (without per-proxy status).
func (h *ConfigsHandler) List(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{"items": h.m.List()})
}

// Get returns one config snapshot plus the parsed V1 body.
func (h *ConfigsHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	snap, data, err := h.m.Get(id, false)
	if writeManagerError(w, err) {
		return
	}
	WriteJSON(w, http.StatusOK, configEnvelope{Snapshot: snap, Config: toV1(data)})
}

// Create persists a new config from the supplied V1 body.
func (h *ConfigsHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req createReq
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.ID == "" || req.Config == nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "id and config are required", nil)
		return
	}
	data := fromV1(req.Config)
	if err := h.m.Create(req.ID, data); writeManagerError(w, err) {
		return
	}
	snap, fresh, _ := h.m.Get(req.ID, false)
	WriteJSON(w, http.StatusCreated, configEnvelope{Snapshot: snap, Config: toV1(fresh)})
}

// Update replaces the whole config body for an existing instance.
func (h *ConfigsHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	var body struct {
		Config *config.ClientConfigV1 `json:"config"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Config == nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "config is required", nil)
		return
	}
	data := fromV1(body.Config)
	if c := h.m.ValidateVisitorBinds(id, data); c != nil {
		writeVisitorConflict(w, c)
		return
	}
	if err := h.m.Update(id, data); writeManagerError(w, err) {
		return
	}
	snap, fresh, _ := h.m.Get(id, false)
	WriteJSON(w, http.StatusOK, configEnvelope{Snapshot: snap, Config: toV1(fresh)})
}

// Patch applies a JSON merge over the existing V1 body. The implementation
// is a simple "marshal current, merge into raw JSON, unmarshal back" round
// trip; it does not need to be field-aware.
func (h *ConfigsHandler) Patch(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	_, data, err := h.m.Get(id, false)
	if writeManagerError(w, err) {
		return
	}
	cur := toV1(data)
	curBytes, err := json.Marshal(cur)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, "marshal current: "+err.Error(), nil)
		return
	}
	patch, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "read body: "+err.Error(), nil)
		return
	}
	merged, err := mergeJSON(curBytes, patch)
	if err != nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "merge patch: "+err.Error(), nil)
		return
	}
	var next config.ClientConfigV1
	if err := json.Unmarshal(merged, &next); err != nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "decode merged: "+err.Error(), nil)
		return
	}
	if err := h.m.Update(id, fromV1(&next)); writeManagerError(w, err) {
		return
	}
	snap, fresh, _ := h.m.Get(id, false)
	WriteJSON(w, http.StatusOK, configEnvelope{Snapshot: snap, Config: toV1(fresh)})
}

// Delete stops and removes an instance.
func (h *ConfigsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	if err := h.m.Delete(id); writeManagerError(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Duplicate creates a copy under a new id supplied in the body.
func (h *ConfigsHandler) Duplicate(w http.ResponseWriter, r *http.Request) {
	src := pathID(r)
	var body struct {
		NewID string `json:"new_id"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.NewID == "" {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "new_id is required", nil)
		return
	}
	_, data, err := h.m.Get(src, false)
	if writeManagerError(w, err) {
		return
	}
	copied := data.Copy(true)
	if err := h.m.Create(body.NewID, copied); writeManagerError(w, err) {
		return
	}
	snap, fresh, _ := h.m.Get(body.NewID, false)
	WriteJSON(w, http.StatusCreated, configEnvelope{Snapshot: snap, Config: toV1(fresh)})
}

// GetRaw returns the on-disk TOML/INI bytes verbatim.
func (h *ConfigsHandler) GetRaw(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	b, err := h.m.ReadRaw(id)
	if writeManagerError(w, err) {
		return
	}
	w.Header().Set("Content-Type", "application/toml")
	_, _ = w.Write(b)
}

// PutRaw accepts a raw config body (TOML or legacy INI) and replaces the
// file on disk. The request must use Content-Type application/toml or
// text/plain.
func (h *ConfigsHandler) PutRaw(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "read body: "+err.Error(), nil)
		return
	}
	// Catch a hand-authored visitor port conflict before persisting. Parse
	// errors are left for WriteRaw to report (it re-parses and validates).
	if parsed, perr := config.UnmarshalClientConf(body); perr == nil {
		if c := h.m.ValidateVisitorBinds(id, parsed); c != nil {
			writeVisitorConflict(w, c)
			return
		}
	}
	if err := h.m.WriteRaw(id, body); writeManagerError(w, err) {
		return
	}
	snap, fresh, _ := h.m.Get(id, false)
	WriteJSON(w, http.StatusOK, configEnvelope{Snapshot: snap, Config: toV1(fresh)})
}

// Reorder persists the user's chosen display order.
func (h *ConfigsHandler) Reorder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Order []string `json:"order"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if err := h.m.Reorder(body.Order); err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, err.Error(), nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// mergeJSON applies an RFC 7396 merge-patch onto base. It only handles
// object-typed roots, which is all our config schema needs.
func mergeJSON(base, patch []byte) ([]byte, error) {
	var b, p map[string]any
	if err := json.Unmarshal(base, &b); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(patch, &p); err != nil {
		return nil, err
	}
	mergeMap(b, p)
	return json.Marshal(b)
}

func mergeMap(dst, src map[string]any) {
	for k, v := range src {
		if v == nil {
			delete(dst, k)
			continue
		}
		if sub, ok := v.(map[string]any); ok {
			if cur, ok2 := dst[k].(map[string]any); ok2 {
				mergeMap(cur, sub)
				continue
			}
		}
		dst[k] = v
	}
}
