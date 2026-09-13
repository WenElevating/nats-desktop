package testutil

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
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
// 使系统账户事件与 JS 元数据跨节点可用。账户必须经 server.NewAccount 构造：
// 裸 struct 字面量的 mconns 零值为 0（jwt.NoLimit=-1），会被
// MaxTotalConnectionsReached 判为已满，拒绝一切客户端连接
// （nats-server v2.15.0-preview.1，accounts.go:666-674 / client.go:899）。
func sysAccounts() ([]*server.Account, []*server.User) {
	accs := []*server.Account{server.NewAccount("SYS"), server.NewAccount("APP")}
	users := []*server.User{
		{Username: sysUser, Password: sysPass, Account: accs[0]},
		{Username: appUser, Password: appPass, Account: accs[1]},
	}
	return accs, users
}

type SysServer struct {
	URL              string
	SysUser, SysPass string
	AppUser, AppPass string
	SysAcc, AppAcc   *server.Account
	Srv              *server.Server
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
	Nodes            []ClusterNode
	SysUser, SysPass string
	AppUser, AppPass string
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

	startNode := func(name string, cPort int, routes []*url.URL, accs []*server.Account) *server.Options {
		opts := &server.Options{
			Port:       -1,
			ServerName: name,
			StoreDir:   t.TempDir(),
			JetStream:  true,
			Cluster: server.ClusterOpts{
				Host: "127.0.0.1",
				Port: cPort,
				Name: clusterName,
			},
			Accounts:      accs,
			SystemAccount: "SYS",
			Users:         users,
			Routes:        routes,
		}
		return opts
	}

	// 首节点作为 seed：JS 集群模式要求至少一条已配置路由（无路由时
	// enableJetStreamClustering 报 "JetStream cluster requires configured
	// routes or solicited leafnode for the system account" 而拒绝启动，
	// jetstream_cluster.go:1271），故先探测一个空闲端口显式绑定 seed 的
	// 路由监听，并把指向自身的路由作为已配置路由（握手发现 self 后按
	// DuplicateRoute 关闭且不重连，route.go:562/2473，无重连风暴）。
	seedL, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	seedPort := seedL.Addr().(*net.TCPAddr).Port
	seedL.Close()
	seedRoute := fmt.Sprintf("nats://127.0.0.1:%d", seedPort)

	firstOpts := startNode(fmt.Sprintf("S%d", 1), seedPort, server.RoutesFromStr(seedRoute), accs)
	firstSrv := boot(t, firstOpts)
	nodes = append(nodes, ClusterNode{Name: firstOpts.ServerName, URL: firstSrv.ClientURL(), Srv: firstSrv, Opts: firstOpts})

	for i := 2; i <= n; i++ {
		o := startNode(fmt.Sprintf("S%d", i), -1, server.RoutesFromStr(seedRoute), accs)
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
