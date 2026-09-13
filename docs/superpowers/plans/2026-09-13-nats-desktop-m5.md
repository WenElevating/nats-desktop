# NATS 桌面客户端 M5（服务器监控 + 集群运维 + Dashboard）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 M5 里程碑：监控页全量（服务器表 + 节点报表 + top 式连接明细含断开 + 系统事件流 + 账户统计 + 实时刷新）、集群危险操作区（meta/stream 双层的 step-down / peer-remove / balance，二级确认 + 单飞互斥）、Dashboard 总览页（§6.5，卡片组 + 最近 advisory 100 条 + RTT），外加归档遗留：M2 的 trace 集群测试、M3 的「集群运维入口」（StreamDetail 挂 §6.11 操作）、M4 的 kv 前端覆盖率整改（68.03%→≥70%）。

**Architecture:** Go 侧新增 `internal/monitor` 包，全部数据面走 **jsm.go `serverdata.Live`**（`$SYS.REQ.SERVER.PING[.VARZ/.CONNZ/.JSZ/.HEALTHZ]` 广播 + `$SYS.REQ.SERVER.<name>.<ENDPOINT>` 定向，snappy/无响应者语义内建）；管理面（step-down/peer-remove/balance）走 **jsm.go Manager + balancer**（与 natscli 同款调用）；事件流走**私有重声明的 watchRegistry**（M4 模式：4096 有界队列丢最旧计数 + 单发射 goroutine + 长生命周期 cancel ctx）。轮询在 **Go 侧 ticker**（`StartMonitoring/StopMonitoring` 由前端按可见性驱动，每周期 emit `monitor:snapshot`——§8.5.1 事件契约原文），已知服务器集合跨周期 diff 实现**离线标红**。前端新增 `features/monitoring/` 与 `features/dashboard/`，虚拟列表 + 排序 + L1/L2 确认复用既有 primitives。

**Tech Stack:** 沿用 M1–M4（Wails v3.0.0-beta.20、Go 1.26、React 18 + TS + Vite、Tailwind v4、shadcn、lucide、zod、vitest ^5、@tanstack/react-virtual）。**Go 零新增依赖**（jsm.go/balancer、nats-server/v2 server 类型已是 direct 依赖）；前端零新增依赖。

**规格依据:** `docs/superpowers/specs/2026-09-11-nats-desktop-v1-spec.md`（v1.1）§6.5（Dashboard 总览——此前未分配里程碑，随监控数据面一并交付，M6 只留打包/长稳）、§6.10（服务器监控）、§6.11（集群运维）、§6.4（事件洪水复用推送与缓冲规则）、§6.12（确认策略）、§8.3/§8.3.1（$SYS 主题与权限降级）、§8.5（事件契约：监控快照）、§11/§12/§13/§18；AC-015（监控页与多节点）、AC-016（系统事件流）、AC-017（集群危险操作）、AC-029（UIA 冒烟口径延续）。归档遗留并入：M2 验收 §6 第 3 条（trace 集群测试）、M3 验收「§6.6 集群运维入口归 M5」、M4 验收遗留清单第 1 条（kv 前端覆盖率）。

## Global Constraints

来自规格 v1.1 与既有里程碑裁定的硬约束（值逐字取自规格/验收记录）：

1. **监控轮询契约（§6.10 + §6.5 + §8.5.1）**：轮询间隔取设置 `poll_interval_seconds`（2–60s，默认 5s）；「轮询周期到达**且窗口可见**时重新请求」——前端 visibilitychange 驱动 `StartMonitoring/StopMonitoring`（hidden→停，visible→启动并**立即执行一次刷新**）；页面内另有暂停开关（会话态，不持久化）。监控快照经事件 `monitor:snapshot` 每周期推送（§8.5.1「监控快照 | 轮询聚合结果 | 每个轮询周期」），另提供 `GetMonitoringSnapshot` 一次性绑定供首屏。Go ticker 循环**单飞**（上一周期未完成则跳过本次 tick）。
2. **节点级失败隔离（§6.10 异常表）**：「当某节点请求超时（2s）时，系统必须将该节点标记为离线（红色状态），其余节点数据正常展示与刷新」——snapshot 请求固定 2s 超时（不随设置变）；已知服务器集合跨周期 diff，应答者更新、已知但未应答者 `online=false` 标红并保留上一轮数据、重新应答则恢复在线；新增服务器即时加入。离线行显示最近错误原因。
3. **$SYS 权限降级（§8.3.1 + §6.5 异常表）**：「系统账户未开启/无权限 → 请求无响应（2s 超时），监控区显示『无系统监控权限』说明」——无响应者错误（jsm.go DoReq 原文含 "ensure the account used has system privileges"）时 snapshot 置 `sys_available=false` + 原文 reason，**不是 error_code**；「部分主题无权限 → 被拒绝的报表隐藏并说明，其余正常」——connz/healthz 等定向请求失败时该子面板显示原文错误，其余面板不受影响。
4. **kick 断开连接（§6.10）**：「当 kick 操作被拒绝时，系统必须显示服务器错误原文」；kick 为**一级确认**（L1）。被断开的连接是用户自己的连接时报错同样原文透传。
5. **事件洪水（§6.10 异常表 + §6.4 缓冲规则）**：「当事件速率过高时，系统必须复用 §6.4 推送模式与缓冲规则，界面保持可用」——复用 M4 watch 语义：每 watcher 4096 有界队列满则**丢最旧 + 原子计数**、每条事件捎带 `dropped_total`、每 4096 次丢弃一条 WARN；前端环形保留最近 **10,000** 条（§6.4 同值）；订阅 ctx 为**长生命周期 cancel ctx，绝不带超时**（M4 裁定：`nats.Context(ctx)` 随超时静默注销订阅）；断连全停（`NotifyConnState` 非 connected → 停 ticker + 停全部事件 watcher，对齐 M4 watch 断连全停）。正则过滤在 Go 侧 ingest 应用，被过滤事件计 `filtered_total`（与背压丢弃分开计数）。
6. **危险操作契约（§6.11，全部二级确认）**：「展示二级确认对话框：说明操作影响范围（如触发重新选举、副本迁移时长提示）」+「用户输入目标资源名称确认 → 执行」；「名称不匹配 → 当输入名称与目标不一致时，系统必须拒绝执行并保持对话框」；「操作进行中重复触发 → 当同一目标操作尚在执行时，系统必须禁用触发入口并显示进行中标识」——Go 侧 per `op+target` CAS 单飞，竞态冲突返回 **error_code `conflict`**（M4 引入的闭集成员），前端进行中禁用按钮 + spinner。闭集照抄 M4：`not_connected`/`js_unavailable`/`not_found`/`validation`/`server`/`cancelled`/`conflict`（monitor 包不产 `js_unavailable`，沿用其余）。
7. **危险区视觉（§18.4）**：「危险操作」区**红色呈现并与常规按钮分离**；lucide SVG 禁 emoji（延续）；集群操作按钮用 `TriangleAlert` 系图标 + danger 色。
8. **meta 层域守卫（natscli parity，逐字语义）**：`MetaStepDown`/`MetaPeerRemove` 在活跃 context 配置了 `js_domain` 或 `js_api_prefix` 时返回 `validation` 错误并附 natscli 同义说明（"JetStream domains do not apply to the system account, connect without a domain configured"）——防止把 step-down 发到 domain 前缀主题（系统账户无响应者）。stream 层操作走正常 domain 感知 handles（stream API 本就按域路由）。
9. **事件/监控载荷不入日志（§13.3 延续）**：advisory 事件**载荷内容**（_disconnect 事件的 client 详情、JS advisory JSON）不入日志——日志只记 subject、字节数、来源服务器、丢弃计数；connz 行日志只记 server+cid，**不记用户名/JWT/TLS 证书字段**（ConnInfo.JWT 绝不落日志）；凭证不入日志（延续）。UI 展示不受限（事件摘要/连接表照常显示）。
10. **事件类型闭集（§6.10 输入）**：事件类型过滤为闭集多选：`account_connect`（`$SYS.ACCOUNT.*.CONNECT`）、`account_disconnect`（`$SYS.ACCOUNT.*.DISCONNECT`）、`auth_error`（`$SYS.SERVER.*.CLIENT.AUTH.ERR`）、`js_advisory`、`js_metric`。JS 事件前缀解析（natscli parity，修正：natscontext `JSEventPrefix()` 是**字面配置字段** `jetstream_event_prefix`，非 domain 派生）：优先取该字段；为空且 `js_domain` 非空时回退 `"$JS."+domain+".EVENT"`（服务器域部署的事件主题面）；两者皆空用默认。最终 `jsm.EventSubject(api.JSAdvisoryPrefix|api.JSMetricPrefix, prefix) + ".>"`（EventSubject 语义：把主题的 `$JS.EVENT` 前缀替换为 prefix）。正则为 Go `regexp` 语法，匹配 **subject**，编译失败 → `validation` 内联定位。
11. **connz 排序闭集**：排序键白名单 = nats-server `SortOpt` 子集：`cid`/`subs`/`pending`/`msgs_to`/`msgs_from`/`bytes_to`/`bytes_from`/`last`/`idle`/`uptime`/`rtt`（默认 `cid`）；offset≥0、limit 1–1024（nats-server `DefaultConnListSize=1024`）。zod 同规则，枚举显式值禁空串（M3 Global 11 延续）。
12. **JS 角色映射（AC-015「JS 角色」列）**：`disabled`（jsz `Disabled` 或无 jsz 应答且 statsz 无 JS）/ `meta_leader`（本机名 == Meta.Leader）/ `voter`（Meta 非空但非 leader）/ `""` 未知。单节点无 Meta 时：JS 启用 → `voter` 不合适 → 用 `meta_leader` 仅当 Meta 非空，否则 `""`（UI 显示 `-`）。
13. **性能与规模（§12 精神，诚实口径）**：单次 $SYS 广播 ≤2s（DoReq 内部 ctx 截止即上限）；快照周期 = statsz + jsz 两个串行广播，**健康 3 节点实测记录（预期 <600ms）、降级最坏 ~4.3s**（两个 2s 广播先后超时；jsz 失败被容忍不影响可用性判据）；周期必须 ≤ `poll_interval`（interval 2s 时靠 runCycle 单飞跳过重叠 tick）；50 行服务器表渲染虚拟化；事件洪峰 10k 条 ingest（含正则过滤）<1s 且零丢失（消费速率下）、`dropped_total`/`filtered_total` 精确（Task 7 合成 ingest 测试断言）；连接表 1,024 行分页排序 ≤500ms（高配门）。
14. **真服务器测试（用户指令延续）**：LocalServer（nats://127.0.0.1:4333，2s 探测 skip）+ 内嵌双路径；`<Area><Behavior>LocalServer` 命名。**集群用例为内嵌专属**（LocalServer 单节点）；3 节点内嵌集群夹具（系统账户 + JS + 路由 mesh）为 Task 1 交付物；Windows 上跑（既有 testutil 不 skip Windows 的约定延续，超时放宽：路由成型 ≤10s、meta 选举 ≤30s、step-down 新 leader ≤15s）。
15. **i18n（AC-021）**：新增 `monitor.*`、`dashboard.*`、`clusterOps.*` 命名空间 en/zh-CN 双侧同步（完整性门禁测试强制 key 集逐字相同）。
16. **UI 规范（§18 延续）**：数字列等宽字体 + `tabular-nums`；表头可排序（点击切换 asc/desc——服务器表与连接明细表同机制，不用下拉）；失败 toast + 可展开原文；空态引导；主题三态；危险区红色分离。
17. **依赖**：Go 零新增（`github.com/nats-io/jsm.go/balancer`、`serverdata`、`api`、nats-server/v2 `server` 类型均已在 go.mod direct）；前端零新增。
18. **M4 遗留整改并入（验收记录 §6 第 1 条）**：features/kv 覆盖率 68.03% → ≥70%（BucketForm 35% / KeyValuePage 60.6% / schema 56.5% 三处为主），Task 14 交付。
19. **绑定约定（M4 实际惯例延续，修正）**：所有新绑定**单结构体返回**（CallResult 内嵌），绝不双返回值（Wails 序列化为 JSON 数组破坏前端消费模式）。**生成的 bindings 树是提交物**（`frontend/bindings/github.com/.../internal/<pkg>/*.ts` 已提交 22 文件、CI 不 regen、`src/lib/bindings.ts` 从其 re-export——头注释明文）——Task 9 regen 后把 monitor 的新生成文件**一并提交**，可空字段按既有 null-guard 惯例适配（9207fd3 风格），`src/lib/bindings.ts` 增加 re-export。
20. **发射 goroutine 防 panic（M3/M4 约定延续）**：snapshot ticker 循环与事件发射 goroutine 带 `defer/recover`，recover 后 `s.log.Error` 记栈并继续（不 os.Exit——对齐 M4 终审 4a7d7cd 后的防御口径）。

---

### Task 1: testutil 三节点集群夹具与系统账户单节点夹具

**Files:**
- Create: `desktop/internal/testutil/cluster.go`
- Test: `desktop/internal/testutil/cluster_test.go`

**Interfaces:**
- Produces（后续任务全部依赖）:
  - `type SysServer struct { URL string; SysUser, SysPass, AppUser, AppPass string; SysAcc, AppAcc *server.Account; Srv *server.Server }`
  - `func StartSysServer(t *testing.T) SysServer` — 单节点、系统账户开启（SYS 账户 + sys/app 双用户）
  - `type ClusterNode struct { Name, URL string; Srv *server.Server; Opts *server.Options }`
  - `type Cluster struct { Nodes []ClusterNode; SysUser, SysPass, AppUser, AppPass string }`
  - `func StartCluster(t *testing.T, n int) Cluster` — n 节点 JS 集群（TEST 集群名、系统账户、路由 mesh 成型、meta leader 选举完成才返回）
  - `func ConnectUser(t *testing.T, url, user, pass string) *nats.Conn`

- [ ] **Step 1: 写失败测试**

`desktop/internal/testutil/cluster_test.go`：

