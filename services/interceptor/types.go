package main

import "regexp"

// MockEndpoint defines a mock response configuration
type MockEndpoint struct {
	Method              string  `json:"method"`
	Origin              string  `json:"origin"`
	Target              string  `json:"target"`
	Path                string  `json:"path"`
	RequestBodyContains *string `json:"requestBodyContains,omitempty"`
	RequestBodyMatches  *string `json:"requestBodyMatches,omitempty"`
	DelayMS             *int    `json:"delayMS,omitempty"`
	ResponseStatus      *int    `json:"responseStatus,omitempty"`
	ResponseHeaders     *string `json:"responseHeaders,omitempty"`
	ResponseBody        *string `json:"responseBody,omitempty"`

	// Compiled regex, populated at config load time (not serialized)
	compiledBodyRegex *regexp.Regexp
}

// ServiceInfo contains routing information for a service
type ServiceInfo struct {
	Scheme         string `json:"scheme"`
	URL            string `json:"url"`
	Name           string `json:"name"`
	InstanceItemID string `json:"instanceItemId,omitempty"`
}

// UrlMap maps hostnames to service information
type UrlMap map[string]ServiceInfo

