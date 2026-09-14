package monitor

import (
	"errors"
	"testing"

	"github.com/nats-io/jsm.go/api"
	"github.com/nats-io/nats.go"
)

func TestValidateConnQuery(t *testing.T) {
	for _, c := range []struct {
		sort     string
		off, lim int
		wantErr  bool
	}{
		{"cid", 0, 50, false}, {"rtt", 100, 1024, false},
		{"subs", 0, 1, false}, {"pending", 0, 1024, false},
		{"msgs_to", 0, 50, false}, {"msgs_from", 0, 50, false},
		{"bytes_to", 0, 50, false}, {"bytes_from", 0, 50, false},
		{"last", 0, 50, false}, {"idle", 0, 50, false},
		{"uptime", 0, 50, false},
		{"", 0, 20, false},          // 空 → 默认 cid
		{"DROP TABLE", 0, 50, true}, // 白名单外
		{"cid", -1, 50, true},       // offset < 0
		{"cid", 0, 0, true},         // limit < 1
		{"cid", 0, 1025, true},      // limit > 1024
	} {
		err := ValidateConnQuery(c.sort, c.off, c.lim)
		if (err != nil) != c.wantErr {
			t.Errorf("ValidateConnQuery(%q,%d,%d) err=%v wantErr=%v", c.sort, c.off, c.lim, err, c.wantErr)
		}
	}
}

func TestEventSubjects(t *testing.T) {
	got, err := EventSubjects([]string{"account_connect", "js_advisory"}, "", "")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"$SYS.ACCOUNT.*.CONNECT", "$JS.EVENT.ADVISORY.>"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("subj[%d]=%q want %q", i, got[i], want[i])
		}
	}
	if _, err := EventSubjects([]string{"nope"}, "", ""); err == nil {
		t.Fatal("unknown type must fail")
	}
	// 域回退推导：prefix 为空 + domain="A" → $JS.A.EVENT.ADVISORY.>
	if got, _ := EventSubjects([]string{"js_advisory"}, "", "A"); got[0] != "$JS.A.EVENT.ADVISORY.>" {
		t.Fatalf("domain-derived prefix: %q", got[0])
	}
	// 显式 prefix 优先于 domain。
	if got, _ := EventSubjects([]string{"js_advisory"}, "$JS.B.EVENT", "A"); got[0] != "$JS.B.EVENT.ADVISORY.>" {
		t.Fatalf("explicit prefix wins: %q", got[0])
	}
	// js_metric 走 $JS.EVENT.METRIC 同款前缀推导。
	if got, _ := EventSubjects([]string{"js_metric"}, "$JS.B.EVENT", ""); got[0] != "$JS.B.EVENT.METRIC.>" {
		t.Fatalf("js_metric prefix: %q", got[0])
	}
	// auth_error / account_disconnect 闭集映射（与 prefix/domain 无关）。
	if got, err := EventSubjects([]string{"account_disconnect", "auth_error"}, "$JS.B.EVENT", "A"); err != nil ||
		got[0] != "$SYS.ACCOUNT.*.DISCONNECT" || got[1] != "$SYS.SERVER.*.CLIENT.AUTH.ERR" {
		t.Fatalf("sys types: %v %v", got, err)
	}
	// 去重保序：重复类型只产生一个 subject。
	if got, _ := EventSubjects([]string{"js_advisory", "js_advisory"}, "", ""); len(got) != 1 {
		t.Fatalf("dedupe: %q", got)
	}
}

func TestCompileEventRegex(t *testing.T) {
	if re, err := CompileEventRegex(""); err != nil || re != nil {
		t.Fatalf("empty must be nil,nil: %v %v", re, err)
	}
	if _, err := CompileEventRegex("("); err == nil {
		t.Fatal("bad regex must fail")
	}
	re, err := CompileEventRegex("^acct-.*$")
	if err != nil || re == nil {
		t.Fatalf("valid regex: %v %v", re, err)
	}
	if !re.MatchString("acct-42") {
		t.Fatal("compiled regex does not match")
	}
}

func TestClassifyMonitorError(t *testing.T) {
	res := ClassifyMonitorError(nats.ErrNoResponders)
	if res.ErrorCode != CodeServer || res.Error == "" {
		t.Fatalf("no-responders: %+v", res)
	}
	res = ClassifyMonitorError(errors.New("boom"))
	if res.ErrorCode != CodeServer {
		t.Fatalf("generic: %+v", res)
	}
	res = ClassifyMonitorError(nil)
	if !res.Ok() {
		t.Fatalf("nil must be ok: %+v", res)
	}
	// server.ApiError → server 码 + Description 原文。
	res = ClassifyMonitorError(api.ApiError{Code: 500, Description: "jetstream not enabled"})
	if res.ErrorCode != CodeServer || res.Error != "jetstream not enabled" {
		t.Fatalf("api error: %+v", res)
	}
	// 包装后的 ApiError 同样命中 errors.As 分支。
	res = ClassifyMonitorError(errors.Join(errors.New("ctx"), api.ApiError{Code: 503, Description: "unavailable"}))
	if res.ErrorCode != CodeServer || res.Error != "unavailable" {
		t.Fatalf("wrapped api error: %+v", res)
	}
	// 超时无独立错误码——并入 server（全局约束）。
	res = ClassifyMonitorError(errors.New("context deadline exceeded"))
	if res.ErrorCode != CodeServer || res.Error != "context deadline exceeded" {
		t.Fatalf("timeout folds into server: %+v", res)
	}
}

// TestClassifyMonitorErrorApiDescriptionFallback（M5 ③）：api.ApiError 的
// Description 为空串时回退 ae.Error()——该实现永不返回空（jsm.go
// api/jetstream.go:184-192），故映射结果永不产生空 error 文本；非空
// Description 原文直传（Global 4，不受 ErrCode 尾缀污染）。
func TestClassifyMonitorErrorApiDescriptionFallback(t *testing.T) {
	cases := []struct {
		ae   api.ApiError
		want string
	}{
		{api.ApiError{}, "unknown JetStream Error"},
		{api.ApiError{Code: 500}, "unknown JetStream 500 Error (0)"},
		{api.ApiError{Code: 503, ErrCode: 7}, "unknown JetStream 503 Error (7)"},
		// 非空 Description：原文直传（无 " (errcode)" 尾缀）。
		{api.ApiError{Code: 500, Description: "jetstream not enabled"}, "jetstream not enabled"},
	}
	for i, c := range cases {
		got := ClassifyMonitorError(c.ae)
		if got.ErrorCode != CodeServer || got.Error != c.want || got.Error == "" {
			t.Fatalf("case %d: got %+v, want error_code=server error=%q", i, got, c.want)
		}
	}
	// errors.As 包装路径同样吃到回退。
	got := ClassifyMonitorError(errors.Join(errors.New("ctx"), api.ApiError{Code: 500}))
	if got.ErrorCode != CodeServer || got.Error != "unknown JetStream 500 Error (0)" {
		t.Fatalf("wrapped empty-description api error: %+v", got)
	}
}