```go
package testutil

import (
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// 系统账户单节点：sys 用户可达 $SYS.REQ.SERVER.PING；app 用户请求无响应（超时）。
func TestStartSysServerPermissions(t *testing.T) {
	f := StartSysServer(t)

	sysNc := ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	if _, err := sysNc.Request("$SYS.REQ.SERVER.PING", nil, 2*time.Second); err != nil {
		t.Fatalf("sys user should reach $SYS.REQ.SERVER.PING: %v", err)
	}

	appNc := ConnectUser(t, f.URL, f.AppUser, f.AppPass)
	if _, err := appNc.Request("$SYS.REQ.SERVER.PING", nil, 2*time.Second); err == nil {
		t.Fatal("app user must not reach $SYS.REQ.SERVER.PING")
	}

	// 断连 advisory 在系统账户可见（AC-016 前置）：订阅后关一条 app 连接。
	sub, err := sysNc.Subscribe("$SYS.ACCOUNT.*.DISCONNECT", func(m *nats.Msg) {
		t.Logf("advisory on %s (%d bytes)", m.Subject, len(m.Data))
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := sysNc.Flush(); err != nil {
		t.Fatal(err)
	}
	appNc.Close()
	// advisory 由服务器异步发布；给足窗。
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if n, _, _ := sub.Pending(); n > 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("no disconnect advisory observed on $SYS.ACCOUNT.*.DISCONNECT")
}

// 三节点集群：路由成型（活跃服务器数 3）、JS meta leader 选举完成。
func TestStartClusterFormation(t *testing.T) {
	c := StartCluster(t, 3)

	sysNc := ConnectUser(t, c.Nodes[0].URL, c.SysUser, c.SysPass)
	defer sysNc.Close()

	resp, err := sysNc.Request("$SYS.REQ.SERVER.PING", nil, 2*time.Second)
	if err != nil {
		t.Fatalf("cluster ping: %v", err)
	}
	t.Logf("ping response %d bytes", len(resp.Data))

	// 3 节点各自都应答（广播计数由 monitor 任务断言；此处只验证夹具可答）。
	if len(c.Nodes) != 3 {
		t.Fatalf("want 3 nodes, got %d", len(c.Nodes))
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd desktop && go test ./internal/testutil/ -run 'TestStart' -v -count=1`
Expected: FAIL，`undefined: StartSysServer`（编译失败即红灯）。

- [ ] **Step 3: 实现夹具**

`desktop/internal/testutil/cluster.go`：

```go
package testutil

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"testing"
	"time"

	"github.com/nats-io/jsm.go/serverdata"
	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// ---------------------------------------------------------------------------
// 集群/系统账户夹具（M5）。既有单节点夹具（server.go）不开启系统账户，
// 无法验证 $SYS 权限降级与 advisory 事件流；本文件补齐：
//   - StartSysServer: 单节点 + SYS/APP 双账户 + 系统账户接线（sys 用户可
//     访问 $SYS、app 用户不可——§8.3.1 降级路径与 AC-016 的夹具基础）。
//   - StartCluster: n 节点 JS 集群（Cluster.Port=-1 随机；Start() 把解析后
//     的真实端口写回 opts——boot 就绪等待保证写回完成），路由指向
//     首节点、mesh 自动成型；等待 meta leader 选举完成后返回。
// 端口/选举等待在 Windows 上放宽（Global 14）。
// ---------------------------------------------------------------------------

const (
	clusterName = "TEST"
	sysUser     = "sys"
	sysPass     = "syspass"
	appUser     = "app"
	appPass     = "apppass"
)

// sysAccounts 构造 SYS/APP 双账户与双用户；账户与用户在所有节点上一致，
// 使系统账户事件与 JS 元数据跨节点可用。
func sysAccounts() ([]*server.Account, []*server.User) {
	accs := []*server.Account{{Name: "SYS"}, {Name: "APP"}}
	users := []*server.User{
		{Username: sysUser, Password: sysPass, Account: accs[0]},
		{Username: appUser, Password: appPass, Account: accs[1]},
	}
	return accs, users
}

type SysServer struct {
	URL                    string
	SysUser, SysPass       string
	AppUser, AppPass       string
	SysAcc, AppAcc         *server.Account
	Srv                    *server.Server
}

// StartSysServer 启动带系统账户的单节点（JS 开启、随机端口、StoreDir 在
// t.TempDir()）。返回后 sys 用户即可请求 $SYS、订阅 advisory。
func StartSysServer(t *testing.T) SysServer {
	t.Helper()
	accs, users := sysAccounts()
	opts := &server.Options{
		Port:          -1,
		ServerName:    "TEST_SYS",
		StoreDir:      t.TempDir(),
		JetStream:     true,
		Accounts:      accs,
		SystemAccount: "SYS",
		Users:         users,
	}
	srv, err := server.NewServer(opts)
	if err != nil {
		t.Fatal(err)
	}
	go srv.Start()
	if !srv.ReadyForConnections(10 * time.Second) {
		t.Fatal("sys server not ready")
	}
	t.Cleanup(srv.Shutdown)
	// NewServer 会把 opts.Accounts 的每个账户浅拷贝为服务器内部新对象，
	// opts 侧指针随即失效（server.go:1290-1310 注释明文）——对账户做运行时
	// 变更（如 AddMapping）必须拿 LookupAccount 返回的**活**对象。
	sysAcc, err1 := srv.LookupAccount("SYS")
	appAcc, err2 := srv.LookupAccount("APP")
	if err1 != nil || err2 != nil {
		t.Fatalf("lookup accounts: %v / %v", err1, err2)
	}
	return SysServer{
		URL:     srv.ClientURL(),
		SysUser: sysUser, SysPass: sysPass,
		AppUser: appUser, AppPass: appPass,
		SysAcc: sysAcc, AppAcc: appAcc,
		Srv: srv,
	}
}

type ClusterNode struct {
	Name string
	URL  string
	Srv  *server.Server
	Opts *server.Options // 启动后 Cluster.Port 已是真实端口（Start() 写回）
}

type Cluster struct {
	Nodes             []ClusterNode
	SysUser, SysPass  string
	AppUser, AppPass  string
}

// StartCluster 启动 n 节点 JS 集群（n>=1；测试一律传 3）。等待路由成型
// （$SYS PING 广播应答数 == n，经 sys 用户）与 meta leader 选举（jsz
// Meta.Leader 非空）后返回；总等待上限 30s（Windows 放宽口径，Global 14）。
func StartCluster(t *testing.T, n int) Cluster {
	t.Helper()
	if n < 1 {
		t.Fatal("cluster needs at least 1 node")
	}
	accs, users := sysAccounts()
	nodes := make([]ClusterNode, 0, n)

	startNode := func(name string, routes []*url.URL, accs []*server.Account) *server.Options {
		opts := &server.Options{
			Port:       -1,
			ServerName: name,
			StoreDir:   t.TempDir(),
			JetStream:  true,
			Cluster: server.ClusterOpts{
				Host: "127.0.0.1",
				Port: -1,
				Name: clusterName,
			},
			Accounts:      accs,
			SystemAccount: "SYS",
			Users:         users,
			Routes:        routes,
		}
		return opts
	}

	// 首节点：无路由。
	firstOpts := startNode(fmt.Sprintf("S%d", 1), nil, accs)
	firstSrv := boot(t, firstOpts)
	nodes = append(nodes, ClusterNode{Name: firstOpts.ServerName, URL: firstSrv.ClientURL(), Srv: firstSrv, Opts: firstOpts})

	// Start() 的路由 accept 循环把 -1 解析出的真实端口写回 opts.Cluster.Port
	// （route.go）；boot 内的 ReadyForConnections 等待已保证该写回完成
	// （ready 判据含路由监听建立）。
	firstRoute := fmt.Sprintf("nats://127.0.0.1:%d", firstOpts.Cluster.Port)
	for i := 2; i <= n; i++ {
		o := startNode(fmt.Sprintf("S%d", i), server.RoutesFromStr(firstRoute), accs)
		s := boot(t, o)
		nodes = append(nodes, ClusterNode{Name: o.ServerName, URL: s.ClientURL(), Srv: s, Opts: o})
	}

	waitClusterReady(t, nodes[0].URL, n)
	return Cluster{Nodes: nodes, SysUser: sysUser, SysPass: sysPass, AppUser: appUser, AppPass: appPass}
}

// quietLogger 是 jsm.go api.Logger 的静默实现（serverdata.DoReq 全程持有
// logger 调 Debugf——传 nil 会 panic，任何调用点都不允许 nil）。
type quietLogger struct{}

func (quietLogger) Tracef(string, ...any) {}
func (quietLogger) Debugf(string, ...any) {}
func (quietLogger) Infof(string, ...any)  {}
func (quietLogger) Warnf(string, ...any)  {}
func (quietLogger) Errorf(string, ...any) {}

// boot 启动一个节点并等待客户端口就绪；Shutdown 注册在 t.Cleanup（逆序由
// Go cleanup 语义保证后进先出——后启动的先关，路由拆除更平稳）。
func boot(t *testing.T, opts *server.Options) *server.Server {
	t.Helper()
	srv, err := server.NewServer(opts)
	if err != nil {
		t.Fatal(err)
	}
	go srv.Start()
	if !srv.ReadyForConnections(10 * time.Second) {
		t.Fatal("cluster node not ready")
	}
	t.Cleanup(srv.Shutdown)
	return srv
}

// waitClusterReady 用客户端协议判据（与 natscli server ping / jsz 相同的
// 面）：$SYS.REQ.SERVER.PING 广播应答数 == n（路由成型）；n>1 时任一 jsz
// 应答的 Meta.Leader 非空（选举完成）。Server.ClusterInfo() 未导出，不能
// 作为进程内判据。
func waitClusterReady(t *testing.T, firstURL string, n int) {
	t.Helper()
	sysNc := ConnectUser(t, firstURL, sysUser, sysPass)
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		got, err := serverdata.CurrentActiveServers(ctx, sysNc, 2*time.Second, quietLogger{})
		cancel()
		if err == nil && got == n && (n == 1 || metaLeaderElected(sysNc)) {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("cluster did not form within 30s (want %d nodes)", n)
}

// metaLeaderElected 请求一次 jsz，检查 Meta.Leader 是否已选出（任一应答者
// 的 jsz 都带 Meta 集群信息）。
func metaLeaderElected(nc *nats.Conn) bool {
	resp, err := nc.Request("$SYS.REQ.SERVER.PING.JSZ", []byte("{}"), 2*time.Second)
	if err != nil {
		return false
	}
	var jr server.ServerAPIJszResponse
	if json.Unmarshal(resp.Data, &jr) != nil || jr.Data == nil {
		return false
	}
	return jr.Data.Meta != nil && jr.Data.Meta.Leader != ""
}

// ConnectUser 以指定用户连接并在测试结束后关闭。
func ConnectUser(t *testing.T, url, user, pass string) *nats.Conn {
	t.Helper()
	nc, err := nats.Connect(url, nats.UserInfo(user, pass), nats.Timeout(2*time.Second), nats.MaxReconnects(-1))
	if err != nil {
		t.Fatalf("connect %s as %s: %v", url, user, err)
	}
	t.Cleanup(nc.Close)
	return nc
}
```

**实现注意（执行者必读）**：成型判据全部走**客户端协议**（`serverdata.CurrentActiveServers` 广播计数 + jsz 请求读 `Meta.Leader`）——`Server.ClusterInfo()` 未导出，不得作进程内判据。`ConnectUser` 用 `nats.MaxReconnects(-1)`（无限重连）便于断节点用例观察；gofmt 会修 struct 字段对齐；`startNode` 闭包的 `accs` 参数遮蔽外层同名变量是刻意的（首节点/后续节点共用同一账户构造）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd desktop && go test ./internal/testutil/ -run 'TestStart' -v -count=1`
Expected: PASS（两测试；Windows 本机）。若 `ClusterInfo` 判据不成立，按上注切换广播计数判据后重跑。

- [ ] **Step 5: 提交**

```bash
git add desktop/internal/testutil/cluster.go desktop/internal/testutil/cluster_test.go
git commit -m "feat(desktop): testutil 3-node cluster + system-account fixtures (M5 Task 1)"
```

---

### Task 2: messaging trace 集群测试（M2 验收遗留）

**Files:**
- Test: `desktop/internal/messaging/trace_cluster_test.go`

**Interfaces:**
- Consumes: Task 1 `testutil.StartCluster`、既有 `Trace(nc, TraceForm) (TraceHop, error)`、`TraceHop{Kind, Detail, Children}`（`trace.go`，Kind 闭集含 `egress`/`mapping`）。
- Produces: 无新接口（纯测试任务，关闭 M2 验收 §6 第 3 条的「route hop / mapping」两半边 + 无兴趣路径；**ErrTimeout 部分结果**无法确定性构造（0 兴趣时 ingress 立即回事件、不触发超时），转 M6 手测矩阵并在验收记录登记裁定）。

- [ ] **Step 1: 写测试（直接就是交付物）**

```go
package messaging

import (
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// 集群 route hop：在 S1 发布、S3 订阅，trace 树应出现 egress(S1) ->
// ingress(S2) -> ... 的跨服务器链（M2 遗留第 3 条 route-hop 半边）。
func TestTraceClusterRouteHop(t *testing.T) {
	c := testutil.StartCluster(t, 3)
	nc1 := testutil.ConnectUser(t, c.Nodes[0].URL, c.AppUser, c.AppPass)
	nc3 := testutil.ConnectUser(t, c.Nodes[2].URL, c.AppUser, c.AppPass)

	sub, err := nc3.Subscribe("cluster.trace.subject", func(m *nats.Msg) {})
	if err != nil {
		t.Fatal(err)
	}
	if err := nc3.Flush(); err != nil {
		t.Fatal(err)
	}
	// 等订阅兴趣经路由传播到发布节点（S1）：向 S1 请求对端是否已见该 subject
	// 没有廉价探针，用固定窗（内嵌集群路由订阅广播在毫秒级，500ms 富余）。
	time.Sleep(500 * time.Millisecond)

	hop, err := Trace(nc1, TraceForm{Subject: "cluster.trace.subject", Payload: []byte("x"), Deliver: true, TimeoutMs: 5000})
	if err != nil {
		t.Fatalf("trace: %v", err)
	}
	if !strings.Contains(hop.Detail, `server:"S1"`) {
		t.Fatalf("root should be S1 ingress, got %q", hop.Detail)
	}
	// 树中必须出现另一台服务器的 hop（egress -> 远端 ingress 链）。
	if !containsServer(hop, "S2") && !containsServer(hop, "S3") {
		t.Fatalf("expected a remote-server hop in tree: %+v", hop)
	}
}

func containsServer(h TraceHop, name string) bool {
	if strings.Contains(h.Detail, `server:"`+name+`"`) {
		return true
	}
	for _, c := range h.Children {
		if containsServer(c, name) {
			return true
		}
	}
	return false
}

// 账户 subject mapping hop：APP 账户加映射 src->dst，trace 树应含
// Kind=="mapping" 的子节点（M2 遗留 mapping 半边；service_import/
// stream_export 见验收裁定记录）。
func TestTraceClusterMappingHop(t *testing.T) {
	f := testutil.StartSysServer(t)
	if err := f.AppAcc.AddMapping("trace.map.src", "trace.map.dst"); err != nil {
		t.Fatalf("add mapping: %v", err)
	}
	nc := testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)

	sub, err := nc.Subscribe("trace.map.dst", func(m *nats.Msg) {})
	if err != nil {
		t.Fatal(err)
	}
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)

	hop, err := Trace(nc, TraceForm{Subject: "trace.map.src", Payload: []byte("x"), Deliver: true, TimeoutMs: 5000})
	if err != nil {
		t.Fatalf("trace: %v", err)
	}
	if !hasKind(hop, "mapping") {
		t.Fatalf("expected mapping hop, tree: %+v", hop)
	}
	_ = sub
}

