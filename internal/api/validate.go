package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/pelletier/go-toml/v2"

	"github.com/nue-mic/frpc-manager/pkg/config"
)

// ValidateHandler serves POST /api/v1/validate. It accepts either JSON
// (Content-Type application/json) carrying a ClientConfigV1 body, or raw
// TOML/INI bytes (any other Content-Type).
type ValidateHandler struct{}

// NewValidateHandler builds a ValidateHandler.
func NewValidateHandler() *ValidateHandler { return &ValidateHandler{} }

type validateResp struct {
	Valid  bool     `json:"valid"`
	Errors []string `json:"errors,omitempty"`
}

// Validate parses and validates a config without persisting it.
func (h *ValidateHandler) Validate(w http.ResponseWriter, r *http.Request) {
	ct := r.Header.Get("Content-Type")
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "read body: "+err.Error(), nil)
		return
	}

	if strings.Contains(ct, "application/json") {
		converted, cerr := jsonBodyToTOML(body)
		if cerr != nil {
			WriteJSON(w, http.StatusOK, validateResp{Valid: false, Errors: []string{cerr.Error()}})
			return
		}
		body = converted
	}

	if _, err := config.UnmarshalClientConf(body); err != nil {
		WriteJSON(w, http.StatusOK, validateResp{Valid: false, Errors: []string{err.Error()}})
		return
	}
	WriteJSON(w, http.StatusOK, validateResp{Valid: true})
}

// jsonBodyToTOML pivots a JSON ClientConfigV1 through the parser stack
// and re-emits TOML so it can flow through UnmarshalClientConf.
func jsonBodyToTOML(b []byte) ([]byte, error) {
	var v config.ClientConfigV1
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, err
	}
	// Re-marshal via the V1 type which has the right TOML tags.
	return toml.Marshal(&v)
}
