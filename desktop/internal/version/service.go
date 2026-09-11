package version

import (
	"context"
)

// Service is the Wails-bound facade exposing app metadata and an on-demand
// update check to the frontend (registered alongside the settings, logging
// and connections services).
type Service struct{}

// NewService returns the version facade service.
func NewService() *Service { return &Service{} }

// AppVersion returns the running application version ("0.1.0" during M1).
func (s *Service) AppVersion() string { return Current() }

// CheckUpdate queries GitHub for the latest release of this project with a
// 5s timeout. The startup auto-check emits "update:available" instead; this
// method backs any future manual "check for updates" affordance.
func (s *Service) CheckUpdate() (UpdateInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), checkTimeout)
	defer cancel()
	return CheckLatest(ctx, GitHubRepo, Current())
}