func hasKind(h TraceHop, kind string) bool {
	if h.Kind == kind {
		return true
	}
	for _, c := range h.Children {
		if hasKind(c, kind) {
			return true
		}
	}
	return false
}

// 无兴趣主题：ingress 服务器仍立即回 trace 事件（0 hop 也回），返回部分树
// 且不报错——验证「无订阅者 → 树可返回」半边。真正的 ErrTimeout-部分-结果
// 路径需要多跳兴趣 + 远端停摆，无法确定性构造，转 M6 手测矩阵项（验收记录
// 登记；本测试改名以免声称测了超时）。
func TestTraceClusterNoInterestReturnsTree(t *testing.T) {
	c := testutil.StartCluster(t, 3)
	nc := testutil.ConnectUser(t, c.Nodes[0].URL, c.AppUser, c.AppPass)

	hop, err := Trace(nc, TraceForm{Subject: "no.interest.anywhere", Payload: []byte("x"), Deliver: true, TimeoutMs: 300})
	if err != nil {
		t.Fatalf("no-interest trace must return the ingress tree: %v", err)
	}
	if hop.Kind != "ingress" {
		t.Fatalf("expected ingress root, got %+v", hop)
	}
}
```

- [ ] **Step 2: 跑测试确认通过（既有实现应已满足；失败则按 systematic-debugging 修 Trace 或夹具，不改断言语义）**

Run: `cd desktop && go test ./internal/messaging/ -run 'TestTraceCluster' -v -count=1`
Expected: PASS ×3。

- [ ] **Step 3: 提交**

```bash
git add desktop/internal/messaging/trace_cluster_test.go
git commit -m "test(desktop): cluster route-hop/mapping/no-interest trace tests (M2 deferral, M5 Task 2)"
```

**裁定记录（写入提交信息正文与验收记录）**：M2 遗留的 `service_import`/`stream_export` trace 形态经查证 **natscli 自身也无集群化测试覆盖**（cli/ 测试仅 util/bench/jsonschema/auth_xkey 四文件），且跨账户 import/export 夹具依赖 `AddServiceImportWithClaim` 等运行时账户 API 的进程内组装，脆弱度高——转 M6 手测矩阵项 + 验收记录登记，不在 M5 自动化范围内。

---

### Task 3: monitor 包 wire 类型、错误分类与校验

**Files:**
- Create: `desktop/internal/monitor/types.go`
- Create: `desktop/internal/monitor/forms.go`
- Test: `desktop/internal/monitor/forms_test.go`

**Interfaces:**
- Consumes: `nats.Conn`；`nats-server/v2/server`（`ApiError`）。
- Produces（Task 4–8 全依赖）:
  - `type CallResult struct { ErrorCode string \`json:"error_code"\`; Error string \`json:"error"\` }` + `Ok()`/`fail(code, msg)`（包内重声明，与 jsadmin 同构）
  - 错误码常量：`CodeOK=""`、`CodeNotConnected="not_connected"`、`CodeNotFound="not_found"`、`CodeValidation="validation"`、`CodeServer="server"`、`CodeCancelled="cancelled"`、`CodeConflict="conflict"`
  - `func ClassifyMonitorError(err error) CallResult` — `nats.ErrNoResponders` 且消息含 "system privileges" → `server` 码 + 原文（调用方另行判定 `SysAvailable`）；`server.ApiError` → `server`；其余 → `server`
  - `func ValidateConnQuery(sort string, offset, limit int) error` — 白名单 Global 11，默认 `cid`
  - `func CompileEventRegex(pattern string) (*regexp.Regexp, error)` — 空串返回 nil（无过滤）
  - `func EventSubjects(types []string, eventPrefix, domain string) ([]string, error)` — 闭集校验 + 映射（Global 10 修正版）。JS 前缀推导（显式三级）：`p := eventPrefix; if p == "" && domain != "" { p = "$JS." + domain + ".EVENT" }`；随后 `jsm.EventSubject(api.JSAdvisoryPrefix|api.JSMetricPrefix, p) + ".>"`（EventSubject 语义：p 非空时把主题的 `$JS.EVENT` 替换为 p——直接传 domain 会得到 `A.ADVISORY` 错误主题，勿犯）。`api_prefix` 不参与 JS 事件前缀。eventPrefix 来源 = 活跃 context 的 `jetstream_event_prefix` 字段（Task 4 为 `connections.Manager` 增加 `JSEventPrefix() string` 访问器，镜像 `JSParams()` 的读法）
  - wire 类型：`MonitorServerRow`/`MonitorSnapshot`/`ServerDetail`/`ConnRow`/`AccountRow`/`SysEvent`/`SysWatchEvent`/各 Result 结构（见 Step 3 完整定义）

- [ ] **Step 1: 写失败测试**

`desktop/internal/monitor/forms_test.go`（节选关键断言，实现者补齐表格驱动）：

```go
package monitor

import (
	"errors"
	"testing"

	"github.com/nats-io/nats.go"
)

func TestValidateConnQuery(t *testing.T) {
	for _, c := range []struct{ sort string; off, lim int; wantErr bool }{
		{"cid", 0, 50, false}, {"rtt", 100, 1024, false},
		{"", 0, 20, false},              // 空 → 默认 cid
		{"DROP TABLE", 0, 50, true},     // 白名单外
		{"cid", -1, 50, true},           // offset < 0
		{"cid", 0, 0, true},             // limit < 1
		{"cid", 0, 1025, true},          // limit > 1024
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
}

func TestCompileEventRegex(t *testing.T) {
	if re, err := CompileEventRegex(""); err != nil || re != nil {
		t.Fatalf("empty must be nil,nil: %v %v", re, err)
	}
	if _, err := CompileEventRegex("("); err == nil {
		t.Fatal("bad regex must fail")
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
}
```

- [ ] **Step 2: 红灯**

Run: `cd desktop && go test ./internal/monitor/ -count=1`
Expected: FAIL（包不存在/符号未定义）。

- [ ] **Step 3: 实现 types.go + forms.go**

`types.go` 关键内容（完整写入，蛇形 json、单结构体返回约定）：

```go
package monitor

// CallResult 与 jsadmin 同构（M4 裁定：包内私有重声明，零 churn）。
type CallResult struct {
	ErrorCode string `json:"error_code"`
	Error     string `json:"error"`
}

func (r CallResult) Ok() bool { return r.ErrorCode == CodeOK }

const (
	CodeOK           = ""
	CodeNotConnected = "not_connected"
	CodeNotFound     = "not_found"
	CodeValidation   = "validation"
	CodeServer       = "server"
	CodeCancelled    = "cancelled"
	CodeConflict     = "conflict"
)

func fail(code, msg string) CallResult { return CallResult{ErrorCode: code, Error: msg} }

// MonitorServerRow 是服务器表一行（statsz + jsz 合并；Global 12 角色映射）。
type MonitorServerRow struct {
	Name              string `json:"name"`
	ID                string `json:"id"`
	Host              string `json:"host"`
	Cluster           string `json:"cluster"`
	Domain            string `json:"domain"`
	Version           string `json:"version"`
	Online            bool   `json:"online"`
	OfflineSinceMs    int64  `json:"offline_since_ms"`
	UptimeSeconds     int64  `json:"uptime_seconds"`
	Cpu               float64 `json:"cpu"`
	MemBytes          int64  `json:"mem_bytes"`
	Cores             int    `json:"cores"`
	Connections       int    `json:"connections"`
	TotalConnections  uint64 `json:"total_connections"`
	Routes            int    `json:"routes"`
	Gateways          int    `json:"gateways"`
	ActiveAccounts    int    `json:"active_accounts"`
	SlowConsumers     int64  `json:"slow_consumers"`
	JsEnabled         bool   `json:"js_enabled"`
	JsRole            string `json:"js_role"` // ""|disabled|meta_leader|voter
	JsStreams         int    `json:"js_streams"`
	JsStreamsLeader   int    `json:"js_streams_leader"`
	JsConsumers       int    `json:"js_consumers"`
	JsMemoryBytes     uint64 `json:"js_memory_bytes"`
	JsStoreBytes      uint64 `json:"js_store_bytes"`
	JsMaxMemoryBytes  int64  `json:"js_max_memory_bytes"`
	JsMaxStoreBytes   int64  `json:"js_max_store_bytes"`
	Error             string `json:"error"` // 离线行显示的最近失败原因
}

// MonitorSnapshot 是 monitor:snapshot 事件与 GetMonitoringSnapshot 的载荷。
type MonitorSnapshot struct {
	Servers              []MonitorServerRow `json:"servers"`
	SysAvailable         bool               `json:"sys_available"`
	SysReason            string             `json:"sys_reason"`
	PolledAtMs           int64              `json:"polled_at_ms"`
	CycleMs              int64              `json:"cycle_ms"`
	RttMs                int64              `json:"rtt_ms"`
	PollIntervalSeconds  int                `json:"poll_interval_seconds"`
}

// ServerDetailResult / GetServerDetail：varz + healthz 定向报表。
type ServerDetail struct {
	Row               MonitorServerRow `json:"row"`
	StartMs           int64            `json:"start_ms"`
	LeafNodes         int              `json:"leaf_nodes"`
	NumSubs           uint32           `json:"num_subs"`
	SentMsgs          uint64           `json:"sent_msgs"`
	SentBytes         uint64           `json:"sent_bytes"`
	RecvMsgs          uint64           `json:"recv_msgs"`
	RecvBytes         uint64           `json:"recv_bytes"`
	HealthStatus      string           `json:"health_status"` // ""=未知/无权限
	HealthError       string           `json:"health_error"`
	HealthDetail      string           `json:"health_detail"`
}

type ServerDetailResult struct {
	CallResult
	Detail *ServerDetail `json:"detail"`
}

// ConnRow / ConnPageResult：top 式连接明细（ConnInfo 裁剪——JWT/证书字段
// 不上 wire，Global 9 的 wire 半边）。
type ConnRow struct {
	Cid        uint64 `json:"cid"`
	Kind       string `json:"kind"`
	Ip         string `json:"ip"`
	Port       int    `json:"port"`
	Account    string `json:"account"`
	User       string `json:"user"`
	Name       string `json:"name"`
	Lang       string `json:"lang"`
	Version    string `json:"version"`
	StartMs    int64  `json:"start_ms"`
	Uptime     string `json:"uptime"`
	Idle       string `json:"idle"`
	Rtt        string `json:"rtt"`
	InMsgs     int64  `json:"in_msgs"`
	OutMsgs    int64  `json:"out_msgs"`
	InBytes    int64  `json:"in_bytes"`
	OutBytes   int64  `json:"out_bytes"`
	NumSubs    uint32 `json:"num_subs"`
	Pending    int    `json:"pending"`
}

type ConnPageResult struct {
	CallResult
	Rows   []ConnRow `json:"rows"`
	Offset int       `json:"offset"`
	Limit  int       `json:"limit"`
	Total  int       `json:"total"`
}

// AccountRow：账户信息与统计（serverdata.CollectAccounts 聚合结果）。
type AccountRow struct {
	Name                 string   `json:"name"`
	Id                   string   `json:"id"`
	Streams              int      `json:"streams"`
	Consumers            int      `json:"consumers"`
	MemoryBytes          uint64   `json:"memory_bytes"`
	StoreBytes           uint64   `json:"store_bytes"`
	ReservedMemoryBytes  uint64   `json:"reserved_memory_bytes"`
	ReservedStoreBytes   uint64   `json:"reserved_store_bytes"`
	StreamNames          []string `json:"stream_names"`
}

type AccountListResult struct {
	CallResult
	Accounts []AccountRow `json:"accounts"`
}

// SysEvent：事件流行（载荷摘要化——原文不入 wire 不入日志，Global 9）。
type SysEvent struct {
	Seq           uint64 `json:"seq"`
	Subject       string `json:"subject"`
	Type          string `json:"type"` // io.nats.* schema type 或 ""
	OccurredMs    int64  `json:"occurred_ms"`
	ServerName    string `json:"server_name"`
	ServerCluster string `json:"server_cluster"`
	Account       string `json:"account"`
	Summary       string `json:"summary"`
	SizeBytes     int    `json:"size_bytes"`
}

// CreateSysWatchResult：单结构体返回（Global 19）。
type CreateSysWatchResult struct {
	CallResult
	WatchId string `json:"watch_id"`
}

// SysWatchEvent：sys:event 事件载荷；dropped/filtered 分开计数（Global 5/10）。
type SysWatchEvent struct {
	WatchId       string   `json:"watch_id"`
	Event         SysEvent `json:"event"`
	DroppedTotal  uint64   `json:"dropped_total"`
	FilteredTotal uint64   `json:"filtered_total"`
}

// ClusterOpResult：危险操作统一结果。
type ClusterOpResult struct {
	CallResult
	OldLeader      string `json:"old_leader"`
	NewLeader      string `json:"new_leader"`
	StreamsBalanced int   `json:"streams_balanced"`
	Note           string `json:"note"` // 如 "new leader not observed within 5s"
	ElapsedMs      int64  `json:"elapsed_ms"`
}
```

`forms.go`：`ClassifyMonitorError`（`nats.ErrNoResponders` → `CodeServer` + err 原文；`errors.As(&server.ApiError)` → 原文 `ae.Description`；nil → Ok）、`ValidateConnQuery`（sortMap 白名单 + offset/limit 边界）、`CompileEventRegex`、`EventSubjects(types, eventPrefix, domain)`（闭集 map + Global 10 三级前缀推导 + `jsm.EventSubject`，去重保序）。

- [ ] **Step 4: 绿灯 + vet**

Run: `cd desktop && go test ./internal/monitor/ -count=1 && go vet ./internal/monitor/`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add desktop/internal/monitor/
git commit -m "feat(desktop): monitor wire types, error classification, validators (M5 Task 3)"
```

---

### Task 4: 监控快照轮询（服务骨架 + 周期采集 + 离线标记 + 权限降级）

**Files:**
- Create: `desktop/internal/monitor/service.go`
- Create: `desktop/internal/monitor/snapshot.go`
- Modify: `desktop/internal/connections/manager.go`（新增 `JSEventPrefix() string` 访问器，镜像 `JSParams()`——active context 的 `jetstream_event_prefix`）
- Test: `desktop/internal/monitor/snapshot_test.go`

**Interfaces:**
- Consumes: Task 1 夹具、Task 3 类型；`settings.Load`（interval）；`jsm.go/serverdata` + `jsm.go/api`（`NewDiscardLogger`）。
- Produces:
  - `type MonitorService struct{...}`；`func NewMonitorService(mgr connSource, log *slog.Logger, emit func(name string, data any), settingsPath string) *MonitorService`（`connSource` 包内私有接口扩展为三方法：`Conn() *nats.Conn` + `JSParams() (domain, apiPrefix string, ok bool)` + `JSEventPrefix() string`——**并同步给 `connections.Manager` 增加 `JSEventPrefix() string` 公开访问器**（镜像 `JSParams()` 的读法返回 `c.JSEventPrefix()`），零适配满足接口）
  - `func (s *MonitorService) StartMonitoring() CallResult` — CAS 启动；**立即执行一次**周期再进 ticker（§6.5「恢复可见后立即执行一次刷新」）
  - `func (s *MonitorService) StopMonitoring() CallResult`
  - `func (s *MonitorService) GetMonitoringSnapshot() MonitorSnapshot` — 返回缓存快照（未启动时零值 + `sys_available=false`）
  - `func (s *MonitorService) NotifyConnState(ev connections.StateEvent)` — 非 connected → 停 ticker（sys watch 的停放在 Task 7 补一行）
  - 内部：`func (s *MonitorService) collectSnapshot() MonitorSnapshot`（Task 5/6 的 detail/accounts 不经过它；Task 5 的名称→ID 解析复用其 known 集）
  - 事件名常量 `EventMonitorSnapshot = "monitor:snapshot"`

- [ ] **Step 1: 写失败测试**

`snapshot_test.go`（关键用例；connSource stub 照抄 jsadmin 测试模式——直连夹具 URL 的真实 `*nats.Conn` 包装。**发射回调异步于断言方，收集切片一律 mutex 保护**——CI 跑 `-race`，对齐 buckets/transfer_test 的 transferLog 惯例）：

```go
package monitor

import (
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/connections"
	"github.com/WenElevating/nats-desktop/desktop/internal/settings"
	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

type connStub struct{ nc *nats.Conn }

func (c connStub) Conn() *nats.Conn { return c.nc }
func (c connStub) JSParams() (string, string, bool) { return "", "", true }
func (c connStub) JSEventPrefix() string { return "" }

// snapLog 是 mutex 保护的快照收集器（emit 来自 ticker goroutine）。
type snapLog struct {
	mu    sync.Mutex
	snaps []MonitorSnapshot
}

func (l *snapLog) emit(name string, data any) {
	if name == EventMonitorSnapshot {
		l.mu.Lock()
		l.snaps = append(l.snaps, data.(MonitorSnapshot))
		l.mu.Unlock()
	}
}

func (l *snapLog) len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.snaps)
}

