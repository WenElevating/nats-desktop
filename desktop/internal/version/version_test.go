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

// TestCurrentDefaultNotInjected: 无 ldflags 注入时 Current 返回包内默认值。
// appVersion 必须是 var（可被 -X 注入），本测试锁定默认值不被意外改动。
func TestCurrentDefaultNotInjected(t *testing.T) {
	if got := Current(); got != "0.1.0" {
		t.Fatalf("default appVersion = %q, want 0.1.0 (bump via ldflags, not source)", got)
	}
}

// TestCompareVersionsSemantics: 边界语义按现有实现锁定——等长/不等长（缺失段
// 计 0）/前导零/预发布后缀段（非数字计 0，即被忽略）。改动比较语义时本表必须
// 显式修订，不得顺手变更。
func TestCompareVersionsSemantics(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"v1.2.3", "v1.2.3", 0},       // 等长等值
		{"v1.2", "v1.2.0", 0},         // 不等长：缺失尾段计 0
		{"v1.2.0.0", "v1.2", 0},       // 多余尾段全 0 亦等值
		{"v01.02.03", "v1.2.3", 0},        // 前导零按十进制解析
		{"v1.0.0-rc", "v1.0.0", 0},        // 非数字段计 0（后缀本身忽略）
		{"v1.0.0-rc.1", "v1.0.0", 1},      // 实现锁定：后缀点后的数字段仍参与比较
		{"v1.0.0-rc.1", "v1.0.0-rc.2", -1}, // 同上：rc.1 < rc.2
		{"v1.0.0-rc.1", "v1.0.1", -1},     // 前三段仍主导序
		{"", "v0.0.1", -1},            // 空串 → 全 0 段（splitSegments nil 分支）
		{" v1.0.0 ", "v1.0.0", 0},     // 空白剥离
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Fatalf("CompareVersions(%q,%q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

// TestCheckLatestContextCancelIsError: 已取消 ctx + 慢响应 → 立即返回 cancelled
// 类错误，不 panic、不等待慢响应完成（§6.13 失败静默半边的前提）。
func TestCheckLatestContextCancelIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.Write([]byte(`{"tag_name": "v9.9.9"}`))
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // 调用前即取消：传输层确定性失败
	if _, err := CheckLatestAt(ctx, srv.URL, "v1.0.0"); err == nil {
		t.Fatal("cancelled context must surface as error")
	}
}

// TestCheckLatestEmptyTagIsError: 200 但缺 tag_name → 显式错误（此前未覆盖分支）；
// 非 JSON body → 解码错误。二者都不得产出零值 UpdateInfo。
func TestCheckLatestEmptyTagIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"html_url": "https://github.com/x/y"}`))
	}))
	defer srv.Close()
	if info, err := CheckLatestAt(context.Background(), srv.URL, "v1.0.0"); err == nil {
		t.Fatalf("missing tag_name must error, got %+v", info)
	}

	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`not json`))
	}))
	defer srv2.Close()
	if info, err := CheckLatestAt(context.Background(), srv2.URL, "v1.0.0"); err == nil {
		t.Fatalf("bad body must error, got %+v", info)
	}
}

// TestServiceFacadeDefaults: facade 的 AppVersion 直通 Current；CheckTimeout
// 暴露 5s 上限供调用方对齐（§6.13）。
func TestServiceFacadeDefaults(t *testing.T) {
	s := NewService()
	if s.AppVersion() != Current() {
		t.Fatalf("AppVersion = %q, want Current() = %q", s.AppVersion(), Current())
	}
	if got := CheckTimeout(); got != 5*time.Second {
		t.Fatalf("CheckTimeout = %v, want 5s", got)
	}
}
