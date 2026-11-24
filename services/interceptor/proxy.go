package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// ProxyService handles HTTP proxying
type ProxyService struct {
	client      *http.Client
	mockManager *MockManager
	urlMap      func() UrlMap
	origin      string // service name this interceptor belongs to (empty for global)
	servicePort string // port the local service listens on (e.g. "4000")
}

// NewProxyService creates a new proxy service
func NewProxyService(cfg *Config, mockManager *MockManager, urlMap func() UrlMap) *ProxyService {
	// Create a custom dialer that bypasses dnsmasq by using Docker DNS directly
	// This prevents the circular routing issue where dnsmasq resolves service names
	// to 127.0.0.1, causing the interceptor to route traffic back to itself
	var dialer *net.Dialer
	if cfg.DNSIP != "" {
		log.Printf("[Interceptor] Using custom DNS resolver: %s:53 (bypassing dnsmasq)", cfg.DNSIP)
		dialer = &net.Dialer{
			Resolver: &net.Resolver{
				PreferGo: true,
				Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
					// Always use Docker DNS instead of the system resolver (dnsmasq)
					d := net.Dialer{}
					return d.DialContext(ctx, "udp", cfg.DNSIP+":53")
				},
			},
		}
	} else {
		log.Printf("[Interceptor] DNS IP not set, using system DNS resolver")
		dialer = &net.Dialer{}
	}

	transport := &http.Transport{
		DialContext:         dialer.DialContext,
		MaxIdleConns:        cfg.MaxIdleConns,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     cfg.IdleConnTimeout,
	}

	client := &http.Client{
		Timeout:   cfg.RequestTimeout,
		Transport: transport,
		// Do not follow redirects inside the proxy. A transparent forwarding
		// proxy must hand 3xx responses back to the caller so the caller's
		// HTTP client decides whether to follow. Following here would hide
		// intermediate hops from mock matching, logging, and URL rewriting,
		// since followed requests bypass HandleRequest entirely.
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	return &ProxyService{
		client:      client,
		mockManager: mockManager,
		urlMap:      urlMap,
		origin:      cfg.Origin,
		servicePort: cfg.ServicePort,
	}
}

// HandleRequest processes an incoming HTTP request
func (p *ProxyService) HandleRequest(r *http.Request) (*http.Response, error) {
	// Check for mock first
	if mock := p.mockManager.FindMatch(r); mock != nil {
		return p.mockManager.ApplyMock(mock)
	}

	// Forward request to target
	return p.forwardRequest(r)
}

// forwardRequest forwards the request to the target service
func (p *ProxyService) forwardRequest(r *http.Request) (*http.Response, error) {
	targetServiceName := targetService(r, p.urlMap())
	if p.origin == "" && targetServiceName == "" && !strings.Contains(r.Host, ".") {
		return nil, fmt.Errorf("no service named %q", r.Host)
	}

	// Determine target URL
	targetURL := p.getTargetURL(r)
	log.Printf("[Interceptor] Forwarding request: %s %s -> %s", r.Method, r.URL.Path, targetURL)

	// Read request body
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		log.Printf("[Interceptor] Error reading request body: %v", err)
		return nil, err
	}
	r.Body.Close()

	// Create new request to target
	req, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL, bytes.NewReader(bodyBytes))
	if err != nil {
		log.Printf("[Interceptor] Error creating request to target: %v", err)
		return nil, err
	}

	// Copy headers (excluding hop-by-hop headers)
	for key, values := range r.Header {
		if !isHopByHopHeader(key) {
			for _, value := range values {
				req.Header.Add(key, value)
			}
		}
	}

	// Set Host to the target URL's host so downstream interceptors can
	// identify the service. Without this, the original Host header
	// (e.g., "interceptor-service:80") would propagate and confuse routing.
	if parsed, err := url.Parse(targetURL); err == nil && parsed.Host != "" {
		req.Host = parsed.Host
	} else {
		req.Host = r.Host
	}

	// Forward request
	resp, err := p.client.Do(req)
	if err != nil {
		log.Printf("[Interceptor] Error forwarding request to %s: %v", targetURL, err)
		return nil, err
	}

	log.Printf("[Interceptor] Received response from %s: status=%d", targetURL, resp.StatusCode)

	// A redirect from an external host is its own business.
	if targetServiceName != "" {
		p.rewriteLocationHeader(resp, targetServiceName)
	}

	return resp, nil
}