func newService(t *testing.T, nc *nats.Conn) (*MonitorService, *snapLog) {
	return newServiceAt(t, nc, "")
}

// newServiceAt 允许指定 settings 路径（停止类测试用 interval=2s 的设置文件，
// 使「停止后无新事件」断言在删掉停止逻辑时会失败）。
func newServiceAt(t *testing.T, nc *nats.Conn, settingsPath string) (*MonitorService, *snapLog) {
	t.Helper()
	l := &snapLog{}
	s := NewMonitorService(connStub{nc}, slog.New(slog.NewTextHandler(os.Stderr, nil)), l.emit, settingsPath)
	return s, l
}

// writeFastPollSettings 写一份 poll_interval_seconds=2 的设置文件并返回路径。
func writeFastPollSettings(t *testing.T) string {
	t.Helper()
	path := t.TempDir() + "/settings.json"
	st := settings.Default()
	st.Behavior.PollIntervalSeconds = 2
	if err := settings.Save(path, st); err != nil {
		t.Fatal(err)
	}
	return path
}
```

// 单节点（系统账户）：collectSnapshot 得 1 行在线、角色/版本/连接数齐备。
func TestSnapshotSingleSysServer(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	s, _ := newService(t, nc)

	snap := s.collectSnapshot()
	if !snap.SysAvailable {
		t.Fatalf("sys must be available: %+v", snap.SysReason)
	}
	if len(snap.Servers) != 1 || !snap.Servers[0].Online {
		t.Fatalf("want 1 online row: %+v", snap.Servers)
	}
	row := snap.Servers[0]
	if row.Name != "TEST_SYS" || row.Version == "" || row.Connections < 1 || !row.JsEnabled {
		t.Fatalf("row fields incomplete: %+v", row)
	}
	if row.UptimeSeconds <= 0 || row.Cores < 1 || row.MemBytes <= 0 {
		t.Fatalf("stats fields incomplete: %+v", row)
	}
	if snap.RttMs < 0 || snap.CycleMs <= 0 {
		t.Fatalf("rtt/cycle: %+v", snap)
	}
}

// 无系统权限（app 用户）：SysAvailable=false + 原文 reason（§8.3.1）。
func TestSnapshotNoSysPermission(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)
	s, _ := newService(t, nc)

	snap := s.collectSnapshot()
	if snap.SysAvailable || snap.SysReason == "" {
		t.Fatalf("want degraded snapshot: %+v", snap)
	}
}

// 三节点 + 断一节点：该节点标红离线、其余正常（AC-015 预期 2 的 Go 半边）。
func TestSnapshotClusterNodeOfflineMarking(t *testing.T) {
	c := testutil.StartCluster(t, 3)
	nc := testutil.ConnectUser(t, c.Nodes[0].URL, c.SysUser, c.SysPass)
	s, _ := newService(t, nc)

	snap := s.collectSnapshot()
	if len(snap.Servers) != 3 {
		t.Fatalf("want 3 rows, got %d", len(snap.Servers))
	}

	// 关闭 S3；下一周期它不应答 → 已知集合 diff 标红。
	c.Nodes[2].Srv.Shutdown()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		snap = s.collectSnapshot()
		var off *MonitorServerRow
		for i := range snap.Servers {
			if snap.Servers[i].Name == c.Nodes[2].Name {
				off = &snap.Servers[i]
			}
		}
		if off != nil && !off.Online {
			if len(snap.Servers) != 3 {
				t.Fatalf("offline row must be retained: %d rows", len(snap.Servers))
			}
			var online int
			for _, r := range snap.Servers {
				if r.Online {
					online++
				}
			}
			if online != 2 {
				t.Fatalf("want 2 online, got %d", online)
			}
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatal("S3 not marked offline within 10s")
}

// StartMonitoring 立即出首帧事件且按间隔续推；Stop 后停（§8.5.1）。
func TestStartStopMonitoringEvents(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	// interval=2s 的设置文件：停止后观察窗必须跨过一个完整 tick，删除停止
	// 逻辑时本测试会失败（空假设成立）。
	s, snaps := newServiceAt(t, nc, writeFastPollSettings(t))

	if res := s.StartMonitoring(); !res.Ok() {
		t.Fatalf("start: %+v", res)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && snaps.len() == 0 {
		time.Sleep(50 * time.Millisecond)
	}
	if snaps.len() == 0 {
		t.Fatal("no snapshot event after start")
	}
	if res := s.StopMonitoring(); !res.Ok() {
		t.Fatalf("stop: %+v", res)
	}
	n := snaps.len()
	// > 2× interval（覆盖一个完整 tick 的静默断言）。
	time.Sleep(2500 * time.Millisecond)
	if snaps.len() != n {
		t.Fatalf("events must stop after StopMonitoring: %d -> %d", n, snaps.len())
	}
	// 重复 Stop 幂等；未启动时 Stop 也幂等。
	_ = s.StopMonitoring()
}

// NotifyConnState 非 connected → ticker 停（断连全停的快照半边）。
func TestNotifyConnStateStopsTicker(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	s, snaps := newServiceAt(t, nc, writeFastPollSettings(t))
	if res := s.StartMonitoring(); !res.Ok() {
		t.Fatal(res)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && snaps.len() == 0 {
		time.Sleep(50 * time.Millisecond)
	}
	s.NotifyConnState(connections.StateEvent{State: connections.StateReconnecting})
	n := snaps.len()
	time.Sleep(2500 * time.Millisecond)
	if snaps.len() != n {
		t.Fatalf("ticker must stop on non-connected state: %d -> %d", n, snaps.len())
	}
}
```

- [ ] **Step 2: 红灯**

Run: `cd desktop && go test ./internal/monitor/ -run 'TestSnapshot|TestStartStop|TestNotify' -count=1`
Expected: FAIL（NewMonitorService 未定义）。

- [ ] **Step 3: 实现 service.go + snapshot.go**

`service.go` 骨架（完整实现）：

```go
package monitor

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/connections"
	"github.com/WenElevating/nats-desktop/desktop/internal/settings"
)

type connSource interface {
	Conn() *nats.Conn
	JSParams() (domain, apiPrefix string, ok bool)
	JSEventPrefix() string
}

// connections.Manager 侧的配套改动（manager.go，紧邻 JSParams）：
//
//	// JSEventPrefix returns the active context's jetstream_event_prefix
//	// (spec §8.3 JS 事件主题；空 = 默认 $JS.EVENT)。
//	func (m *Manager) JSEventPrefix() string {
//		m.mu.Lock()
//		name := m.active
//		connected := m.state == StateConnected
//		m.mu.Unlock()
//		if !connected || name == "" {
//			return ""
//		}
//		c, err := m.reg.Load(context.Background(), name)
//		if err != nil {
//			return ""
//		}
//		return c.JSEventPrefix()
//	}

// EventMonitorSnapshot 是每轮询周期推送的事件名（§8.5.1）。
const EventMonitorSnapshot = "monitor:snapshot"

// snapshotTimeout 是节点级请求超时（§6.10 异常表「2s」原文；不随设置变）。
const snapshotTimeout = 2 * time.Second

type MonitorService struct {
	mgr          connSource
	log          *slog.Logger
	emit         func(name string, data any)
	settingsPath string

	runMu      sync.Mutex     // 保护 running/ticker/known 三者一致的启停
	running    bool
	tickerDone chan struct{}
	cancel     context.CancelFunc

	snapshotMu sync.Mutex
	last       MonitorSnapshot
	cycleBusy  atomic.Bool // 周期单飞：上一轮未完成跳过本次 tick（Global 1）

	known map[string]MonitorServerRow // 跨周期已知服务器（离线标记）
}

func NewMonitorService(mgr connSource, log *slog.Logger, emit func(name string, data any), settingsPath string) *MonitorService {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if emit == nil {
		emit = func(string, any) {}
	}
	return &MonitorService{mgr: mgr, log: log, emit: emit, settingsPath: settingsPath, known: map[string]MonitorServerRow{}}
}

func (s *MonitorService) interval() time.Duration {
	st, err := settings.Load(s.settingsPath)
	if err != nil || st.Behavior.PollIntervalSeconds < 2 {
		return 5 * time.Second
	}
	if st.Behavior.PollIntervalSeconds > 60 {
		return 60 * time.Second
	}
	return time.Duration(st.Behavior.PollIntervalSeconds) * time.Second
}

func (s *MonitorService) StartMonitoring() CallResult {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if s.running {
		return CallResult{}
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.running = true
	s.cancel = cancel
	s.tickerDone = make(chan struct{})
	go s.pollLoop(ctx, s.interval())
	return CallResult{}
}

// pollLoop 立即执行一次周期（§6.5「恢复可见后立即执行一次刷新」的 Go 半边），
// 随后按 interval 续推；panic 兜底记 Error 后退出该 goroutine（Global 20）。
func (s *MonitorService) pollLoop(ctx context.Context, interval time.Duration) {
	defer close(s.tickerDone)
	defer func() {
		if r := recover(); r != nil {
			s.log.Error("monitor poll loop panic recovered", "panic", r)
		}
	}()
	tk := time.NewTicker(interval)
	defer tk.Stop()
	s.runCycle(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-tk.C:
			s.runCycle(ctx)
		}
	}
}

// StopMonitoring 幂等；等 poll goroutine 退出后再返回，避免与下一次
// Start 竞争 emit 顺序。
func (s *MonitorService) StopMonitoring() CallResult {
	s.runMu.Lock()
	if !s.running {
		s.runMu.Unlock()
		return CallResult{}
	}
	s.running = false
	cancel, done := s.cancel, s.tickerDone
	s.cancel = nil
	s.runMu.Unlock()
	cancel()
	<-done
	return CallResult{}
}

// runCycle 单飞执行一轮采集并 emit；上一轮未完成则跳过本次 tick（Global 1）。
func (s *MonitorService) runCycle(ctx context.Context) {
	if !s.cycleBusy.CompareAndSwap(false, true) {
		return
	}
	defer s.cycleBusy.Store(false)
	snap := s.collectSnapshot()
	s.snapshotMu.Lock()
	s.last = snap
	s.snapshotMu.Unlock()
	if ctx.Err() == nil { // 停止过程中的最后一轮不再 emit
		s.emit(EventMonitorSnapshot, snap)
	}
}

func (s *MonitorService) GetMonitoringSnapshot() MonitorSnapshot {
	s.snapshotMu.Lock()
	defer s.snapshotMu.Unlock()
	return s.last
}

// NotifyConnState：非 connected 一律停轮询（Task 7 在 syswatch.go 里为本
// 方法追加 s.stopAllSysWatches() 一行——事件 watch 断连全停与 M4 对齐）。
func (s *MonitorService) NotifyConnState(ev connections.StateEvent) {
	if ev.State == connections.StateConnected {
		return
	}
	_ = s.StopMonitoring()
	s.log.Warn("monitor polling stopped", "state", string(ev.State))
}

`snapshot.go`（collectSnapshot 核心 + 共用 newLive 助手，逐字实现）：

```go
// newLive 构造一个自适应等待的 Live 数据源（waitFor=0：首响应最多等
// timeout、其后 300ms 静默即止）。Task 8 的 leader 解析复用此助手
// （超时取 s.timeout() 而非快照的固定 2s）。logger 用 api.NewDiscardLogger()
// ——DoReq 全程调 log.Debugf，nil 会 panic（勿传 nil；也不 import testutil）。
func (s *MonitorService) newLive(nc *nats.Conn, timeout time.Duration) (*serverdata.Live, error) {
	reqFn := func(req any, subj string, waitFor int, nc *nats.Conn) ([][]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		return serverdata.DoReq(ctx, req, subj, waitFor, nc, timeout, api.NewDiscardLogger())
	}
	return serverdata.NewLive(nc, reqFn, 0)
}

