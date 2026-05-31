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
	// Create a custom dialer that bypasses dnsmasq by using K8s DNS directly
	// This prevents the circular routing issue where dnsmasq resolves service names
	// to 127.0.0.1, causing the interceptor to route traffic back to itself
	var dialer *net.Dialer
	if cfg.K8sDNSIP != "" {
		log.Printf("[Interceptor] Using custom DNS resolver: %s:53 (bypassing dnsmasq)", cfg.K8sDNSIP)
		dialer = &net.Dialer{
			Resolver: &net.Resolver{
				PreferGo: true,
				Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
					// Always use K8s DNS instead of the system resolver (dnsmasq)
					d := net.Dialer{}
					return d.DialContext(ctx, "udp", cfg.K8sDNSIP+":53")
				},
			},
		}
	} else {
		log.Printf("[Interceptor] K8S_DNS_IP not set, using system DNS resolver")
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

	p.rewriteLocationHeader(resp)

	return resp, nil
}

// rewriteLocationHeader translates pod-internal hostnames in redirect Location
// headers back to service names from the urlMap. Pods may generate redirects
// using their own hostname (e.g., "nextjs-demo-8d4698b56-892gj:3000") which
// is not routable from outside the pod.
func (p *ProxyService) rewriteLocationHeader(resp *http.Response) {
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

	// Pod hostnames follow "<k8sName>-<replicaset-hash>-<pod-hash>".
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
}

// getTargetURL determines the target URL for the request
func (p *ProxyService) getTargetURL(r *http.Request) string {
	urlMap := p.urlMap()

	serviceName := extractServiceNameFromRequest(r, urlMap)

	// If service name was found in path, remove the raw path[0] from the path for forwarding.
	// The raw path[0] may differ from serviceName if normalization was applied (e.g., MY_SERVICE → my-service).
	if serviceName != "" {
		pathParts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
		if len(pathParts) > 0 && (pathParts[0] == serviceName || normalizeForUrlMap(pathParts[0]) == serviceName) {
			// Remove the raw path[0] from path for forwarding
			if len(pathParts) > 1 {
				r.URL.Path = "/" + strings.Join(pathParts[1:], "/")
			} else {
				r.URL.Path = "/"
			}
		}
	}

	// Per-service interceptor: forward to localhost:servicePort.
	// All traffic arriving at a per-service interceptor is destined for its
	// local service — route there directly instead of going back through
	// DNS/network alias (which would loop in Docker mode).
	if p.origin != "" && p.servicePort != "" && (serviceName == p.origin || serviceName == "") {
		return fmt.Sprintf("http://localhost:%s%s?%s", p.servicePort, r.URL.Path, r.URL.RawQuery)
	}

	// Check if we have a URL mapping
	if serviceInfo, exists := urlMap[serviceName]; exists {
		baseURL := serviceInfo.URL
		if baseURL == "" {
			// If URL is not provided, construct from scheme and host
			scheme := serviceInfo.Scheme
			if scheme == "" {
				scheme = "http"
			}
			baseURL = scheme + "://" + r.Host
		}
		// If baseURL already contains a scheme (starts with http:// or https://), use it directly
		// Otherwise, prepend the scheme
		if !strings.HasPrefix(baseURL, "http://") && !strings.HasPrefix(baseURL, "https://") {
			scheme := serviceInfo.Scheme
			if scheme == "" {
				scheme = "http"
			}
			baseURL = scheme + "://" + baseURL
		}
		return baseURL + r.URL.Path + "?" + r.URL.RawQuery
	}

	// If path[0] looks like an external hostname (has 2+ dots, e.g., "api.stripe.com"),
	// treat it as an external passthrough: strip path[0] and forward to it directly.
	// This handles the case where the test-agent sends interceptorURL + "/api.stripe.com/v1/charges".
	// Requires 2+ dots to avoid false positives on paths like "/api.v2/resource".
	pathParts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if len(pathParts) > 0 && pathParts[0] != "" && strings.Count(pathParts[0], ".") >= 2 {
		externalHost := pathParts[0]
		remainingPath := "/"
		if len(pathParts) > 1 {
			remainingPath = "/" + strings.Join(pathParts[1:], "/")
		}
		externalURL := "https://" + externalHost + remainingPath
		if r.URL.RawQuery != "" {
			externalURL += "?" + r.URL.RawQuery
		}
		log.Printf("[Interceptor] External passthrough: routing to %s", externalURL)
		return externalURL
	}

	// Default fallback: forward to the original host
	scheme := r.URL.Scheme
	if scheme == "" {
		scheme = "http"
	}
	return scheme + "://" + r.Host + r.URL.Path + "?" + r.URL.RawQuery
}

// extractServiceName extracts the service name from a hostname
// e.g., "nginx-test.dokkimi-xxx.svc.cluster.local" -> "nginx-test"
// e.g., "nginx-test" -> "nginx-test"
func extractServiceName(hostname string) string {
	if idx := strings.Index(hostname, "."); idx != -1 {
		return hostname[:idx]
	}
	return hostname
}

// extractServiceNameFromRequest extracts the target service name from a request
// by checking the Host header first (for service-to-service calls), then the path.
// Returns the service name if it exists in the urlMap, empty string otherwise.
func extractServiceNameFromRequest(r *http.Request, urlMap UrlMap) string {
	// First try Host header - this is what services use when calling each other
	// e.g., http://traffic-tester-2/test -> Host: traffic-tester-2
	if r.Host != "" {
		hostname := stripPortFromHost(r.Host)
		// Look up directly in urlMap (hostname should match k8sName)
		if _, exists := urlMap[hostname]; exists {
			return hostname
		}
		// Also try extracting service name from FQDN
		// e.g., "nginx-test.dokkimi-xxx.svc.cluster.local" -> "nginx-test"
		serviceName := extractServiceName(hostname)
		if serviceName != hostname {
			if _, exists := urlMap[serviceName]; exists {
				return serviceName
			}
		}
	}

	// Fallback: try path (for browser/ingress requests where service name is in path)
	pathParts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if len(pathParts) > 0 && pathParts[0] != "" {
		if _, exists := urlMap[pathParts[0]]; exists {
			return pathParts[0]
		}
		// Try normalized form (e.g., MY_SERVICE → my-service)
		normalized := normalizeForUrlMap(pathParts[0])
		if normalized != pathParts[0] {
			if _, exists := urlMap[normalized]; exists {
				return normalized
			}
		}
	}

	return ""
}

// normalizeForUrlMap normalizes a name to match K8s service naming conventions
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
