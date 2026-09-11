// Package version implements the M1 update check (spec §6.13): semantic
// version comparison plus a GitHub releases/latest lookup with a 5s timeout.
// Failures are always silent at the call site — an unavailable update feed
// must never disturb the app.
package version

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// appVersion is the running application version. M1 dev value; a build-time
// injection (ldflags) replaces it in later milestones.
const appVersion = "0.1.0"

// GitHubRepo is the repository whose releases are checked for updates
// (TODO-001: repository rename pending).
const GitHubRepo = "WenElevating/nats-desktop"

// githubAPIBase is the public GitHub REST API root.
const githubAPIBase = "https://api.github.com"

// checkTimeout bounds the whole update-check HTTP round trip.
const checkTimeout = 5 * time.Second

// UpdateInfo describes the outcome of an update check.
type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	URL       string `json:"url"`
	HasUpdate bool   `json:"has_update"`
}

// Current returns the running application version ("0.1.0" during M1).
func Current() string { return appVersion }

// CheckTimeout returns the update-check round-trip bound so call sites
// (startup goroutine, bound service) apply the same deadline.
func CheckTimeout() time.Duration { return checkTimeout }

// CompareVersions compares two dotted version strings numerically: a leading
// "v"/"V" is stripped, segments are compared as integers left to right, and
// missing trailing segments count as 0. It returns -1 when a < b, 1 when
// a > b, and 0 when equal. Non-numeric segments (e.g. pre-release suffixes)
// compare as 0.
func CompareVersions(a, b string) int {
	as := splitSegments(a)
	bs := splitSegments(b)
	n := max(len(as), len(bs))
	for i := 0; i < n; i++ {
		av, bv := 0, 0
		if i < len(as) {
			av = as[i]
		}
		if i < len(bs) {
			bv = bs[i]
		}
		if av != bv {
			if av < bv {
				return -1
			}
			return 1
		}
	}
	return 0
}

// splitSegments strips the v-prefix and parses each dot-separated segment as
// an int; non-numeric segments become 0.
func splitSegments(v string) []int {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(strings.TrimPrefix(v, "v"), "V")
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ".")
	out := make([]int, len(parts))
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			n = 0
		}
		out[i] = n
	}
	return out
}

// apiURL returns the GitHub releases/latest API endpoint for a repo
// ("owner/name").
func apiURL(repo string) string {
	return githubAPIBase + "/repos/" + repo + "/releases/latest"
}

// CheckLatest queries GitHub for the latest release of repo ("owner/name")
// and reports whether it is newer than current. Errors are returned, never
// surfaced to the user directly (call sites run it silently).
func CheckLatest(ctx context.Context, repo, current string) (UpdateInfo, error) {
	return CheckLatestAt(ctx, apiURL(repo), current)
}

// CheckLatestAt is CheckLatest with an injectable API base URL (for tests).
func CheckLatestAt(ctx context.Context, apiURL, current string) (UpdateInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return UpdateInfo{}, fmt.Errorf("update check request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "nats-desktop") // GitHub rejects requests without a UA.

	client := &http.Client{Timeout: checkTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return UpdateInfo{}, fmt.Errorf("update check: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return UpdateInfo{}, fmt.Errorf("update check: status %d", resp.StatusCode)
	}

	var body struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return UpdateInfo{}, fmt.Errorf("update check decode: %w", err)
	}
	if body.TagName == "" {
		return UpdateInfo{}, fmt.Errorf("update check: release has no tag_name")
	}

	return UpdateInfo{
		Current:   current,
		Latest:    body.TagName,
		URL:       body.HTMLURL,
		HasUpdate: CompareVersions(body.TagName, current) > 0,
	}, nil
}