func (s *MonitorService) collectSnapshot() MonitorSnapshot {
	start := time.Now()
	snap := MonitorSnapshot{SysAvailable: true, PolledAtMs: start.UnixMilli(), PollIntervalSeconds: int(s.interval().Seconds())}

	nc := s.mgr.Conn()
	if nc == nil || !nc.IsConnected() {
		snap.SysAvailable = false
		snap.SysReason = "not connected"
		return snap
	}
	if rtt, err := nc.RTT(); err == nil {
		snap.RttMs = rtt.Milliseconds()
	}

	live, err := s.newLive(nc, snapshotTimeout) // waitFor=0 自适应（2s+300ms 静默）
	if err != nil {
		snap.SysAvailable = false
		snap.SysReason = err.Error()
		return snap
	}
	statsz, err := live.Statz(server.StatszEventOptions{})
	if err != nil {
		// 无响应者/无权限 → §8.3.1 降级（DoReq 原文含 system privileges 提示）。
		snap.SysAvailable = false
		snap.SysReason = err.Error()
		return snap
	}
	jsz, jszErr := live.Jsz(server.JszEventOptions{}) // 失败容忍：JS 角色列退化
	_ = jszErr

	now := time.Now()
	rows := mergeStatszJsz(statsz, jsz, now)

	s.runMu.Lock()
	for name, prev := range s.known {
		if _, ok := rowByName(rows, name); !ok {
			prev.Online = false
			if prev.OfflineSinceMs == 0 {
				prev.OfflineSinceMs = now.UnixMilli()
			}
			if prev.Error == "" {
				prev.Error = "no response within 2s"
			}
			rows = append(rows, prev) // 已知但未应答 → 保留并标红（Global 2）
		}
	}
	newKnown := map[string]MonitorServerRow{}
	for _, r := range rows {
		newKnown[r.Name] = r
	}
	s.known = newKnown
	s.runMu.Unlock()

	snap.Servers = rows
	snap.CycleMs = time.Since(start).Milliseconds()
	s.log.Info("monitor snapshot", "servers", len(rows), "cycle_ms", snap.CycleMs) // 只记聚合计数（Global 9）
	return snap
}
```

`mergeStatszJsz`（纯函数，独立可测）：statsz 应答 → `MonitorServerRow`（`UptimeSeconds = int64(now.Sub(st.Stats.Start).Seconds())`、`CPU=st.Stats.CPU`、`Mem=st.Stats.Mem`、`Routes=len(st.Stats.Routes)`、`Gateways=len(st.Stats.Gateways)`、`JsEnabled=st.Server.JetStreamEnabled()`）；jsz 按 `resp.Server.Name` 对齐合并（`Disabled` → role `disabled`；`Meta != nil && Meta.Leader == resp.Server.Name` → `meta_leader`；`Meta != nil` → `voter`；`Meta == nil` → `""`；Streams/StreamsLeader/Consumers/Memory/Store 从 `resp.Data`（`JSInfo.Streams`/`StreamsLeader`/`Consumers` + 内嵌 `JetStreamStats`），MaxMemory/MaxStore 从 `resp.Data.Config`）。配套 `rowByName(rows []MonitorServerRow, name string) (MonitorServerRow, bool)` 线性查（服务器表 ≤ 百级，无需索引）。

- [ ] **Step 4: 绿灯**

Run: `cd desktop && go test ./internal/monitor/ -count=1 -v 2>&1 | tail -20`
Expected: 全 PASS（含 Task 3 用例）。集群用例在本机约 5–15s。

- [ ] **Step 5: 提交**

```bash
git add desktop/internal/monitor/
git commit -m "feat(desktop): monitor snapshot poller with offline marking + sys degradation (M5 Task 4)"
```

---

### Task 5: 节点报表 + 连接明细 + kick

**Files:**
- Create: `desktop/internal/monitor/serverops.go`
- Test: `desktop/internal/monitor/serverops_test.go`

**Interfaces:**
- Consumes: Task 3/4（service、类型、校验、`newLive`、known 集）；Task 1 夹具。
- Produces:
  - **名称→ID 解析（关键事实）**：nats-server 的定向端点按 **server ID** 订阅——`$SYS.REQ.SERVER.<ID>.VARZ/HEALTHZ/CONNZ/KICK`（`serverDirectReqSubj = "$SYS.REQ.SERVER.%s.%s"` 与 `clientKickReqSubj = "$SYS.REQ.SERVER.%s.KICK"` 均以 `s.info.ID` 格式化，events.go:67/62/1351/1509）——**用服务器名寻址永远无响应者**，且报错文案会误导为权限问题。绑定面一律收**服务器名**（UI 展示名），Go 侧先解析为 ID：
    ```go
    // resolveServerID 名称→ID：优先用缓存快照的 known 行；未命中时跑一次
    // statsz 广播刷新（覆盖「从未启动监控就打开节点报表」的路径）再查；
    // 仍无 → not_found。
    func (s *MonitorService) resolveServerID(name string) (string, CallResult) {
        if id := s.knownID(name); id != "" {
            return id, CallResult{}
        }
        snap := s.collectSnapshot()
        if !snap.SysAvailable {
            return "", fail(CodeServer, snap.SysReason)
        }
        if id := s.knownID(name); id != "" {
            return id, CallResult{}
        }
        return "", fail(CodeNotFound, fmt.Sprintf("server %q not found", name))
    }
    ```
    （`knownID` 在 runMu 下扫 `s.known` 取 `row.ID`。）
  - `func (s *MonitorService) GetServerDetail(name string) ServerDetailResult` — resolveServerID → 定向 `$SYS.REQ.SERVER.<ID>.VARZ` + `.HEALTHZ`（`server.VarzEventOptions{}`/`HealthzEventOptions{}`，waitFor=1）；varz 失败 → `server` 原文（部分主题无权限时该面板显示原文，其余面板不受影响，Global 3）；healthz 失败容忍（`HealthStatus=""` + `HealthError` 原文）
  - `func (s *MonitorService) ListServerConnections(name, sort string, offset, limit int) ConnPageResult` — `ValidateConnQuery` 先行 → resolveServerID → 定向 `$SYS.REQ.SERVER.<ID>.CONNZ`，`server.ConnzEventOptions{ConnzOptions: server.ConnzOptions{Sort: server.SortOpt(sort), Username: true, Offset: offset, Limit: limit}}`；`Total=data.Total`、rows 裁剪映射（JWT/TLS 字段丢弃）
  - `func (s *MonitorService) KickConnection(name string, cid uint64) CallResult` — resolveServerID → `serverdata.DoReq(ctx, server.KickClientReq{CID: cid}, "$SYS.REQ.SERVER."+id+".KICK", 1, nc, s.timeout(), api.NewDiscardLogger())`；拒绝/失败原文透传（Global 4）。`s.timeout()` 同 jsadmin（settings `request_timeout_seconds`，默认 5s）

- [ ] **Step 1: 写失败测试**

```go
package monitor

import (
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// 节点报表：varz+healthz 齐；未知服务器 → not_found。
func TestGetServerDetail(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	s, _ := newService(t, nc)

	// 不预跑快照：resolveServerID 必须自己跑一次广播刷新（覆盖冷启动路径）。
	res := s.GetServerDetail("TEST_SYS")
	if !res.Ok() || res.Detail == nil {
		t.Fatalf("detail: %+v", res)
	}
	if res.Detail.HealthStatus == "" && res.Detail.HealthError == "" {
		t.Fatalf("healthz must be surfaced: %+v", res.Detail)
	}
	if res.Detail.Row.Connections < 1 {
		t.Fatalf("row merge missing: %+v", res.Detail.Row)
	}

	// 名称解析失败 → not_found（而非误导性的 server/权限错误）。
	if res := s.GetServerDetail("NO_SUCH"); res.ErrorCode != CodeNotFound {
		t.Fatalf("unknown server must be not_found: %+v", res)
	}
}

// 连接明细：分页 + 排序 + 总数（单节点开 3 条连接断言 ≥3）。
func TestListServerConnectionsPaging(t *testing.T) {
	f := testutil.StartSysServer(t)
	for range 3 {
		testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)
	}
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	s, _ := newService(t, nc)

	res := s.ListServerConnections("TEST_SYS", "cid", 0, 2)
	if !res.Ok() {
		t.Fatalf("connz: %+v", res)
	}
	if len(res.Rows) != 2 || res.Limit != 2 || res.Total < 4 {
		t.Fatalf("page: rows=%d total=%d", len(res.Rows), res.Total)
	}
	if res.Rows[0].Cid == 0 || res.Rows[0].Ip == "" {
		t.Fatalf("row fields: %+v", res.Rows[0])
	}

	page2 := s.ListServerConnections("TEST_SYS", "cid", 2, 2)
	if !page2.Ok() || len(page2.Rows) < 1 {
		t.Fatalf("page2: %+v rows=%d", page2, len(page2.Rows))
	}

	if res := s.ListServerConnections("TEST_SYS", "DROP", 0, 50); res.ErrorCode != CodeValidation {
		t.Fatalf("bad sort: %+v", res)
	}
}

