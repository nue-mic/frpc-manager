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

	// --- 3) Import the suggested visitor ---
	// DerivePairVisitor mirrors the proxy name ("ssh"); since ApplyRuleImport
	// keeps proxies and visitors in one flat name space, give the visitor a
	// distinct name to avoid the (correct) "name already exists" rejection.
	// Round-trip through a generic map so the override goes through the same
	// camelCase wire shape the handler decodes.
	var sv map[string]any
	if err := json.Unmarshal(it.SuggestedVisitor, &sv); err != nil {
		t.Fatalf("decode suggestedVisitor: %v", err)
	}
	sv["name"] = "ssh-visitor"
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