// rewriteLocationHeader translates container-internal hostnames in redirect Location
// headers back to service names from the urlMap. Containers may generate redirects
// using their own hostname which is not routable from outside the container.
func (p *ProxyService) rewriteLocationHeader(resp *http.Response, targetServiceName string) {
	location := resp.Header.Get("Location")
	if location == "" {
		return
	}

	parsed, err := url.Parse(location)
	if err != nil || parsed.Host == "" {
		return
	}

	hostname := stripPortFromHost(parsed.Host)
	urlMap := p.urlMap()

	// Check if the hostname is already a known service name — no rewrite needed.
	if _, exists := urlMap[hostname]; exists {
		return
	}

	// Container hostnames may follow "<containerName>-<hash>" patterns.
	// Find the urlMap key that is a prefix of the hostname.
	for serviceName, info := range urlMap {
		if strings.HasPrefix(hostname, serviceName+"-") {
			parsed.Host = serviceName
			parsed.Scheme = info.Scheme
			rewritten := parsed.String()
			resp.Header.Set("Location", rewritten)
			log.Printf("[Interceptor] Rewrote Location: %s -> %s", location, rewritten)
			return
		}
	}

	// Localhost-like addresses (0.0.0.0, 127.0.0.1, localhost) mean the target
	// service redirected using its own bind address. Rewrite to the target
	// service name (from the request Host header) so the redirect is routable.
	if hostname == "0.0.0.0" || hostname == "127.0.0.1" || hostname == "localhost" {
		targetName := targetServiceName
		if targetName != "" {
			if info, exists := urlMap[targetName]; exists {
				parsed.Host = targetName
				parsed.Scheme = info.Scheme
				rewritten := parsed.String()
				resp.Header.Set("Location", rewritten)
				log.Printf("[Interceptor] Rewrote Location (localhost): %s -> %s", location, rewritten)
			}
		}
	}
}

// getTargetURL determines the target URL for the request
func (p *ProxyService) getTargetURL(r *http.Request) string {
	urlMap := p.urlMap()

	// A host outside the environment: go to the real one.
	serviceInfo, exists := urlMap[targetService(r, urlMap)]
	if !exists {
		return schemeUsed(r) + "://" + r.Host + r.URL.RequestURI()
	}

	baseURL := serviceInfo.URL
	if baseURL == "" {
		baseURL = r.Host
	}
	if !strings.HasPrefix(baseURL, "http://") && !strings.HasPrefix(baseURL, "https://") {
		scheme := serviceInfo.Scheme
		if scheme == "" {
			scheme = "http"
		}
		baseURL = scheme + "://" + baseURL
	}
	return appendServicePort(baseURL, serviceInfo.Port) + r.URL.RequestURI()
}

// takeTargetFromPath moves the target of a test step's request, which is the
// first segment of its path, to where it is for any other request: the Host.
func takeTargetFromPath(r *http.Request, urlMap UrlMap) {
	r.Host, _, _ = strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	stripFirstSegment(r.URL)
	if targetService(r, urlMap) != "" {
		return
	}
	if strings.Contains(r.Host, ".") {
		r.URL.Scheme = "https" // a step doesn't say which scheme to use
		return
	}
	// Accept other spellings of a service name (e.g., MY_SERVICE → my-service)
	if name := normalizeForUrlMap(r.Host); urlMap[name].Name != "" {
		r.Host = name
	}
}

// schemeUsed returns the scheme of a request received or made up by the interceptor.
func schemeUsed(r *http.Request) string {
	switch {
	case r.TLS != nil:
		return "https"
	case r.URL.Scheme != "":
		return r.URL.Scheme
	default:
		return "http"
	}
}

// stripFirstSegment removes the first segment of a URL's path, keeping how the
// rest is encoded.
func stripFirstSegment(u *url.URL) {
	strip := func(path string) string {
		_, rest, _ := strings.Cut(strings.TrimPrefix(path, "/"), "/")
		return "/" + rest
	}
	u.Path = strip(u.Path)
	if u.RawPath != "" {
		u.RawPath = strip(u.RawPath)
	}
}

// targetService returns the service a request is for, or "" if its Host isn't
// exactly the name of one.
func targetService(r *http.Request, urlMap UrlMap) string {
	name := stripPortFromHost(r.Host)
	if _, exists := urlMap[name]; exists {
		return name
	}
	return ""
}

// normalizeForUrlMap normalizes a name to match Docker service naming conventions
// (lowercase, replace invalid chars with -)
func normalizeForUrlMap(name string) string {
	name = strings.ToLower(name)
	result := make([]byte, 0, len(name))
	for i := 0; i < len(name); i++ {
		c := name[i]
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' {
			result = append(result, c)
		} else {
			result = append(result, '-')
		}
	}
	return strings.Trim(string(result), "-")
}

// stripPortFromHost removes the port from a hostname if present
func stripPortFromHost(host string) string {
	if idx := strings.LastIndex(host, ":"); idx != -1 {
		return host[:idx]
	}
	return host
}

// isHopByHopHeader checks if header should not be forwarded
func isHopByHopHeader(key string) bool {
	hopHeaders := []string{
		"Connection",
		"Keep-Alive",
		"Proxy-Authenticate",
		"Proxy-Authorization",
		"Te",
		"Trailers",
		"Transfer-Encoding",
		"Upgrade",
	}
	for _, h := range hopHeaders {
		if strings.EqualFold(key, h) {
			return true
		}
	}
	return false
}

// appendServicePort appends the real service port to a URL when the urlMap
// stores port-less URLs (callers connect on port 80 via the interceptor) but
// the interceptor needs to forward to the service's actual port.
func appendServicePort(baseURL string, port int) string {
	if port == 0 {
		return baseURL
	}
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return baseURL
	}
	parsed.Host = parsed.Hostname() + ":" + fmt.Sprintf("%d", port)
	return parsed.String()
}
