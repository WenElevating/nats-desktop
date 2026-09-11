package version

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"v1.0.0", "v1.0.1", -1},
		{"v1.2.0", "v1.10.0", -1},
		{"v2.0.0", "v1.9.9", 1},
		{"v1.0.0", "v1.0.0", 0},
		// Remaining scenarios: no/mixed "v" prefix, short forms, carry.
		{"1.0.0", "1.0.1", -1},  // no v prefix
		{"V1.0.0", "v1.0.0", 0}, // prefix is case-insensitive
		{"v1.0", "v1.0.0", 0},   // missing segment counts as 0
		{"v1.0.0", "v1.0", 0},
		{"v0.9.9", "v1.0.0", -1}, // carry across segments
		{"v10.0.0", "v9.0.0", 1}, // numeric, not lexicographic
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Fatalf("%s vs %s = %d want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestCheckLatestParsesRelease(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"tag_name": "v9.9.9", "html_url": "https://github.com/x/y/releases/v9.9.9"}`))
	}))
	defer srv.Close()
	got, err := CheckLatestAt(context.Background(), srv.URL, "v1.0.0") // CheckLatest 的可注入 URL 变体
	if err != nil || !got.HasUpdate || got.Latest != "v9.9.9" {
		t.Fatalf("%+v %v", got, err)
	}
	if got.Current != "v1.0.0" || got.URL != "https://github.com/x/y/releases/v9.9.9" {
		t.Fatalf("unexpected fields: %+v", got)
	}
}

func TestCheckLatestTimeoutIsSilentError(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	_, err := CheckLatestAt(ctx, "http://127.0.0.1:1", "v1.0.0")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestCheckLatestNoUpdateWhenNotNewer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"tag_name": "v1.0.0", "html_url": "https://github.com/x/y/releases/v1.0.0"}`))
	}))
	defer srv.Close()
	got, err := CheckLatestAt(context.Background(), srv.URL, "v1.0.0")
	if err != nil || got.HasUpdate {
		t.Fatalf("same version should not report update: %+v %v", got, err)
	}
	got, err = CheckLatestAt(context.Background(), srv.URL, "v2.3.4")
	if err != nil || got.HasUpdate {
		t.Fatalf("older remote should not report update: %+v %v", got, err)
	}
}

func TestCheckLatestNon200IsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound) // GitHub 404s when no releases exist yet
	}))
	defer srv.Close()
	if _, err := CheckLatestAt(context.Background(), srv.URL, "v1.0.0"); err == nil {
		t.Fatal("expected error for non-200 response")
	}
}

func TestCheckLatestBuildsGitHubAPIURL(t *testing.T) {
	want := "https://api.github.com/repos/WenElevating/nats-desktop/releases/latest"
	if got := apiURL("WenElevating/nats-desktop"); got != want {
		t.Fatalf("apiURL = %q want %q", got, want)
	}
}
