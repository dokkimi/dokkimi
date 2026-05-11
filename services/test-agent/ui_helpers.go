package main

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// applyExtractRegex applies an optional regex to raw extracted text.
//
// If pattern is empty, the raw string is returned trimmed. Otherwise pattern
// must be a valid Go regex; the match at group `group` is returned (default
// group = 0, the whole match). Returns an error if pattern fails to compile or
// does not match.
func applyExtractRegex(raw string, pattern string, group int) (string, error) {
	if pattern == "" {
		return strings.TrimSpace(raw), nil
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return "", fmt.Errorf("extract pattern compile: %w", err)
	}
	m := re.FindStringSubmatch(raw)
	if m == nil {
		return "", fmt.Errorf("extract pattern %q did not match", pattern)
	}
	if group < 0 || group >= len(m) {
		return "", fmt.Errorf(
			"extract pattern %q has %d capture groups; requested group %d out of range",
			pattern, len(m)-1, group,
		)
	}
	return m[group], nil
}

// resolveExtractGroup turns a pointer-to-int (JSON optional) into an int
// suitable for applyExtractRegex. If group is nil and a pattern is set, we
// default to group 1 (first capture) to match typical user intent.
func resolveExtractGroup(group *int, hasPattern bool) int {
	if group != nil {
		return *group
	}
	if hasPattern {
		return 1
	}
	return 0
}

// extractURLPart returns the requested part of a URL. An empty or "full" part
// returns the URL unchanged. Unknown parts return an error.
func extractURLPart(raw string, part UIExtractURLPart) (string, error) {
	if part == "" || part == UIURLPartFull {
		return raw, nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("extract url parse: %w", err)
	}
	switch part {
	case UIURLPartPathname:
		return u.Path, nil
	case UIURLPartSearch:
		if u.RawQuery == "" {
			return "", nil
		}
		return "?" + u.RawQuery, nil
	case UIURLPartHash:
		if u.Fragment == "" {
			return "", nil
		}
		return "#" + u.Fragment, nil
	case UIURLPartHost:
		return u.Host, nil
	default:
		return "", fmt.Errorf("extract url: unknown part %q", part)
	}
}

// resolveUIPath joins a base URL with a path-or-URL from a `visit` sub-step.
// If `pathOrURL` is already absolute (has scheme), it is returned as-is so
// users can link out. Otherwise it is appended to baseURL.
func resolveUIPath(baseURL string, pathOrURL string) (string, error) {
	if strings.HasPrefix(pathOrURL, "http://") || strings.HasPrefix(pathOrURL, "https://") {
		return pathOrURL, nil
	}
	if baseURL == "" {
		return "", fmt.Errorf("ui visit %q: no baseURL and path is not absolute", pathOrURL)
	}
	base := strings.TrimRight(baseURL, "/")
	if pathOrURL == "" {
		return base, nil
	}
	if !strings.HasPrefix(pathOrURL, "/") {
		pathOrURL = "/" + pathOrURL
	}
	return base + pathOrURL, nil
}
