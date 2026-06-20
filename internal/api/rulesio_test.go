package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mia-clark/frpc-manager/pkg/config"
)

// mustCreateStcpInstance creates a config "id" carrying one stcp proxy named
// "ssh" with a secretKey, so the rule-IO handlers have something pairable.
func mustCreateStcpInstance(t *testing.T, m interface {
	Create(id string, data *config.ClientConfig) error
}, id string) {
	t.Helper()
	body := []byte(`serverAddr = "127.0.0.1"
serverPort = 7000
user = "node-a"

[[proxies]]
name = "ssh"
type = "stcp"
secretKey = "topsecret"
localIP = "127.0.0.1"
localPort = 22
`)
	data, err := config.UnmarshalClientConf(body)
	if err != nil {
		t.Fatalf("UnmarshalClientConf: %v", err)
	}
	if err := m.Create(id, data); err != nil {
		t.Fatalf("Create %s: %v", id, err)
	}
}

func postJSON(t *testing.T, h http.HandlerFunc, id string, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/configs/"+id+"/proxies/x", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req = withPathID(req, id)
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

// TestRulesIO_ExportParseImportRoundTrip drives the three rule-IO handlers
// end-to-end against a real manager: export(portable) → parse → import the
// suggested pair visitor, then assert the config gained the new visitor.
func TestRulesIO_ExportParseImportRoundTrip(t *testing.T) {
	tmp := t.TempDir()
	m := newTestManager(t, tmp)
	mustCreateStcpInstance(t, m, "A")

	h := NewRulesIOHandler(m, testLogger())

	// --- 1) Export portable ---
	exRec := postJSON(t, h.Export, "A", map[string]any{"format": "portable", "kind": "all"})
	if exRec.Code != http.StatusOK {
		t.Fatalf("export: expected 200, got %d body=%s", exRec.Code, exRec.Body.String())
	}
	var exResp struct {
		Format       string `json:"format"`
		PortableJSON string `json:"portableJson"`
	}
	if err := json.Unmarshal(exRec.Body.Bytes(), &exResp); err != nil {
		t.Fatalf("decode export: %v", err)
	}
	if exResp.Format != "portable" {
		t.Fatalf("export format = %q", exResp.Format)
	}
	if !bytes.Contains([]byte(exResp.PortableJSON), []byte("frpcManagerExport")) {
		t.Fatalf("portableJson missing frpcManagerExport: %s", exResp.PortableJSON)
	}
	if !bytes.Contains([]byte(exResp.PortableJSON), []byte("topsecret")) {
		t.Fatalf("portableJson missing secretKey: %s", exResp.PortableJSON)
	}

	// --- 2) Parse that portable bundle ---
	paRec := postJSON(t, h.Parse, "A", map[string]any{"content": exResp.PortableJSON})
	if paRec.Code != http.StatusOK {
		t.Fatalf("parse: expected 200, got %d body=%s", paRec.Code, paRec.Body.String())
	}
	var paResp struct {
		DetectedFormat string `json:"detectedFormat"`
		Items          []struct {
			Name             string          `json:"name"`
			Kind             string          `json:"kind"`
			Pairable         bool            `json:"pairable"`
			SuggestedVisitor json.RawMessage `json:"suggestedVisitor"`
		} `json:"items"`
	}
	if err := json.Unmarshal(paRec.Body.Bytes(), &paResp); err != nil {
		t.Fatalf("decode parse: %v", err)
	}
	if paResp.DetectedFormat != "portable" {
		t.Fatalf("detectedFormat = %q", paResp.DetectedFormat)
	}
	if len(paResp.Items) != 1 {
		t.Fatalf("expected 1 item, got %d: %s", len(paResp.Items), paRec.Body.String())
	}
	it := paResp.Items[0]
	if !it.Pairable {
		t.Fatalf("item not pairable: %+v", it)
	}
	if len(it.SuggestedVisitor) == 0 || string(it.SuggestedVisitor) == "null" {
		t.Fatalf("suggestedVisitor empty: %s", string(it.SuggestedVisitor))
	}

	// --- 3) Import the suggested visitor directly ---
	// The target config already holds proxy "ssh", and apply keeps proxies and
	// visitors in one flat name space. Parse is now collision-aware: the
	// suggested visitor name must already have been bumped off "ssh" to
	// "ssh-visitor", so the default "create" action succeeds with no manual
	// rename. Decode the suggested visitor and import it as-is.
	var sv map[string]any
	if err := json.Unmarshal(it.SuggestedVisitor, &sv); err != nil {
		t.Fatalf("decode suggestedVisitor: %v", err)
	}
	if got := sv["name"]; got != "ssh-visitor" {
		t.Fatalf("suggestedVisitor name = %v, want collision-avoided %q", got, "ssh-visitor")
	}
	imRec := postJSON(t, h.Import, "A", map[string]any{
		"items": []map[string]any{
			{"kind": "visitor", "action": "create", "visitor": sv},
		},
	})
	if imRec.Code != http.StatusOK {
		t.Fatalf("import: expected 200, got %d body=%s", imRec.Code, imRec.Body.String())
	}
	var imResp struct {
		Applied int `json:"applied"`
		Failed  int `json:"failed"`
	}
	if err := json.Unmarshal(imRec.Body.Bytes(), &imResp); err != nil {
		t.Fatalf("decode import: %v", err)
	}
	if imResp.Applied != 1 {
		t.Fatalf("expected applied=1, got %+v body=%s", imResp, imRec.Body.String())
	}

	// --- 4) Assert the config now has the new visitor ---
	_, data, err := m.Get("A", false)
	if err != nil {
		t.Fatalf("Get A: %v", err)
	}
	var found *config.Proxy
	for _, p := range data.Proxies {
		if p.IsVisitor() && p.Name == "ssh-visitor" {
			found = p
			break
		}
	}
	if found == nil {
		t.Fatalf("imported visitor %q not found in config", "ssh-visitor")
	}
	if found.SK != "topsecret" || found.ServerName != "ssh" {
		t.Fatalf("imported visitor fields wrong: %+v", found)
	}
}

// TestRulesIO_ParseCrossKindConflict verifies Parse judges name conflicts off a
// single flat namespace over ALL rules (proxies + visitors), matching apply: a
// config holding a VISITOR named "v1" must flag an incoming PROXY named "v1" as
// conflicting, even though they are different kinds.
func TestRulesIO_ParseCrossKindConflict(t *testing.T) {
	tmp := t.TempDir()
	m := newTestManager(t, tmp)

	// Config "B" holds a visitor named "v1" (a stcp visitor for some server).
	body := []byte(`serverAddr = "127.0.0.1"
serverPort = 7000
user = "node-b"

[[visitors]]
name = "v1"
type = "stcp"
serverName = "remote-ssh"
secretKey = "topsecret"
bindAddr = "127.0.0.1"
bindPort = 6000
`)
	data, err := config.UnmarshalClientConf(body)
	if err != nil {
		t.Fatalf("UnmarshalClientConf: %v", err)
	}
	if err := m.Create("B", data); err != nil {
		t.Fatalf("Create B: %v", err)
	}

	h := NewRulesIOHandler(m, testLogger())

	// Parse a portable bundle that carries a PROXY also named "v1".
	bundle := `{
  "frpcManagerExport": "rules.v1",
  "proxies": [
    {"name": "v1", "type": "tcp", "localIP": "127.0.0.1", "localPort": 80}
  ]
}`
	paRec := postJSON(t, h.Parse, "B", map[string]any{"content": bundle})
	if paRec.Code != http.StatusOK {
		t.Fatalf("parse: expected 200, got %d body=%s", paRec.Code, paRec.Body.String())
	}
	var paResp struct {
		Items []struct {
			Name     string `json:"name"`
			Kind     string `json:"kind"`
			Conflict string `json:"conflict"`
		} `json:"items"`
	}
	if err := json.Unmarshal(paRec.Body.Bytes(), &paResp); err != nil {
		t.Fatalf("decode parse: %v", err)
	}
	if len(paResp.Items) != 1 {
		t.Fatalf("expected 1 item, got %d: %s", len(paResp.Items), paRec.Body.String())
	}
	item := paResp.Items[0]
	if item.Kind != "proxy" || item.Name != "v1" {
		t.Fatalf("unexpected item: %+v", item)
	}
	if item.Conflict != "name_exists" {
		t.Fatalf("cross-kind conflict not surfaced: conflict = %q, want %q (body=%s)",
			item.Conflict, "name_exists", paRec.Body.String())
	}
}
