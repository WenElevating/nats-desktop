// Package natsver compares NATS Server version strings against a minimum
// required release (e.g. the NATS Server 2.11 message-tracing gate). Parsing
// mirrors natscli internal/util's semver handling (reimplemented: that
// package is internal to the natscli module).
package natsver

import (
	"errors"
	"regexp"
	"strconv"
)

// semVerRe and versionComponents mirror natscli internal/util's semver
// parsing (reimplemented: that package is internal to the natscli module).
var semVerRe = regexp.MustCompile(`\Av?([0-9]+)\.?([0-9]+)?\.?([0-9]+)?`)

func versionComponents(version string) (major, minor, patch int, err error) {
	m := semVerRe.FindStringSubmatch(version)
	if m == nil {
		return 0, 0, 0, errors.New("invalid semver")
	}
	major, err = strconv.Atoi(m[1])
	if err != nil {
		return -1, -1, -1, err
	}
	if m[2] != "" {
		minor, err = strconv.Atoi(m[2])
		if err != nil {
			return -1, -1, -1, err
		}
	}
	if m[3] != "" {
		patch, err = strconv.Atoi(m[3])
		if err != nil {
			return -1, -1, -1, err
		}
	}
	return major, minor, patch, nil
}

// ServerAtLeast reports whether the version string (e.g. "2.15.0-preview.1",
// leading "v" tolerated) meets the given minimum (mirror of natscli
// util.VersionIsAtLeast). Unparseable versions return an error instead of a
// silently false comparison.
func ServerAtLeast(version string, major, minor, patch int) (bool, error) {
	smajor, sminor, spatch, err := versionComponents(version)
	if err != nil {
		return false, err
	}
	if smajor < major || (smajor == major && sminor < minor) || (smajor == major && sminor == minor && spatch < patch) {
		return false, nil
	}
	return true, nil
}