// kick：断开指定连接（AC 场景 = sys 权限用户）。
func TestKickConnection(t *testing.T) {
	f := testutil.StartSysServer(t)
	victim := testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)
	victim.Flush()
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	s, _ := newService(t, nc)

	cid, _ := victim.GetClientID()
	if res := s.KickConnection("TEST_SYS", uint64(cid)); !res.Ok() {
		t.Fatalf("kick: %+v", res)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if victim.IsClosed() || victim.Status() == nats.CLOSED || victim.Status() == nats.RECONNECTING {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("victim connection not closed after kick")
}
```

**注意**：`nc.GetClientID()` 在 nats.go v1.53.1 存在（`nats.go:6617`，返回 `(uint64, error)`）——直接使用即可，无需备用路径。

- [ ] **Step 2: 红灯 → Step 3: 实现 serverops.go → Step 4: 绿灯**

Run: `cd desktop && go test ./internal/monitor/ -run 'TestGetServerDetail|TestListServerConnections|TestKick' -count=1`
实现要点：三个绑定都先走 `resolveServerID`（Produces 里的完整代码），定向主题一律拼 **ID**；定向请求的 DoReq 超时取 `s.timeout()`（settings，默认 5s——与快照的固定 2s 区分）、logger 用 `api.NewDiscardLogger()`；`ConnInfo→ConnRow` 映射显式字段白名单（JWT/TLS 字段不上 wire）；kick 后 `victim` 的关闭由服务器完成。Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add desktop/internal/monitor/serverops.go desktop/internal/monitor/serverops_test.go
git commit -m "feat(desktop): server detail/connz paging/kick (M5 Task 5)"
```

---

### Task 6: 账户信息与统计

**Files:**
- Create: `desktop/internal/monitor/accounts.go`
- Test: `desktop/internal/monitor/accounts_test.go`

**Interfaces:**
- Consumes: Task 4 service；`serverdata.Live.CollectAccounts()`。
- Produces: `func (s *MonitorService) ListAccounts() AccountListResult` — 聚合 `[]*server.AccountDetail` → `AccountRow`（Streams=len/StreamNames（≤前 50 个，防巨型数组）、JetStreamStats 字段映射）；无 JS/无权限 → `server` 原文或空列表 + reason（`AccountListResult.Error` 承载）。

- [ ] **Step 1: 写失败测试**

```go
package monitor

import (
	"testing"

	"github.com/nats-io/jsm.go"
	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

func TestListAccounts(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)

	// 在 APP 账户建一个 stream，账户统计应出现 APP + 1 stream。
	appNc := testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)
	mgr, err := jsm.New(appNc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mgr.NewStream("ACCT_TEST"); err != nil {
		t.Fatal(err)
	}

	s, _ := newService(t, nc)
	res := s.ListAccounts()
	if !res.Ok() {
		t.Fatalf("accounts: %+v", res)
	}
	var app *AccountRow
	for i := range res.Accounts {
		if res.Accounts[i].Name == "APP" {
			app = &res.Accounts[i]
		}
	}
	if app == nil || app.Streams < 1 || len(app.StreamNames) < 1 {
		t.Fatalf("APP account row: %+v", app)
	}
}

func TestListAccountsNoSysPermission(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)
	s, _ := newService(t, nc)
	res := s.ListAccounts()
	if res.Ok() && len(res.Accounts) == 0 && res.Error == "" {
		t.Fatal("degraded path must carry reason")
	}
}
```

- [ ] **Step 2: 红灯 → Step 3: 实现 → Step 4: 绿灯**

Run: `cd desktop && go test ./internal/monitor/ -run 'TestListAccounts' -count=1`
实现：`live.CollectAccounts()` 失败时若错误文本含 "system privileges" → 空 `Accounts` + `Error` 原文（降级面板，不 error_code 化）；成功路径纯映射排序（按 Name）。Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add desktop/internal/monitor/accounts.go desktop/internal/monitor/accounts_test.go
git commit -m "feat(desktop): accounts report (M5 Task 6)"
```

---

### Task 7: 系统事件流 watch

**Files:**
- Create: `desktop/internal/monitor/syswatch.go`
- Test: `desktop/internal/monitor/syswatch_test.go`

**Interfaces:**
- Consumes: Task 3 `EventSubjects`/`SysEvent`/`SysWatchEvent`；M4 `buckets/watch.go` 的 registry 模式（**复制式适配**，非 import——包私有惯例）。
- Produces:
  - `type SysWatchSpec struct { Types []string \`json:"types"\`; Regex string \`json:"regex"\` }`
  - `func (s *MonitorService) CreateSysWatch(spec SysWatchSpec) CreateSysWatchResult` — 校验（闭集/正则）→ subjects = `EventSubjects(spec.Types, s.mgr.JSEventPrefix(), domain)`（domain 取自 `s.mgr.JSParams()`）→ 订阅全部 subjects（`nc.Subscribe`，每 subject 一个 sub）→ ingest：regex 过滤（`filtered_total` 原子计数）→ 解析 → `SysWatchEvent` 入 4096 有界队列（满丢最旧 + `dropped_total`）→ 单发射 goroutine `emit("sys:event", ev)`（recover 保护）
  - `func (s *MonitorService) StopSysWatch(id string) CallResult`
  - `NotifyConnState` 扩展：非 connected → 停全部 sys watch（在 Task 4 的方法内加一行调用 `s.stopAllSysWatches()`）
  - 事件解析纯函数：`func parseSysEvent(seq uint64, subject string, data []byte, now time.Time) SysEvent` — `$SYS.ACCOUNT.<acc>.DISCONNECT` → `server.DisconnectEventMsg`（Summary=`"<user>@<host> <reason>"`，Account=acc）；`...CONNECT` → `ConnectEventMsg`（Summary=`"<user>@<host> connected"`）；`$SYS.SERVER.*.CLIENT.AUTH.ERR` → DisconnectEventMsg（Reason 为主）；`$JS.EVENT.*` → 只取 `{Type,Time}`（Summary=Type）；其余/解析失败 → Type=""、Summary=""（UI 显示 subject + size）。`OccurredMs` 优先取载荷 `timestamp`（`TypedEvent.Time`，json 标签 `"timestamp"`），缺失回退入参 now。**载荷原文不保留**（SizeBytes 记长度）。
  - 测试触达缝：`sysWatchEntry` 提供 `ingest(ev SysEvent, re *regexp.Regexp)`（过滤+offer 前置路径）、`waitDrained(timeout)`、`emittedCount()`（发射 goroutine 原子累加）与 `newSysWatchEntryForTest(capacity)` 构造器（测试文件内定义后者即可）

- [ ] **Step 1: 写失败测试**

```go
package monitor

import (
	"fmt"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

func TestParseSysEvent(t *testing.T) {
	now := time.Unix(1700000000, 0)
	// disconnect 载荷（server.DisconnectEventMsg 真实形状——TypedEvent.ID 是
	// string、时间标签是 "timestamp"，严格 unmarshal 下数字 id 会失败）
	ev := parseSysEvent(7, "$SYS.ACCOUNT.APP.DISCONNECT", []byte(`{"type":"io.nats.server.advisory.v1.client_disconnect","id":"7","timestamp":"2023-11-14T22:13:20Z","server":{"name":"S1","cluster":"TEST"},"client":{"host":"127.0.0.1","user":"app","acc":"APP"},"reason":"client closed"}`), now)
	if ev.Seq != 7 || ev.Account != "APP" || ev.ServerName != "S1" {
		t.Fatalf("ev: %+v", ev)
	}
	if ev.Summary == "" {
		t.Fatalf("summary required: %+v", ev)
	}
	if ev.Type != "io.nats.server.advisory.v1.client_disconnect" {
		t.Fatalf("type: %+v", ev)
	}
	// JS advisory：只取 type。
	ev = parseSysEvent(8, "$JS.EVENT.ADVISORY.STREAM.CREATED.TEST", []byte(`{"type":"io.nats.jetstream.advisory.v1.stream_create"}`), now)
	if ev.Type == "" || ev.Summary != ev.Type {
		t.Fatalf("js advisory: %+v", ev)
	}
	// 未知形状：subject+size 保留、无摘要。
	ev = parseSysEvent(9, "$SYS.ODD.EVENT", []byte(`garbage`), now)
	if ev.Subject == "" || ev.SizeBytes != 7 || ev.Summary != "" {
		t.Fatalf("unknown: %+v", ev)
	}
}

// evLog 是 mutex 保护的事件收集器（emit 来自发射 goroutine，-race 门禁）。
type evLog struct {
	mu  sync.Mutex
	evs []SysWatchEvent
}

func (l *evLog) emit(name string, data any) {
	if name == EventSysWatch {
		l.mu.Lock()
		l.evs = append(l.evs, data.(SysWatchEvent))
		l.mu.Unlock()
	}
}

func (l *evLog) len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.evs)
}

func (l *evLog) first() SysWatchEvent {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.evs[0]
}

func TestCreateSysWatchLifecycle(t *testing.T) {
	f := testutil.StartSysServer(t)
	sysNc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	l := &evLog{}
	s := NewMonitorService(connStub{sysNc}, nil, l.emit, "")

	res := s.CreateSysWatch(SysWatchSpec{Types: []string{"account_disconnect"}})
	if !res.Ok() || res.WatchId == "" {
		t.Fatalf("create: %+v", res)
	}
	// 制造断连：开一条 app 连接再关掉。
	victim := testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)
	victim.Flush()
	victim.Close()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && l.len() == 0 {
		time.Sleep(50 * time.Millisecond)
	}
	if l.len() == 0 {
		t.Fatal("no sys:event observed")
	}
	ev := l.first()
	if ev.Event.Subject == "" || ev.Event.ServerName == "" || ev.DroppedTotal != 0 {
		t.Fatalf("event: %+v", ev)
	}
	if res := s.StopSysWatch(res.WatchId); !res.Ok() {
		t.Fatalf("stop: %+v", res)
	}
}

func TestCreateSysWatchValidation(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	s, _ := newService(t, nc)
	if res := s.CreateSysWatch(SysWatchSpec{Types: []string{"bogus"}}); res.ErrorCode != CodeValidation {
		t.Fatalf("type: %+v", res)
	}
	if res := s.CreateSysWatch(SysWatchSpec{Types: []string{"account_connect"}, Regex: "("}); res.ErrorCode != CodeValidation {
		t.Fatalf("regex: %+v", res)
	}
}

// 洪峰真实链路（Global 5）：200 条断连零丢失、dropped_total=0。
func TestSysWatchFloodNoLoss(t *testing.T) {
	f := testutil.StartSysServer(t)
	sysNc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	l := &evLog{}
	s := NewMonitorService(connStub{sysNc}, nil, l.emit, "")
	res := s.CreateSysWatch(SysWatchSpec{Types: []string{"account_disconnect"}})
	if !res.Ok() {
		t.Fatal(res)
	}
	conns := make([]*nats.Conn, 0, 200) // 保留句柄统一关闭，防止句柄泄漏干扰后续用例
	for i := 0; i < 200; i++ {
		nc := testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)
		nc.Flush()
		conns = append(conns, nc)
	}
	for _, nc := range conns {
		nc.Close()
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && l.len() < 200 {
		time.Sleep(100 * time.Millisecond)
	}
	if l.len() < 200 {
		t.Fatalf("flood loss: got %d < 200", l.len())
	}
}

// 10k ingest 性能门（Global 13 的可断言半边，纯内存不经网络）：10,000 条
// 事件过 ingest（正则滤掉一半），断言 <1s、通过事件零丢失、
// filtered_total==5000、dropped_total==0。同时覆盖队列容量满场景。
func TestSysWatchIngest10kWithRegex(t *testing.T) {
	e := newSysWatchEntryForTest(4096) // 生产容量
	re := regexp.MustCompile(`^even\.`)
	start := time.Now()
	for i := 0; i < 10000; i++ {
		subj := fmt.Sprintf("odd.%d", i)
		if i%2 == 0 {
			subj = fmt.Sprintf("even.%d", i)
		}
		e.ingest(parseSysEvent(uint64(i), subj, nil, time.Now()), re)
	}
	elapsed := time.Since(start)
	e.waitDrained(time.Second)
	if elapsed >= time.Second {
		t.Fatalf("10k ingest too slow: %v", elapsed)
	}
	if got := e.filtered.Load(); got != 5000 {
		t.Fatalf("filtered_total: %d", got)
	}
	if got := e.drop.Load(); got != 0 {
		t.Fatalf("dropped_total: %d", got)
	}
	if n := e.emittedCount(); n != 5000 {
		t.Fatalf("emitted: %d", n)
	}
}

// 队列满丢最旧（纯单测，容量 2 注入 5 条）。
func TestSysWatchQueueDropOldest(t *testing.T) {
	e := newSysWatchEntryForTest(2)
	for i := 0; i < 5; i++ {
		e.ingest(parseSysEvent(uint64(i), "x", nil, time.Now()), nil)
	}
	e.waitDrained(time.Second)
	if got := e.drop.Load(); got != 3 {
		t.Fatalf("dropped: %d", got)
	}
}
```

**实现注意**：`newSysWatchEntryForTest(capacity)`/`e.ingest(ev, re)`/`e.waitDrained(timeout)`/`e.emittedCount()` 是测试可触达的入口——实现时把这些方法做成 `sysWatchEntry` 的（未）导出方法（`ingest` 即 registry 的入队前置过滤+offer 路径，正则为参数以便测试注入；`emittedCount` 由发射 goroutine 原子累加，供断言零丢失）。200 条连接建立+断开在 Windows 内嵌服务器上约 2–5s，若 CI 稳定性不足降到 100 并同步断言下限。

- [ ] **Step 2: 红灯 → Step 3: 实现 syswatch.go**

结构照抄 `buckets/watch.go`：`sysWatchRegistry{mu,next,entries}`、`sysWatchEntry{id, subs []*nats.Subscription, ch chan SysWatchEvent, drop/filtered atomic.Uint64, done chan struct{}, log}`、`offer`（select default → 弹最旧再入、`drop++`、`drop%4096==1` WARN）、发射 goroutine（`for ev := range ch { emit(EventSysWatch, ev) }` + recover）。`EventSysWatch = "sys:event"` 常量。订阅 ctx 用 `context.Background` 派生 cancel（绝不超时包裹，Global 5）；`NotifyConnState` 停全停。

- [ ] **Step 4: 绿灯**

Run: `cd desktop && go test ./internal/monitor/ -run 'TestParseSys|TestCreateSysWatch|TestSysWatch' -count=1`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add desktop/internal/monitor/syswatch.go desktop/internal/monitor/syswatch_test.go
git commit -m "feat(desktop): $SYS event stream watch with type filter + regex (M5 Task 7)"
```

---

### Task 8: 集群危险操作（step-down / peer-remove / balance）

**Files:**
- Create: `desktop/internal/monitor/clusterops.go`
- Test: `desktop/internal/monitor/clusterops_test.go`

**Interfaces:**
- Consumes: Task 4 service；`jsctx.NewManager`、`jsm.Manager.MetaLeaderStandDown/MetaPeerRemove/LoadStream`、`jsm.Stream.LeaderStepDown/RemoveRAFTPeer`、`jsm.go/balancer`、Task 4 `collectSnapshot`（leader 解析复用 jsz 广播）。
- Produces:
  - `func (s *MonitorService) MetaStepDown() ClusterOpResult`
  - `func (s *MonitorService) StreamStepDown(stream string) ClusterOpResult`
  - `func (s *MonitorService) MetaPeerRemove(peer string) ClusterOpResult`
  - `func (s *MonitorService) StreamPeerRemove(stream, peer string) ClusterOpResult`
  - `func (s *MonitorService) StreamBalance(stream string) ClusterOpResult`
  - 单飞：`opsMu sync.Mutex` + `opsInFlight map[string]bool`，key=`op+"\x00"+target`；重复触发 → `CodeConflict` + "operation in progress"（Global 6）
  - meta 域守卫：`JSParams()` 返回 domain!="" 或 prefix!="" → `CodeValidation` + natscli 同义文案（Global 8）

- [ ] **Step 1: 写失败测试**

```go
package monitor

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

func TestMetaStepDownElectsNewLeader(t *testing.T) {
	c := testutil.StartCluster(t, 3)
	nc := testutil.ConnectUser(t, c.Nodes[0].URL, c.SysUser, c.SysPass)
	s, _ := newService(t, nc)

	res := s.MetaStepDown()
	if !res.Ok() {
		t.Fatalf("step-down: %+v", res)
	}
	if res.OldLeader == "" {
		t.Fatalf("old leader required: %+v", res)
	}
	// 新 leader 未必 5s 内观测到（Note 半边），但快照最终必须换人。
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		snap := s.collectSnapshot()
		var leader string
		for _, r := range snap.Servers {
			if r.JsRole == "meta_leader" {
				leader = r.Name
			}
		}
		if leader != "" && leader != res.OldLeader {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatal("no new meta leader elected within 15s")
}

func TestMetaStepDownSingleFlightConflict(t *testing.T) {
	c := testutil.StartCluster(t, 3)
	nc := testutil.ConnectUser(t, c.Nodes[0].URL, c.SysUser, c.SysPass)
	s, _ := newService(t, nc)

	var wg sync.WaitGroup
	codes := make([]string, 2)
	for i := range 2 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = s.MetaStepDown().ErrorCode
		}(i)
	}
	wg.Wait()
	// 一个成功（或 note 超时仍 Ok）、另一个 conflict——不允许双执行。
	sawConflict, sawOther := false, false
	for _, c := range codes {
		if c == CodeConflict {
			sawConflict = true
		} else if c == CodeOK {
			sawOther = true
		}
	}
	if !sawConflict || !sawOther {
		t.Fatalf("want one ok + one conflict, got %v", codes)
	}
}

func TestStreamStepDownAndBalance(t *testing.T) {
	c := testutil.StartCluster(t, 3)
	nc := testutil.ConnectUser(t, c.Nodes[0].URL, c.AppUser, c.AppPass)
	s, _ := newService(t, nc)

	mgr := newJsm(t, nc)
	if _, err := mgr.NewStream("OPS_R3", jsm.Replicas(3)); err != nil {
		t.Fatalf("R3 stream: %v", err)
	}

	res := s.StreamStepDown("OPS_R3")
	if !res.Ok() {
		t.Fatalf("stream step-down: %+v", res)
	}
	// 单流 R3 在 3 节点上本就均衡（balancer 数学：1 流/3 节点 → offset=0
	// → 不动任何 leader），BalanceStreams 返回 0——只断言 Ok 并记录数值；
	// 「不均衡才迁移」的数值断言留给真实集群 UIA 冒烟（Task 14）。
	res = s.StreamBalance("OPS_R3")
	if !res.Ok() {
		t.Fatalf("balance: %+v", res)
	}
	t.Logf("balanced %d streams (single balanced stream is a no-op by design)", res.StreamsBalanced)
	if res := s.StreamStepDown("NOPE"); res.ErrorCode != CodeNotFound {
		t.Fatalf("missing stream: %+v", res)
	}
}

// peer-remove 破坏夹具：放在独立子测试最后执行（顺序内 last）。
func TestStreamPeerRemove(t *testing.T) {
	c := testutil.StartCluster(t, 3)
	nc := testutil.ConnectUser(t, c.Nodes[0].URL, c.AppUser, c.AppPass)
	s, _ := newService(t, nc)

	mgr := newJsm(t, nc)
	st, err := mgr.NewStream("OPS_PR", jsm.Replicas(3))
	if err != nil {
		t.Fatal(err)
	}
	info, err := st.Information()
	if err != nil {
		t.Fatal(err)
	}
	if info.Cluster == nil || len(info.Cluster.Replicas) == 0 {
		t.Fatal("stream not clustered")
	}
	peer := info.Cluster.Replicas[0].Name

	res := s.StreamPeerRemove("OPS_PR", peer)
	if !res.Ok() {
		t.Fatalf("peer remove: %+v", res)
	}
	// 移除后流仍可用（信息可查）。
	if _, err := st.Information(); err != nil {
		t.Fatalf("stream info after remove: %v", err)
	}
}

func TestMetaOpsDomainGuard(t *testing.T) {
	c := testutil.StartCluster(t, 3)
	nc := testutil.ConnectUser(t, c.Nodes[0].URL, c.SysUser, c.SysPass)
	s := NewMonitorService(domainStub{nc, "A"}, nil, func(string, any) {}, "")
	res := s.MetaStepDown()
	if res.ErrorCode != CodeValidation || !strings.Contains(res.Error, "system account") {
		t.Fatalf("guard: %+v", res)
	}
}
```

**实现注意**：`domainStub`/`newJsm` 为测试助手（`domainStub` 实现三方法 connSource：`JSParams()` 返回 `("A","",true)`、`JSEventPrefix()` 返回 `""`；`newJsm` 直接 `jsm.New(nc)`）。`mgr.NewStream(name, ...jsm.StreamOption)` 为当前 API（`streams.go:184`），副本数用 `jsm.Replicas(3)` 选项（`streams.go:354`）。

- [ ] **Step 2: 红灯 → Step 3: 实现 clusterops.go**

核心（meta leader 解析照抄 natscli 语义，见调研）：

```go
// resolveMetaLeader 广播 jsz 找唯一 meta leader（natscli metaLeaderStandDownAction 同款）。
func (s *MonitorService) resolveMetaLeader(nc *nats.Conn) (leader string, jsi *server.JSInfo, err error) {
	live := s.newLive(nc, s.timeout())
	resps, err := live.Jsz(server.JszEventOptions{})
	if err != nil {
		return "", nil, err
	}
	var leaders []*server.ServerAPIJszResponse
	for _, jr := range resps {
		if jr.Data == nil || jr.Data.Meta == nil || jr.Server == nil || jr.Server.Name != jr.Data.Meta.Leader {
			continue
		}
		leaders = append(leaders, jr)
	}
	switch len(leaders) {
	case 0:
		return "", nil, fmt.Errorf("did not receive a response from the meta leader, ensure the account used has system privileges and appropriate permissions")
	case 1:
		return leaders[0].Data.Meta.Leader, leaders[0].Data, nil
	default:
		return "", nil, fmt.Errorf("found %d JetStream meta cluster leaders, unable to determine which cluster to act on", len(leaders))
	}
}
```

`MetaStepDown`：域守卫 → beginOp("meta_stepdown","") → resolve → `jsctx.NewManager(nc, "", "", timeout)`（**显式无域**）→ `MetaLeaderStandDown(nil)` → 轮询 ≤10×500ms 新 leader（`Leader != old` 即得；超时则 `Note="new leader not observed within 5s"`、`NewLeader=""` 仍 Ok）→ endOp。`StreamStepDown`：`handles()` 同 jsadmin（域感知）→ LoadStream → `info.Cluster == nil || len(Replicas)==0` → `CodeValidation "stream %q is not clustered"` → `LeaderStepDown()` → 同款轮询（stream info）。`MetaPeerRemove(peer)`：域守卫 → resolve → 在 `Meta.Replicas` 找 `r.Name == peer || r.Peer == peer`（找不到 → `CodeNotFound`）→ natscli 同款：`if id != "" { mgr.MetaPeerRemove("", id) } else { mgr.MetaPeerRemove(name, id) }`。`StreamPeerRemove`：LoadStream → `RemoveRAFTPeer(peer)`。`StreamBalance`：`balancer.New(nc, apiLogger)`——logger 直接用 `api.NewDefaultLogger(api.ErrorLevel)` 或 `api.NewDiscardLogger()`（`api.Logger` 是 **5 方法**接口 Tracef/Debugf/Infof/Warnf/Errorf，勿手写 3 方法适配）→ `BalanceStreams([]*jsm.Stream{st})`。全部方法 defer endOp + recover（Global 20）。

- [ ] **Step 4: 绿灯（注意 peer-remove 用例会移除一个 peer——夹具随测试结束销毁，无跨测试污染）**

Run: `cd desktop && go test ./internal/monitor/ -run 'TestMeta|TestStream(Step|Peer|Balance)' -count=1 -timeout 300s`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add desktop/internal/monitor/clusterops.go desktop/internal/monitor/clusterops_test.go
git commit -m "feat(desktop): cluster danger ops with single-flight + domain guard (M5 Task 8)"
```

---

### Task 9: main.go 装配 + bindings + 包门禁

**Files:**
- Modify: `desktop/main.go`（注册 MonitorService + conn:state side-band 扩展）
- Modify: `desktop/frontend/src/lib/bindings.ts`（手 apply，不提交 regen 产物）
- Test: `desktop/internal/monitor/smoke_test.go`

**Interfaces:**
- Consumes: Task 4–8 全部公开方法。
- Produces: Wails 绑定 `monitor.*`（前端 Tasks 10–13 消费）；`main.go` 的 `monSvc.NotifyConnState(ev)` side-band（emit 闭包内与 msgSvc/bktSvc 并列）。

- [ ] **Step 1: 冒烟测试（先写）**

```go
package monitor

import (
	"testing"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// 全绑定面冒烟：单服务器上依次调用全部公开方法不 panic、错误码受控。
func TestServiceBindingSurfaceSmoke(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	s, _ := newService(t, nc)

	if res := s.StartMonitoring(); !res.Ok() { t.Fatal(res) }
	_ = s.GetMonitoringSnapshot()
	if res := s.GetServerDetail("TEST_SYS"); !res.Ok() { t.Fatal(res) }
	if res := s.ListServerConnections("TEST_SYS", "cid", 0, 10); !res.Ok() { t.Fatal(res) }
	_ = s.ListAccounts()
	if res := s.CreateSysWatch(SysWatchSpec{Types: []string{"account_connect"}}); !res.Ok() { t.Fatal(res) }
	if res := s.MetaStepDown(); res.ErrorCode != CodeValidation && res.ErrorCode != CodeServer {
		// 单节点无 Meta → natscli 原文错误（server）；域守卫不触发（无域）。
		t.Logf("meta stepdown on single node: %+v (expected server error)", res)
	}
	_ = s.StopMonitoring()
}
```

- [ ] **Step 2: main.go 装配**

在 `bucketSvc := ...` 后：

```go
	// Server monitoring + cluster ops facade (spec §6.10/§6.11): snapshot
	// ticker and $SYS event watches stop-all on disconnect via the same
	// conn:state side-band as the bucket watchers.
	monSvc := monitor.NewMonitorService(manager, logger, emit, settingsPath)
```

`emit` 闭包内 `if bktSvc != nil {...}` 之后并列：

```go
				if monSvc != nil {
					monSvc.NotifyConnState(ev)
				}
```

`Services` 列表追加 `application.NewService(monSvc)`。import 增加 monitor 包。

- [ ] **Step 3: bindings regen 并提交**

Run: `cd desktop && wails3 generate bindings -ts -clean=true`。**生成的 bindings 树是提交物**（`frontend/bindings/github.com/.../internal/<pkg>/*.ts` 已有 22 个已提交文件、CI 不 regen——Global 19 修正版）：本步产出 `frontend/bindings/.../internal/monitor/{service,models,index}.ts` **并保留**；对其中可空字段按既有 null-guard 惯例适配（9207fd3 风格，`| null` 兼容）；`src/lib/bindings.ts` 增加 monitor 的 re-export（与其他包同款式）。验证：`cd frontend && npx tsc --noEmit` 通过。

- [ ] **Step 4: 全量门禁**

Run: `cd desktop && go test ./... -count=1 && go vet ./... && cd frontend && npx tsc --noEmit && npm test -- --run`
Expected: Go 全包 PASS（monitor ≥80% 覆盖率目标——用 `go test ./internal/monitor/ -cover` 验证并记录；不足则补表格测试至达标）；vitest 全绿。

- [ ] **Step 5: 提交**

```bash
git add desktop/main.go desktop/frontend/bindings desktop/frontend/src/lib/bindings.ts desktop/internal/monitor/smoke_test.go
git commit -m "feat(desktop): wire MonitorService into app shell + bindings (M5 Task 9)"
```

---

### Task 10: 前端监控页 I——hook + 服务器表 + 工具栏

**Files:**
- Create: `desktop/frontend/src/features/monitoring/MonitoringPage.tsx`
- Create: `desktop/frontend/src/features/monitoring/ServerTable.tsx`
- Create: `desktop/frontend/src/features/monitoring/useMonitor.ts`
- Create: `desktop/frontend/src/features/monitoring/schema.ts`
- Test: `desktop/frontend/tests/monitoring-server-table.test.tsx`、`monitoring-use-monitor.test.ts`（**前端测试一律放 `frontend/tests/`**——仓库既有惯例，src/features 下无测试文件）

**Interfaces:**
- Consumes: bindings `monitor.*`（`StartMonitoring/StopMonitoring/GetMonitoringSnapshot`）、`Events.On("monitor:snapshot")`、`GetSettings`（间隔）、`useConnState`、i18n。
- Produces（Task 11/12 依赖）:
  - `useMonitor()` → `{ snapshot, sysAvailable, sysReason, paused, setPaused, refreshNow, selected, setSelected }`——可见性/连接门控生命周期：connected+visible → StartMonitoring；hidden/disconnect/unmount → StopMonitoring；visibility 恢复 → StartMonitoring（立即首帧由 Go 保证）
  - `ServerTable({ snapshot, selected, onSelect })`——列：状态点（在线绿/离线红）、名称、版本、uptime、CPU%（等宽数字）、内存（humanize）、连接数、路由/网关、JS 角色（badge：meta_leader 高亮）；表头点击排序（asc/desc 状态机）；离线行整行降透明 + 红点 + title=Error 原文；虚拟滚动（@tanstack/react-virtual，行高 28px §18.2）
  - `MonitoringPage` 骨架：工具栏（间隔显示 `${interval}s`、暂停/恢复按钮（`Pause`/`Play` lucide）、立即刷新按钮（`RefreshCw`））+ 权限降级横幅（`sys_available=false` → ShieldOff 图标 + `monitor.noPermission` 文案 + 可展开原文）+ `<ServerTable>` + 下方 Tabs 占位（Task 11/12 填充：connections/events/accounts/danger）

- [ ] **Step 1: 写失败测试**（vitest + RTL，mock `@wailsio/runtime` 与 bindings——照抄 `tests/streams-page.test.tsx` / `tests/kv-page.test.tsx` 的既有模式）

`tests/monitoring-use-monitor.test.ts` 关键断言：初始 `GetMonitoringSnapshot` 首帧；`monitor:snapshot` 事件更新 state；conn state → disconnected 时调用 `StopMonitoring`；visibilitychange hidden → `StopMonitoring`、visible → `StartMonitoring`；`setPaused(true)` → `StopMonitoring`。

`tests/monitoring-server-table.test.tsx` 关键断言：3 行渲染（mock 快照）；离线行 `data-offline="true"` 且含红点；表头点击「connections」列二次切换排序（行序断言）；空态引导文案；页面/表格根节点带 `data-polled-at={snapshot.polled_at_ms}` 属性（Task 14 UIA 两周期刷新断言的锚点）。

- [ ] **Step 2: 红灯** — Run: `cd frontend && npx vitest run src/features/monitoring` → FAIL（模块不存在）。

- [ ] **Step 3: 实现**（组件骨架遵循 StreamList 的 GRID_COLS 共享列宽模式 + `grid` 行类；数字列 `font-mono tabular-nums`；i18n key `monitor.*` en/zh 双侧同步新增）

- [ ] **Step 4: 绿灯** — Run: `cd desktop/frontend && npx vitest run tests/monitoring- && npx tsc --noEmit` → PASS。页面接入 `App.tsx`（lazy chunk + 替换 Monitoring 占位）。

- [ ] **Step 5: 提交**

```bash
git add desktop/frontend/src/features/monitoring desktop/frontend/src/App.tsx desktop/frontend/src/locales/
git commit -m "feat(desktop): monitoring page shell + server table (M5 Task 10)"
```

---

### Task 11: 前端监控页 II——节点报表 + 连接明细 + 账户

**Files:**
- Create: `desktop/frontend/src/features/monitoring/NodeDetail.tsx`
- Create: `desktop/frontend/src/features/monitoring/ConnectionsTop.tsx`
- Create: `desktop/frontend/src/features/monitoring/AccountsPanel.tsx`
- Test: `desktop/frontend/tests/monitoring-node-detail.test.tsx`、`monitoring-connections.test.tsx`、`monitoring-accounts.test.tsx`

**Interfaces:**
- Consumes: Task 10 `useMonitor`/selected；bindings `GetServerDetail/ListServerConnections/KickConnection/ListAccounts`。
- Produces:
  - `NodeDetail({ server })`——选中节点的报表卡：varz 统计（CPU/内存/核心/订阅数/收发消息与字节/leafnode 数/uptime/start）+ JS 配置（max memory/store、streams/consumers、角色）+ healthz 状态徽章（ok 绿/err 红 + `HealthDetail` 展开原文）；面板级失败（部分主题无权限）显示原文错误卡（Global 3「被拒绝的报表隐藏并说明」）
  - `ConnectionsTop({ server })`——分页表格（offset 翻页、limit 选择 20/50/100）、**表头点击排序**（与服务器表同一交互，Global 16；排序键 = Global 11 白名单）、行内「断开」按钮（`Unplug` 图标，L1 确认 → `KickConnection`；成功 toast 含 cid；失败原文 toast）；列：cid/ip/user/account/uptime/idle/rtt/in/out 字节数（等宽）；Total 计数
  - `AccountsPanel`——账户卡列表（name/id/streams/consumers/memory/store/reserved + stream 名 chips ≤50）；降级时 reason 卡
  - 数据获取模式：选中变化/翻页/排序即取（async handler + AbortController 式守卫，照抄 useConsumers 的 ref-guard 模式）；**手动刷新**（不自动轮询——connz/accounts 是按需报表，§6.10「按用户选择展开」）

- [ ] **Step 1–4: 红灯→实现→绿灯**（测试关键断言：NodeDetail 渲染统计与 health；ConnectionsTop 分页调用参数（offset/limit/sort 透传）、**表头排序交互**、kick L1 确认门（未确认不调绑定）、错误原文展示；AccountsPanel 渲染 + 降级文案。Run: `cd desktop/frontend && npx vitest run tests/monitoring-`）

- [ ] **Step 5: 提交**

```bash
git add desktop/frontend/src/features/monitoring
git commit -m "feat(desktop): node report, connections top, accounts panel (M5 Task 11)"
```

---

### Task 12: 前端监控页 III——事件流 + 危险操作区 + StreamDetail 集群入口

**Files:**
- Create: `desktop/frontend/src/features/monitoring/EventsPanel.tsx`
- Create: `desktop/frontend/src/features/monitoring/DangerZone.tsx`
- Create: `desktop/frontend/src/features/monitoring/DangerOpDialog.tsx`
- Modify: `desktop/frontend/src/features/streams/StreamDetail.tsx`（集群运维入口，M3 遗留）
- Test: `desktop/frontend/tests/monitoring-events.test.tsx`、`monitoring-danger-zone.test.tsx`、`streams-page.test.tsx` 增补（集群入口断言）

**Interfaces:**
- Consumes: bindings `CreateSysWatch/StopSysWatch/MetaStepDown/StreamStepDown/MetaPeerRemove/StreamPeerRemove/StreamBalance`；`useConfirm`（L1）/`DangerOpDialog`（L2 自建：名称匹配 + 影响说明 + 进行中态）；`Events.On("sys:event")`。
- Produces:
  - `EventsPanel`——类型多选 chips（五种，闭集）+ 正则输入（防抖 400ms，非法正则内联红字不重建 watch）+ watch 生命周期（类型/正则变更 → Stop+Create）；前端环形 10,000 条（useRef 数组 + 头部插入渲染窗口）；事件行：时间（HH:mm:ss.SSS）、类型/来源服务器徽章、account、Summary、subject（等宽）、字节数；状态条：累计 N / 丢弃 N（`dropped_total` 红色 chip）/ 过滤 N；虚拟滚动；清空按钮
  - `DangerOpDialog({ op, title, impactLines, expectedName, inFlight, onConfirm })`——L2：`expectedName` 输入框（不匹配 → 确认钮禁用 + `common.nameMismatch` 提示，对话框保持）；影响说明列表（含触发重新选举/副本迁移时长提示文案）；`inFlight` → 按钮 spinner + 禁用（Global 6）
  - `DangerZone`——红色边框分区（`border-[var(--danger)]` 色系 + `TriangleAlert`），四个操作卡：Meta step-down（L2 输入 = 当前 meta leader 名，从 snapshot 读取显示）、Stream step-down（L2 = stream 名）、Stream balance（L2 = stream 名）、Stream/Meta peer-remove（L2 = peer 名；**Meta peer-remove 附加 natscli 同义警示文案**：removed peer 回群需全集群重启、R1 数据丢失）；结果 toast（old→new leader / balanced N / elapsed）；`conflict` 错误码 → toast「操作进行中」
  - `StreamDetail` 增补：Cluster 区（已有 ClusterInfo 展示）加「集群运维」行三个小按钮（step-down/peer-remove/balance）复用 DangerOpDialog（M3 遗留闭环）；单节点流（无 cluster）该行不渲染

- [ ] **Step 1–4: 红灯→实现→绿灯**（测试关键断言：EventsPanel 类型 chips 变更触发 Stop→Create 序列、正则非法不重建、ring 截断 10k、丢弃 chip 数值透传；DangerOpDialog 名称不匹配禁用且 Esc/取消关闭、匹配后确认调用 onConfirm 一次；DangerZone 四操作走 L2、inFlight 禁用、conflict toast；StreamDetail 集群按钮渲染条件。Run: `cd desktop/frontend && npx vitest run tests/monitoring- tests/streams-`）

- [ ] **Step 5: 提交**

```bash
git add desktop/frontend/src
git commit -m "feat(desktop): sys event stream, danger zone, stream cluster ops entry (M5 Task 12)"
```

---

### Task 13: Dashboard 总览页（§6.5）

**Files:**
- Create: `desktop/frontend/src/features/dashboard/DashboardPage.tsx`
- Create: `desktop/frontend/src/features/dashboard/AdvisoryList.tsx`
- Test: `desktop/frontend/tests/dashboard-page.test.tsx`、`dashboard-advisory.test.tsx`

**Interfaces:**
- Consumes: Task 10 `useMonitor`（快照与生命周期复用——Dashboard 挂载即 Start，离开即 Stop）、`Events.On("sys:event")`、`CreateSysWatch/StopSysWatch`、`useConnState().rttMs`。
- Produces:
  - `DashboardPage`——卡片组：服务器（在线/总数 + 离线红标）、连接数（Σ）、JS 内存使用比（Σ reserved_memory / Σ max_memory，进度条 + 百分比等宽）、JS 存储使用比（同前）、RTT（`conn.rttMs` 与快照 `rtt_ms` 取新）；每卡可点击跳转 Monitoring/Streams 页（`onNavigate`）
  - `AdvisoryList`——挂载即 `CreateSysWatch({types:["account_connect","account_disconnect","auth_error","js_advisory"]})`、卸载 Stop；**最新在前**环形 100 条（§6.5「最多保留 100 条，新事件置顶」）；行 = 时间/类型徽章/来源服务器/摘要（无摘要显示 subject）
  - 无 $SYS 权限：卡片组区域整体替换为 `dashboard.noPermission` 说明卡（§6.5 异常表「其余功能不受影响」——advisory 区同样降级说明）；advisory 面板降级为同文案
  - `App.tsx` 接入：dashboard 页从 `PagePlaceholder` 换成 lazy chunk

- [ ] **Step 1–4: 红灯→实现→绿灯**（测试关键断言：卡片聚合计算（mock 快照 3 服务器 2 在线 → 「2/3」、JS 比例分母为 0 时显示 `-`）；advisory 置顶排序与 100 截断；降级卡渲染；卸载调用 StopSysWatch。Run: `cd desktop/frontend && npx vitest run tests/dashboard-`）

- [ ] **Step 5: 提交**

```bash
git add desktop/frontend/src/features/dashboard desktop/frontend/src/App.tsx desktop/frontend/src/locales/
git commit -m "feat(desktop): dashboard overview page (M5 Task 13)"
```

---

### Task 14: 收尾——kv 覆盖率整改 + i18n 门禁 + 全量验证 + UIA 冒烟 + 验收文档

**Files:**
- Modify: `desktop/frontend/src/features/kv/{BucketForm,KeyValuePage}.tsx`、`schema.ts`（测试补齐驱动，非为覆盖率改产品代码——若发现可测性缺口，先补 `data-testid` 再测）
- Test: `desktop/frontend/tests/kv-page.test.tsx` 增补（BucketForm/KeyValuePage/schema 的覆盖缺口——kv 测试在 `tests/kv-page.test.tsx` 既有文件内扩展）、`desktop/frontend/tests/i18n.test.ts` 增补（monitor/dashboard/clusterOps 命名空间进完整性门禁）、UIA 冒烟脚本（沿用 M3/M4 的 PowerShell 通道与既有脚本位置）
- Create: `docs/superpowers/plans/2026-09-13-nats-desktop-m5-acceptance.md`、`docs/superpowers/plans/2026-09-13-nats-desktop-m5-test-report.md`

**Interfaces:**
- Consumes: 全部前置任务；M4 验收遗留清单第 1 条（kv 68.03%→≥70%）；AC-015/016/017。

- [ ] **Step 1: kv 覆盖率整改**

Run: `cd frontend && npx vitest run --coverage` → 读 features/kv 总覆盖率。补测：BucketForm（提交路径/校验错误/编辑回填三主线）、KeyValuePage（选中流转/断连停轮询/toast 分支）、schema（每条规则边界值）。目标 **≥70%**（§20.1 前端组件门槛），未达标不交付——记录三项文件终值。

- [ ] **Step 2: i18n 完整性 + 全量门禁**

Run: `npx vitest run && npx tsc --noEmit && npm run build && cd .. && go test ./... -count=1 -cover && go vet ./...`
Expected: 全绿；构建产物 chunk 尺寸记录；monitor 包覆盖率记录（目标 ≥80%）。

- [ ] **Step 3: UIA 冒烟（AC-015/016/017 + 真应用）**

复用 M3/M4 的 PowerShell UIAutomation 冒烟口径（锁屏环境下经 UIA/MSAA 通道）：启动 `desktop.exe` → 连接本地/夹具集群 → 断言：①监控页服务器表出现节点行（AC-015 第 1 预期）；②两轮周期数据刷新（`data-polled-at` 变化）；③事件流面板制造断连后出现 disconnect 行（AC-016）；④危险区 meta step-down 对话框：错误名 → 按钮禁用（AC-017 预期 1），正确名 → 执行且新 leader 出现（预期 2，需 3 节点真集群——用夹具：`go run ./cmd/testcluster` 或临时 main 拉起，见下）。不可驱动腿（原生选择器等不存在于本页）照 M4 惯例记录 LIVE+PENDING-MANUAL 与自动化等价覆盖。

**3 节点集群的 UIA 运行载体**：`desktop/cmd/testcluster/main.go`（约 40 行，复用 `testutil.StartCluster` 的选项构造但不注册 t.Cleanup，Ctrl-C 退出）——该 cmd 是**测试工具**，进 `cmd/` 但 README 注明非产品面。若执行者判断更优路径（如外部 nats-server 进程三实例脚本），以验收记录裁定为准，不阻塞。

- [ ] **Step 4: 验收与测试报告文档**

`...-m5-test-report.md`：单测/性能/压力/集成四层执行记录——①Go 全包测试计数与覆盖率表（monitor ≥80% 目标值）；②性能实测：快照周期耗时（3 节点）、connz 1024 行分页、事件洪峰 ingest（Task 7 flood 用例数值）、前端构建产物与 vitest 计数；③LocalServer 探测结果；④UIA 冒烟矩阵（同 M4 格式：PASS/LIVE+PENDING 分列）。`...-m5-acceptance.md`：AC-015/016/017 逐条映射（自动腿 + 手动腿）、Global 约束逐条核对表、裁定记录汇总（trace import/export 转手测、meta 域守卫、单飞 conflict 语义、NodeDetail 面板按需刷新）、遗留清单（M6 候选）。

- [ ] **Step 5: 提交**

```bash
git add desktop/frontend/src/features/kv desktop/cmd/testcluster docs/superpowers/plans/2026-09-13-nats-desktop-m5-*.md
git commit -m "chore(desktop): M5 closeout - kv coverage, i18n gate, UIA smoke, acceptance docs (M5 Task 14)"
```

---

## 自查记录（writing-plans Self-Review + reviewing-plans 审查闭环）

1. **Spec 覆盖**：§6.10 输入三项（轮询/暂停→G1+Task 10；事件过滤→G10+Task 7/12；连接表排序+断开→G11+Task 5/11）✓；§6.10 输出五件（服务器表/节点报表/连接明细/事件流/账户）→ Tasks 4–7/10–12 ✓；§6.10 异常 3 行→G2/G4/G5 ✓；§6.11 全链路→G6/G7/G8+Task 8/12 ✓；§6.5 三异常→G1/G3+Task 13 ✓；§8.3.1→G3 ✓；§8.5.1 监控快照事件→Task 4 ✓；AC-015/016/017→Tasks 4/7/12/14 ✓；M2 trace 遗留→Task 2 ✓；M3 集群入口→Task 12 ✓；M4 kv 覆盖率→Task 14 ✓。
2. **占位符扫描**：全文无 TBD/「稍后实现」类占位。
3. **类型一致性**：`MonitorServerRow`/`MonitorSnapshot`/`SysEvent`/`SysWatchEvent`/`ClusterOpResult` 在 Task 3 定义、Task 4–13 消费，字段名逐一核对（snake_case wire + Go 驼峰）；`EventMonitorSnapshot="monitor:snapshot"`、`EventSysWatch="sys:event"` 常量单点定义。
4. **操作维度覆盖**：性能（G13→Task 4 cycle 计时/Task 5 分页/Task 7 flood+10k ingest/Task 14 报告）、失败（G2 离线/G3 降级/G6 conflict）、可观测（G9 日志纪律/G20 recover）、并发（G6 单飞 CAS + Task 8 并发测试）均有任务与证据点。

## 审查记录（reviewing-plans，报告 `.superpowers/sdd/m5-plan-review.md`）

只读审查代理报告 **5C/6I/8M**，控制器逐条对模块缓存/仓库源码复核后全部坐实并修复入计划：

- **C1 定向请求按 server ID 寻址**（events.go:67/62/1351/1509 以 `s.info.ID` 订阅）→ Task 5 重设计为「绑定收名称 + `resolveServerID`（known 集→广播刷新→not_found）」，未知服务器从误导性 server 错误改为 `not_found`。
- **C2 单流 R3 本就均衡**（balancer 数学 1/3→offset 0）→ 断言改为仅 Ok + 记录数值，真实迁移数值归 UIA 冒烟。
- **C3 opts.Accounts 是死对象**（NewServer 浅拷贝后 opts 侧指针失效）→ Task 1 经 `srv.LookupAccount` 返回活账户。
- **C4 TypedEvent.ID 是 string** → fixture 改 `"id":"7"` 并补 `"timestamp"` 钉 OccurredMs 映射。
- **C5 bindings 树是提交物**（仓库 22 个已提交文件、CI 不 regen）→ G19/Task 9 改为 regen 后提交 monitor 生成文件。
- **I1 -race**：Task 4/7 测试收集器全部加 mutex（snapLog/evLog）。
- **I2 停止测试空假设**：interval=2s 设置文件 + 2.5s 观察窗，删掉停止逻辑即失败。
- **I3 EventSubject 语义**（直接传 domain 得 `A.ADVISORY`）→ 三级前缀推导（context `jetstream_event_prefix` 优先 → `"$JS."+domain+".EVENT"` 回退 → 默认），`EventSubjects` 签名加 eventPrefix 参数，`connections.Manager` 增 `JSEventPrefix()` 访问器。
- **I4 周期上界诚实化**：改「单请求 ≤2s、健康实测记录、降级最坏 ~4.3s」。
- **I5 10k/filtered 无测试** → Task 7 增加合成 ingest 测试（10k 事件 + 半滤正则 + <1s + 计数精确断言）。
- **I6 前端测试位置** → 全部改到 `frontend/tests/`（monitoring-*/dashboard-* 命名），i18n 门禁挂 `tests/i18n.test.ts`。
- **M1–M8**：端口写回注释（Start 非 NewServer）、死等待循环删除、超时测试改名重构为无兴趣路径（ErrTimeout 部分结果转 M6 手测矩阵）、`data-polled-at` 落 Task 10、monitor 用 `api.NewDiscardLogger()`（不 import testutil）、balancer logger 用现成 api 实现（5 方法接口）、连接表改表头排序、`StreamsLeader` 映射补齐。
