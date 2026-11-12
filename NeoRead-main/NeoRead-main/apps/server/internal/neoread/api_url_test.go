package neoread

import (
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
