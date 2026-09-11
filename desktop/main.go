package main

import (
	"embed"

	"log"

	"github.com/WenElevating/nats-desktop/desktop/internal/appdir"
	"github.com/WenElevating/nats-desktop/desktop/internal/logging"
	"github.com/WenElevating/nats-desktop/desktop/internal/settings"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Wails uses Go's `embed` package to embed the frontend files into the binary.
// Any files in the frontend/dist folder will be embedded into the binary and
// made available to the frontend.
// See https://pkg.go.dev/embed for more information.

//go:embed all:frontend/dist
var assets embed.FS

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

	opts := application.Options{
		Name:        "nats-desktop",
		Description: "NATS desktop client",
		Services: []application.Service{
			application.NewService(settingsSvc),
			application.NewService(logging.NewService()),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	}

	// Rotating file logger (spec §13): injected as the Wails system logger
	// so framework messages follow the same file/level policy.
	logsDir, logsErr := appdir.LogsDir()
	if logsErr == nil {
		if logger, err := logging.New(logsDir, s.Behavior.LogLevel); err == nil {
			opts.Logger = logger
			opts.LogLevel = logging.ParseLevel(s.Behavior.LogLevel)
		}
	}

	app := application.New(opts)

	// Single main window hosting the app shell (sidebar + page content).
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "NATS Desktop",
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

	// Run the application. This blocks until the application has been exited.
	err := app.Run()

	// If an error occurred while running the application, log it and exit.
	if err != nil {
		log.Fatal(err)
	}
}
