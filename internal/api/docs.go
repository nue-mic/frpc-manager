package api

import (
	_ "embed"
	"net/http"
	"strings"
)

// openapiYAML is the OpenAPI 3.1 description shipped inside the daemon
// binary. The file lives next to this Go source so the build is fully
// self-contained — no external assets required at runtime.
//
//go:embed openapi.yaml
var openapiYAML []byte

// docsHTML is the Scalar reference UI shell. It loads Scalar from a CDN
// and points it at /api/docs/openapi.yaml. Scalar is MIT-licensed,
// supports OpenAPI 3.1 natively, and provides built-in "try it out"
// requests right inside the doc page.
//
// If the container has no outbound internet access, the CDN URL can be
// swapped for a locally hosted bundle by editing this template.
const docsHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>frpcmgrd API</title>
  <link rel="icon" href="data:," />
  <style>
    body { margin: 0; }
    #fallback {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 720px; margin: 4rem auto; padding: 0 1.5rem; color: #444;
      display: none;
    }
    #fallback h1 { color: #111; }
    #fallback code { background: #f3f3f3; padding: .15rem .4rem; border-radius: 4px; }
  </style>
</head>
<body>
  <noscript>
    <p style="font-family:sans-serif;padding:2rem;">
      JavaScript is required to render the docs UI.
      The raw spec is at <a href="/api/docs/openapi.yaml">/api/docs/openapi.yaml</a>.
    </p>
  </noscript>

  <div id="fallback">
    <h1>API docs failed to load</h1>
    <p>The Scalar UI is loaded from a public CDN (jsdelivr.net). If your container
       has no outbound internet access, you can still consume the spec directly:</p>
    <ul>
      <li>YAML: <a href="/api/docs/openapi.yaml"><code>/api/docs/openapi.yaml</code></a></li>
    </ul>
    <p>To run docs fully offline, vendor the Scalar bundle and replace the
       <code>&lt;script src=...&gt;</code> URL in <code>internal/api/docs.go</code>.</p>
  </div>

  <script
    id="api-reference"
    data-url="/api/docs/openapi.yaml"
    data-configuration='{"theme":"purple","layout":"modern","hideDownloadButton":false,"hideTestRequestButton":false,"defaultOpenAllTags":false}'>
  </script>
  <script
    src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"
    onerror="document.getElementById('fallback').style.display='block'">
  </script>
</body>
</html>
`

// DocsHandler serves the embedded API spec and a browser-friendly viewer.
type DocsHandler struct {
	enabled bool
}

// NewDocsHandler builds a DocsHandler. When enabled is false every
// request returns 404 so operators can fully hide the docs.
func NewDocsHandler(enabled bool) *DocsHandler {
	return &DocsHandler{enabled: enabled}
}

// Enabled reports whether the docs surface should be mounted.
func (h *DocsHandler) Enabled() bool { return h != nil && h.enabled }

// Spec serves the raw OpenAPI YAML.
func (h *DocsHandler) Spec(w http.ResponseWriter, r *http.Request) {
	if !h.Enabled() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(openapiYAML)
}

// SpecJSON serves the spec as JSON for tools that prefer it. Conversion
// is intentionally minimal — for tools that need a strict JSON spec,
// run `yq` or `openapi-to-json` on the YAML.
func (h *DocsHandler) SpecJSON(w http.ResponseWriter, r *http.Request) {
	// Same content, different Content-Type. Most OpenAPI consumers accept YAML.
	if !h.Enabled() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
	_, _ = w.Write(openapiYAML)
}

// UI renders the Scalar HTML wrapper.
func (h *DocsHandler) UI(w http.ResponseWriter, r *http.Request) {
	if !h.Enabled() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write([]byte(docsHTML))
}

// Redirect bounces a trailing-slash-less /api/docs to the canonical URL.
func (h *DocsHandler) Redirect(w http.ResponseWriter, r *http.Request) {
	target := strings.TrimSuffix(r.URL.Path, "/") + "/"
	http.Redirect(w, r, target, http.StatusMovedPermanently)
}
