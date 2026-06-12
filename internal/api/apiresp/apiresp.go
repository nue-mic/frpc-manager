// Package apiresp holds the shared JSON response helpers and error codes
// used by both api handlers and middleware. It lives in its own package
// to avoid an import cycle between api and api/middleware.
package apiresp

import (
	"encoding/json"
	"net/http"
)

// ErrorCode is a stable, machine-readable identifier for an API error.
type ErrorCode string

const (
	CodeBadRequest      ErrorCode = "bad_request"
	CodeUnauthorized    ErrorCode = "unauthorized"
	CodeForbidden       ErrorCode = "forbidden"
	CodeNotFound        ErrorCode = "not_found"
	CodeConflict        ErrorCode = "conflict"
	CodeValidation      ErrorCode = "validation_failed"
	CodeInternal        ErrorCode = "internal_error"
	CodeConfigNotFound  ErrorCode = "config_not_found"
	CodeConfigExists    ErrorCode = "config_already_exists"
	CodeInvalidState    ErrorCode = "invalid_state"
	CodeProxyNotFound   ErrorCode = "proxy_not_found"
	CodeProxyExists     ErrorCode = "proxy_already_exists"
	CodeUpstreamFailure ErrorCode = "upstream_failure"
	// CodeVisitorPortConflict means another instance's visitor of the same
	// protocol family already listens on the same bindAddr:bindPort.
	CodeVisitorPortConflict ErrorCode = "visitor_port_conflict"
)

// Envelope is the JSON shape returned for any error response.
type Envelope struct {
	Error Body `json:"error"`
}

// Body carries the payload of an error envelope.
type Body struct {
	Code    ErrorCode      `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// JSON writes v as a JSON response with the given status.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	_ = json.NewEncoder(w).Encode(v)
}

// Error writes a structured error response.
func Error(w http.ResponseWriter, status int, code ErrorCode, message string, details map[string]any) {
	JSON(w, status, Envelope{Error: Body{Code: code, Message: message, Details: details}})
}
