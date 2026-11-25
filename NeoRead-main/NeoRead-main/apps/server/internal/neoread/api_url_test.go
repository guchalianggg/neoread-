package neoread

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAPIURLHTTPAndHTTPS(t *testing.T) {
	for _, address := range []string{
		"https://gateway.example/v1",
		"http://gateway.example:8080/v1",
		"http://192.168.1.20:8000/v1",
		"http://[2001:db8::1]:8000/v1",
		"http://localhost:1234/v1",
		"http://127.0.0.1:1234/v1",
		"http://[::1]:1234/v1",
	} {
		t.Run(address, func(t *testing.T) {
			if err := validateAPIURL(address); err != nil {
				t.Fatal("valid HTTP(S) endpoint rejected:", err)
			}
		})
	}
	for _, address := range []string{
		"", "gateway.example/v1", "//gateway.example/v1",
		"ftp://gateway.example/v1", "file:///v1", "javascript:alert(1)",
		"http://:8080/v1", "https://:8080/v1",
		"http://user:password@gateway.example/v1",
		"https://user:password@gateway.example/v1",
		"http://gateway.example/v1?token=test", "https://gateway.example/v1#fragment",
		"http://localhost:1234/v1?", "https://localhost:1234/v1#",
	} {
		t.Run(address, func(t *testing.T) {
			if validateAPIURL(address) == nil {
				t.Fatal("invalid endpoint accepted")
			}
		})
	}
}

func TestHTTPAPISettingsPersistAllConnections(t *testing.T) {
	for _, protocol := range []string{"openai", "responses", "anthropic"} {
		t.Run(protocol, func(t *testing.T) {
			s := testServer(t)
			config := AIConfig{
				Primary:   "api",
				API:       APIConnection{URL: "http://gateway.example:8080/v1", Protocol: protocol, Key: "fixture-only-key"},
				TextAPI:   APIConnection{URL: "http://192.168.1.20:8000/v1", Protocol: protocol, Model: "text-test", Key: "fixture-only-key"},
				ImageAPI:  APIConnection{URL: "http://vision.example:8001/v1", Protocol: protocol, Model: "vision-test", Key: "fixture-only-key"},
				WebSearch: &WebSearchConfig{Provider: "deepseek", URL: "http://search.example:8080/v1", Key: "fixture-only-key"},
			}
			for round := 0; round < 2; round++ {
				response := request(t, s, "PUT", "/api/ai/config", strings.NewReader(jsonText(config)))
				if response.Code != 200 {
					t.Fatalf("HTTP configuration rejected: status %d", response.Code)
				}
				if strings.Contains(response.Body.String(), "fixture-only-key") {
					t.Fatal("save response exposed a key")
				}
				saved := s.aiConfig()
				for _, connection := range []APIConnection{saved.API, saved.TextAPI, saved.ImageAPI} {
					if !strings.HasPrefix(connection.URL, "http://") || connection.Key != "fixture-only-key" || connection.Protocol != protocol {
						t.Fatal("HTTP address/protocol/key changed during save")
					}
				}
				if !webSearchEnabled(saved, "api") || saved.WebSearch.Key != "fixture-only-key" {
					t.Fatal("HTTP search service not enabled or key lost")
				}
				config = publicConfig(saved)
			}
		})
	}
}

func TestHTTPAPIModelListProbeAndGeneration(t *testing.T) {
	const key = "fixture-only-key"
	const model = "fixture-model"
	const prefix = "/gateway/v1"
	for _, tc := range []struct{ protocol, path string }{
		{"openai", "/chat/completions"},
		{"responses", "/responses"},
		{"anthropic", "/messages"},
	} {
		t.Run(tc.protocol, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.protocol == "anthropic" {
					if r.Header.Get("x-api-key") != key || r.Header.Get("anthropic-version") != "2023-06-01" || r.Header.Get("Authorization") != "" {
						w.WriteHeader(http.StatusUnauthorized)
						return
					}
				} else if r.Header.Get("Authorization") != "Bearer "+key {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				if r.Method == "GET" && r.URL.Path == prefix+"/models" {
					io.WriteString(w, `{"data":[{"id":"fixture-model"}]}`)
					return
				}
				var payload struct {
					Model  string `json:"model"`
					Stream bool   `json:"stream"`
				}
				if r.Method != "POST" || r.URL.Path != prefix+tc.path || json.NewDecoder(r.Body).Decode(&payload) != nil || payload.Model != model || !payload.Stream {
					t.Errorf("unexpected request: %s %s, payload %+v", r.Method, r.URL.Path, payload)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				switch tc.protocol {
				case "anthropic":
					io.WriteString(w, anthropicTestWire("NEOREAD_OK"))
				case "responses":
					io.WriteString(w, responsesTestWire("NEOREAD_OK"))
				default:
					writeAPIReply(w, "NEOREAD_OK")
				}
			}))
			t.Cleanup(upstream.Close)
			s := testServer(t)
			config := AIConfig{Primary: "api", API: APIConnection{URL: upstream.URL + prefix + "/", Protocol: tc.protocol, Key: key}}
			if got := request(t, s, "PUT", "/api/ai/config", strings.NewReader(jsonText(config))); got.Code != 200 {
				t.Fatalf("save HTTP connection: %d %s", got.Code, got.Body)
			}
			listed := request(t, s, "GET", "/api/ai/models?provider=api", nil)
			var models []AgentModel
			if listed.Code != 200 || json.Unmarshal(listed.Body.Bytes(), &models) != nil || len(models) != 1 || models[0].ID != model {
				t.Fatalf("list HTTP models: %d %s", listed.Code, listed.Body)
			}
			checked := request(t, s, "POST", "/api/ai/test/api?capability=text&model="+model, nil)
			var cap Capability
			if checked.Code != 200 || json.Unmarshal(checked.Body.Bytes(), &cap) != nil || !cap.Text {
				t.Fatalf("probe HTTP model: %d %s", checked.Code, checked.Body)
			}
			result, err := s.apiAgentAdapter(s.aiConfig(), taskChat).Stream(t.Context(), GenerateRequest{AIInput{Prompt: "fixture prompt"}}, nil)
			if err != nil || result.Text != "NEOREAD_OK" {
				t.Fatalf("generate over HTTP: %q, %v", result.Text, err)
			}
		})
	}
}

func TestHTTPSAPIRejectsUntrustedCertificate(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("request reached untrusted HTTPS endpoint")
	}))
	t.Cleanup(upstream.Close)
	if _, err := discoverAPIModels(t.Context(), APIConnection{URL: upstream.URL + "/v1", Key: "fixture-only-key"}); err == nil || errorKind(err) != ErrorNetwork {
		t.Fatalf("untrusted HTTPS certificate was not rejected as a network error: %v", err)
	}
}
