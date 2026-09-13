// Command testcluster 启动一个 3 节点 JetStream 测试集群，供 M5 Task 14 的
// 真应用 UIA 冒烟（AC-015/016/017）等人工验证场景使用。
//
// 这是测试工具，不是产品面：不入安装包，选项构造镜像
// internal/testutil.StartCluster（SYS/APP 双账户、seed 路由、逐节点启用
// JS、就绪等待），但注册不了 t.Cleanup——进程随 Ctrl-C 退出，节点数据
// 落在临时目录（不清理）。用法：
//
//	go run ./cmd/testcluster
//
// 就绪后打印各节点客户端 URL 与 sys/app 凭据；Ctrl-C 退出。
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/signal"
	"time"

	"github.com/nats-io/jsm.go/serverdata"
	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

const (
	nodes    = 3
	clusterN = "TEST"
	sysUser  = "sys"
	sysPass  = "syspass"
	appUser  = "app"
	appPass  = "apppass"
)

type node struct {
	name string
	srv  *server.Server
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "testcluster:", err)
	os.Exit(1)
}

func main() {
	// SYS/APP 双账户与双用户（server.NewAccount 必需：裸字面量 mconns=0
	// 会被 MaxTotalConnectionsReached 判满拒连——testutil/sysAccounts 同因）。
	accs := []*server.Account{server.NewAccount("SYS"), server.NewAccount("APP")}
	users := []*server.User{
		{Username: sysUser, Password: sysPass, Account: accs[0]},
		{Username: appUser, Password: appPass, Account: accs[1]},
	}

	// seed 的集群路由监听口先探测空闲（JS 集群要求至少一条已配置路由）。
	seedL, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fatal(err)
	}
	seedPort := seedL.Addr().(*net.TCPAddr).Port
	seedL.Close()
	seedRoute := fmt.Sprintf("nats://127.0.0.1:%d", seedPort)

	start := func(name string, cPort int) node {
		store, err := os.MkdirTemp("", "testcluster-"+name+"-*")
		if err != nil {
			fatal(err)
		}
		opts := &server.Options{
			Port:       -1,
			Host:       "127.0.0.1", // 客户端口只绑回环——ClientURL 打印 127.0.0.1 可直连
			ServerName: name,
			StoreDir:   store,
			JetStream:  true,
			Cluster: server.ClusterOpts{
				Host: "127.0.0.1",
				Port: cPort,
				Name: clusterN,
			},
			Accounts:      accs,
			SystemAccount: "SYS",
			Users:         users,
			Routes:        server.RoutesFromStr(seedRoute),
		}
		srv, err := server.NewServer(opts)
		if err != nil {
			fatal(err)
		}
		go srv.Start()
		if !srv.ReadyForConnections(10 * time.Second) {
			fatal(fmt.Errorf("node %s not ready", name))
		}
		return node{name: name, srv: srv}
	}

	ns := make([]node, 0, nodes)
	ns = append(ns, start(fmt.Sprintf("S%d", 1), seedPort))
	for i := 2; i <= nodes; i++ {
		ns = append(ns, start(fmt.Sprintf("S%d", i), -1))
	}

	// opts.JetStream 只开服务器层；账户要在每个节点逐个启用 JS，否则
	// 10039（testutil.StartCluster 同款——EnableJetStream 无对端广播）。
	// 系统账户不可显式启用（"jetstream can not be enabled on the system
	// account"——JS 随 opts.JetStream 对系统账户自动生效），只启 APP。
	for _, n := range ns {
		acc, err := n.srv.LookupAccount("APP")
		if err != nil {
			fatal(err)
		}
		if err := acc.EnableJetStream(nil, nil); err != nil {
			fatal(fmt.Errorf("enable JS on APP@%s: %w", n.name, err))
		}
	}

	// 就绪等待：$SYS PING 广播应答数 == n 且 meta leader 非空（30s 上限，
	// Windows 放宽口径同 testutil）。
	sysURL := ns[0].srv.ClientURL()
	sysNc, err := nats.Connect(sysURL, nats.UserInfo(sysUser, sysPass), nats.Timeout(2*time.Second))
	if err != nil {
		fatal(err)
	}
	defer sysNc.Close()
	deadline := time.Now().Add(30 * time.Second)
	ready := false
	for time.Now().Before(deadline) && !ready {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		got, err := serverdata.CurrentActiveServers(ctx, sysNc, 2*time.Second, quietLogger{})
		if err == nil && got == nodes {
			resps, err := serverdata.DoReq(ctx, server.JszEventOptions{}, "$SYS.REQ.SERVER.PING.JSZ", nodes, sysNc, 2*time.Second, quietLogger{})
			if err == nil {
				for _, raw := range resps {
					var jr server.ServerAPIJszResponse
					if json.Unmarshal(raw, &jr) == nil && jr.Data != nil && jr.Data.Meta != nil && jr.Data.Meta.Leader != "" {
						ready = true
						break
					}
				}
			}
		}
		cancel()
		if !ready {
			time.Sleep(200 * time.Millisecond)
		}
	}
	if !ready {
		fatal(fmt.Errorf("cluster did not form within 30s (want %d nodes)", nodes))
	}

	fmt.Println("test cluster ready (Ctrl-C to stop):")
	for _, n := range ns {
		fmt.Printf("  %-3s %s\n", n.name, n.srv.ClientURL())
	}
	fmt.Printf("  sys account: %s / %s (system account: monitoring + danger ops)\n", sysUser, sysPass)
	fmt.Printf("  app account: %s / %s\n", appUser, appPass)

	// Ctrl-C 退出（无 t.Cleanup 可用——服务器进程随进程终止）。
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	<-ctx.Done()
	fmt.Println("shutting down")
}

// quietLogger 是 jsm.go api.Logger 的静默实现（serverdata.DoReq 全程调用
// Debugf，传 nil 会 panic——testutil 同款）。
type quietLogger struct{}

func (quietLogger) Tracef(string, ...any) {}
func (quietLogger) Debugf(string, ...any) {}
func (quietLogger) Infof(string, ...any)  {}
func (quietLogger) Warnf(string, ...any)  {}
func (quietLogger) Errorf(string, ...any) {}
