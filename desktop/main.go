package main

import (
	"context"
	"embed"
	"log"
	"log/slog"

	"github.com/WenElevating/nats-desktop/desktop/internal/appdir"
	"github.com/WenElevating/nats-desktop/desktop/internal/buckets"
	"github.com/WenElevating/nats-desktop/desktop/internal/connections"
	"github.com/WenElevating/nats-desktop/desktop/internal/jsadmin"
	"github.com/WenElevating/nats-desktop/desktop/internal/logging"
	"github.com/WenElevating/nats-desktop/desktop/internal/messaging"
	"github.com/WenElevating/nats-desktop/desktop/internal/settings"
	"github.com/WenElevating/nats-desktop/desktop/internal/version"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Wails uses Go's `embed` package to embed the frontend files into the binary.
// Any files in the frontend/dist folder will be embedded into the binary and
// made available to the frontend.
// See https://pkg.go.dev/embed for more information.

//go:embed all:frontend/dist
var assets embed.FS

// Tray icon bytes (Task 12): the template appicon.png doubles as the tray
// icon for M1; a dedicated .ico can replace it later.
//
//go:embed build/appicon.png
var iconBytes []byte

// mainWindowName is the WebviewWindow name the tray and second-instance
// launch use to re-show the main window.
const mainWindowName = "main"

// singleInstanceID identifies this application to the Wails single-instance
// lock (fixed so both dev and production builds agree on it).
const singleInstanceID = "nats-desktop-a3c86f2e-5b14-4f0d-9d7e-8c21b4e64f17"

// main function serves as the application's entry point. It initializes the
// application, creates the main window, and runs the app shell frontend.
func main() {

	// Create a new Wails application by providing the necessary options.
	// Variables 'Name' and 'Description' are for application metadata.
	// 'Assets' configures the asset server with the 'FS' variable pointing to the frontend files.
	// 'Services' is a list of Go struct instances. The frontend has access to the methods of these instances.
	// 'Mac' options tailor the application when running on macOS.
	settingsPath, _ := settings.Path()
	settingsSvc := settings.NewService(settingsPath)
	s, _ := settings.Load(settingsPath)

	// Rotating file logger (spec §13): injected as the Wails system logger
	// so framework messages follow the same file/level policy, and reused
	// as the connection manager's logger.
	logsDir, logsErr := appdir.LogsDir()
	var logger *slog.Logger
	if logsErr == nil {
		if l, err := logging.New(logsDir, s.Behavior.LogLevel); err == nil {
			logger = l
		}
	}

	// Connections: one registry shared by the context store and the live
	// connection manager; Manager state transitions are forwarded to the
	// frontend as "conn:state" events (spec §7.3) and side-banded into the
	// messaging SessionManager so its sessions resubscribe on reconnect.
	//
	// The conn:state mirror calls msgSvc.Sessions.NotifyConnState directly:
	// it is documented safe from the Manager's emit path (the resubscribe
	// work runs on its own worker goroutine and the notification send is
	// coalescing and non-blocking), so no extra channel/goroutine is needed.
	// msgSvc is declared ahead of the closure and assigned right after
	// construction — no transition can fire in between (nothing dials before
	// Connect, which main only reaches after the assignment), and the nil
	// guard covers the emit-before-construct window anyway.
	reg, backend := connections.NewRegistryAndBackend()
	var msgSvc *messaging.MessagingService
	var bktSvc *buckets.BucketService
	emit := func(name string, data any) {
		if app := application.Get(); app != nil {
			app.Event.Emit(name, data)
		}
		if name == connections.EventConnState {
			if ev, ok := data.(connections.StateEvent); ok {
				if msgSvc != nil {
					msgSvc.Sessions.NotifyConnState(ev)
				}
				// Watch 断连全停（Task 4）：非 connected 状态停掉全部 KV/对象
				// watcher 并清空注册表；通知路径非阻塞，Manager emit 路径安全。
				if bktSvc != nil {
					bktSvc.NotifyConnState(ev)
				}
			}
		}
	}
	manager := connections.NewManager(reg, logger, emit)
	msgSvc = messaging.NewMessagingService(manager, logger, emit, settingsPath)

	// JetStream administration facade (streams/consumers/backup, spec
	// §6.6/§6.7): CallResult-embedding results over jsm handles keyed off the
	// active connection's domain/API prefix.
	jsAdminSvc := jsadmin.NewJetAdminService(manager, logger, emit, settingsPath)

	// Bucket management facade (KeyValue/Object Store, spec §6.8/§6.9):
	// CallResult-embedding results over jetstream KV/OS handles keyed off the
	// active connection's domain/API prefix. bktSvc is assigned right after
	// construction so the emit closure's conn:state side-band (above) reaches
	// NotifyConnState — watchers stop-all on disconnect/failure.
	bucketSvc := buckets.NewBucketService(manager, logger, emit, settingsPath)
	bktSvc = bucketSvc

	// settings.LastActiveContext persistence: load-modify-save on every
	// successful Connect (spec §6.1). Routed through settings.Update so it
	// shares the same serializer as SaveSettings — a settings save landing
	// mid-persistActive must not lose the update (or vice versa).
	persistActive := func(name string) error {
		return settings.Update(settingsPath, func(cur *settings.Settings) {
			cur.LastActiveContext = name
		})
	}
	connSvc := connections.NewService(connections.NewStoreWithBackend(reg, backend), manager, logger, persistActive)

	// showMainWindow reveals and focuses the main window; used by the tray
	// Show item and the single-instance second-launch callback. Resolves the
	// app lazily because both callbacks must be constructible before it exists.
	showMainWindow := func() {
		if a := application.Get(); a != nil {
			if w, ok := a.Window.GetByName(mainWindowName); ok {
				w.Show()
				w.Focus()
			}
		}
	}

	opts := application.Options{
		Name:        "nats-desktop",
		Description: "NATS desktop client",
		Services: []application.Service{
			application.NewService(settingsSvc),
			application.NewService(logging.NewService()),
			application.NewService(connSvc),
			application.NewService(msgSvc),
			application.NewService(jsAdminSvc),
			application.NewService(bucketSvc),
			application.NewService(version.NewService()),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		// Single instance (Task 12): a second launch focuses the existing
		// window instead of spawning another process.
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID:               singleInstanceID,
			OnSecondInstanceLaunch: func(application.SecondInstanceData) { showMainWindow() },
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	}
	if logger != nil {
		opts.Logger = logger
		opts.LogLevel = logging.ParseLevel(s.Behavior.LogLevel)
	}

	app := application.New(opts)

	// Single main window hosting the app shell (sidebar + page content).
	// Named so the tray and second-instance callbacks can find it.
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:   mainWindowName,
		Title:  "NATS Desktop",
		Width:  1200,
		Height: 800,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(12, 12, 15),
		URL:              "/",
	})

	// System tray (Task 12): Show/Quit menu. On Windows the app keeps running
	// with the window closed; Quit here is the explicit exit path.
	systray := app.SystemTray.New()
	systray.SetIcon(iconBytes)
	systray.SetTooltip("NATS Desktop")
	trayMenu := app.NewMenu()
	trayMenu.Add("Show").OnClick(func(*application.Context) { showMainWindow() })
	trayMenu.Add("Quit").OnClick(func(*application.Context) { app.Quit() })
	systray.SetMenu(trayMenu)

	// Startup update check (spec §6.13): only when the user opted in
	// (settings.Privacy.UpdateCheck); 5s timeout inside CheckLatest; any
	// failure is silent. A newer release reaches the frontend as a single
	// "update:available" event, rendered once as a dismissible toast.
	if s.Privacy.UpdateCheck {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), version.CheckTimeout())
			defer cancel()
			info, err := version.CheckLatest(ctx, version.GitHubRepo, version.Current())
			if err == nil && info.HasUpdate {
				app.Event.Emit("update:available", info)
			}
		}()
	}

	// Startup restore (spec §6.1): when a last active context is recorded
	// and still known, try to reconnect exactly once — no retry loop; on
	// failure the state stays failed and the app remains usable. Asynchronous
	// so a dead server's dial timeout cannot delay the window; the frontend
	// hydrates the outcome via ConnSnapshot()/events.
	if s.LastActiveContext != "" && reg.Known(context.Background(), s.LastActiveContext) {
		go func(name string) {
			if err := manager.Connect(context.Background(), name); err != nil {
				if logger != nil {
					logger.Warn("startup connection restore failed", "context", name, "error", err)
				} else {
					log.Printf("startup connection restore failed for %q: %v", name, err)
				}
			}
		}(s.LastActiveContext)
	}

	// Ready marker: proves the full startup path (settings, logger, window,
	// tray, services) completed before the event loop starts — the acceptance
	// log line M1 lacked.
	if logger != nil {
		logger.Info("ready", "version", version.Current())
	}

	// Run the application. This blocks until the application has been exited.
	err := app.Run()

	// If an error occurred while running the application, log it and exit.
	if err != nil {
		log.Fatal(err)
	}
}
