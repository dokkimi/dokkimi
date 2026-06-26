package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
)

// Version is set at build time via -ldflags "-X main.Version=..."
var Version = "dev"

func main() {
	log.Printf("interceptor version=%s", Version)

	// Load configuration
	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Load CA cert and key for HTTPS MITM (optional)
	var caCert *x509.Certificate
	var caKey *rsa.PrivateKey
	if cfg.CACertPath != "" && cfg.CAKeyPath != "" {
		cert, key, err := loadCA(cfg.CACertPath, cfg.CAKeyPath)
		if err != nil {
			log.Printf("Failed to load CA for HTTPS MITM: %v", err)
		} else {
			caCert = cert
			caKey = key
		}
	}

	// Initialize components
	cache := NewMockCache(cfg.MockCacheTTL)

	// Get URL map function
	getUrlMap := func() UrlMap {
		return cache.GetUrlMap()
	}

	mockManager := NewMockManager(cache, nil, cfg.Origin, getUrlMap)
	proxyService := NewProxyService(cfg, mockManager, getUrlMap)

	// Initialize logger (only if logging is enabled)
	var logger *Logger
	if cfg.LogActions {
		logger = NewLogger(cfg.ControlTowerURL, cfg.LoggingTimeout, nil)
		if cfg.TestAgentURL != "" {
			logger.SetTestAgentURL(cfg.TestAgentURL)
		}
		defer logger.Stop()
	}

	// Load config from file
	if cfg.ConfigFilePath == "" {
		log.Fatalf("CONFIG_FILE_PATH is required")
	}
	loader := NewFileConfigLoader(cfg.ConfigFilePath, cache)
	if err := loader.Load(); err != nil {
		log.Fatalf("Failed to load config from file: %v", err)
	}
	log.Printf("Config loaded from file: %s", cfg.ConfigFilePath)

	// Initialize test execution logger (only in test mode)
	var testExecutionLogger *TestExecutionLogger
	if cfg.TestAgentURL != "" && cfg.ControlTowerURL != "" {
		testExecutionLogger = NewTestExecutionLogger(cfg.ControlTowerURL, cfg.Namespace, nil)
		defer testExecutionLogger.Stop()
		log.Printf("Test execution logger started for instance %s", cfg.Namespace)
	}

	// Initialize health checker (if configured)
	var healthChecker *HealthChecker
	if cfg.HealthCheckEndpoint != "" && cfg.ServicePort != "" && cfg.NamespaceItemID != "" {
		// Get instance item name from INSTANCE_ITEM_NAME env var (set by deployment)
		instanceItemName := os.Getenv("INSTANCE_ITEM_NAME")
		if instanceItemName == "" {
			// Fallback: if not set, we can't do health checks
			log.Printf("Health check: INSTANCE_ITEM_NAME not set, skipping health checker")
		} else {
			healthConfig := &HealthConfig{
				HealthCheckEndpoint: cfg.HealthCheckEndpoint,
				ServicePort:         cfg.ServicePort,
				InstanceItemName:    instanceItemName,
				InstanceItemID:      cfg.NamespaceItemID,
				InstanceID:          cfg.Namespace,
				ControlTowerURL:     cfg.ControlTowerURL,
				TestAgentURL:        cfg.TestAgentURL,
				CheckTimeout:        5 * time.Second,
				Origin:              cfg.Origin,
				DNSIP:               cfg.DNSIP,
			}
			healthChecker = NewHealthChecker(healthConfig, nil)
			if healthChecker != nil {
				healthChecker.Start()
				defer healthChecker.Stop()
				log.Printf("Health checker started for instance item %s", instanceItemName)
			}
		}
	}

	// Determine if this is the global interceptor (no ORIGIN set) or a per-service interceptor
	isGlobalInterceptor := cfg.Origin == ""

	// Create HTTP handler with health check
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Global interceptor: proxy ALL requests, never respond with own health check
		// This is because external requests come through ingress and we need to forward them
		if isGlobalInterceptor {
			handleRequest(w, r, proxyService, logger, testExecutionLogger, cache, cfg)
			return
		}

		// Per-service interceptor: check if this is a health check for the interceptor itself
		// or a request that should be proxied to the service
		urlMap := cache.GetUrlMap()
		isServiceRequest := false
		if r.Host != "" {
			hostname := stripPortFromHost(r.Host)
			if _, exists := urlMap[hostname]; exists {
				isServiceRequest = true
			}
			// Also try extracting service name from FQDN
			// e.g., "traffic-tester-2.namespace.svc.cluster.local" -> "traffic-tester-2"
			serviceName := extractServiceName(hostname)
			if serviceName != hostname {
				if _, exists := urlMap[serviceName]; exists {
					isServiceRequest = true
				}
			}
		}

		// Health check endpoint - only handle if:
		// 1. Path is exactly /health
		// 2. NOT a request intended for a proxied service (Host not in urlMap)
		if r.URL.Path == "/health" && !isServiceRequest {
			handleHealthCheck(w, r, cache)
			return
		}

		// All other requests go through proxy
		handleRequest(w, r, proxyService, logger, testExecutionLogger, cache, cfg)
	})

	// Create server
	server := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      handler,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Start server in goroutine
	go func() {
		log.Printf("Interceptor listening on port %s", cfg.Port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	// Start HTTPS MITM listener if CA cert/key are available
	var tlsServer *http.Server
	var certCache *CertCache
	if caCert != nil && caKey != nil {
		tlsServer, certCache = NewTLSServer(":443", caCert, caKey, handler)
		go func() {
			listener, err := tls.Listen("tcp", tlsServer.Addr, tlsServer.TLSConfig)
			if err != nil {
				log.Printf("HTTPS listener failed to start: %v", err)
				return
			}
			log.Printf("Interceptor listening on port 443 (HTTPS)")
			if err := tlsServer.Serve(listener); err != nil && err != http.ErrServerClosed {
				log.Printf("HTTPS listener failed: %v", err)
			}
		}()
	} else {
		log.Printf("No CA cert/key found, HTTPS interception disabled")
	}

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")

	// Graceful shutdown
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("HTTP server forced to shutdown: %v", err)
	}
	if tlsServer != nil {
		if err := tlsServer.Shutdown(shutdownCtx); err != nil {
			log.Printf("HTTPS server forced to shutdown: %v", err)
		}
		certCache.Stop()
	}

	log.Println("Server exited")
}

func handleRequest(w http.ResponseWriter, r *http.Request, proxy *ProxyService, logger *Logger, testLogger *TestExecutionLogger, cache *MockCache, cfg *Config) {
	// Generate action ID
	actionID := uuid.New().String()

	log.Printf("[Interceptor] Received request: %s %s from %s (Host: %s)", r.Method, r.URL.Path, r.RemoteAddr, r.Host)

	// If request came through Ingress, strip the /namespace-{id}/interceptor prefix
	// Ingress path format: /namespace-{namespaceId}/interceptor{actualPath}
	if strings.HasPrefix(r.URL.Path, "/namespace-") && strings.Contains(r.URL.Path, "/interceptor") {
		// Find where /interceptor ends
		interceptorIdx := strings.Index(r.URL.Path, "/interceptor")
		if interceptorIdx != -1 {
			// Strip everything up to and including /interceptor
			actualPath := r.URL.Path[interceptorIdx+len("/interceptor"):]
			if actualPath == "" {
				actualPath = "/"
			}
			r.URL.Path = actualPath
		}
	}

	// Get URL map for logging
	urlMap := cache.GetUrlMap()

	// Extract target service name BEFORE proxy modifies the path
	// This is needed because proxy.getTargetURL() modifies r.URL.Path
	targetServiceName := extractServiceNameFromRequest(r, urlMap)

	// Parse request body for logging (before it's consumed by proxy)
	var requestBody interface{}
	if r.Body != nil {
		bodyBytes, err := io.ReadAll(r.Body)
		if err == nil && len(bodyBytes) > 0 {
			// Try to parse as JSON
			var jsonBody interface{}
			if err := json.Unmarshal(bodyBytes, &jsonBody); err == nil {
				requestBody = jsonBody
			} else {
				requestBody = string(bodyBytes)
			}
			// Restore body for proxy
			r.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))
		}
	}

	// Capture request sent time
	requestSentAt := time.Now()

	// Log request started
	targetURL := targetServiceName + r.URL.Path
	if testLogger != nil {
		testLogger.LogRequestStarted(r.Method, targetURL, cfg.Origin)
	}

	// Handle request
	resp, err := proxy.HandleRequest(r)

	// Capture response received time
	responseReceivedAt := time.Now()
	durationMs := int(responseReceivedAt.Sub(requestSentAt).Milliseconds())

	if err != nil {
		// Log the error response (if logger is enabled)
		if logger != nil {
			errorBody := map[string]string{"error": fmt.Sprintf("Proxy error: %v", err)}
			logger.LogError(r, http.StatusBadGateway, urlMap, cfg.Namespace, cfg.Origin, cfg.NamespaceItemID, targetServiceName, requestBody, errorBody, &requestSentAt, &responseReceivedAt)
		}
		if testLogger != nil {
			testLogger.LogRequestCompleted(r.Method, targetURL, cfg.Origin, 0, durationMs, err)
		}

		// Return error response
		log.Printf("[Interceptor] Failed to handle request for %s %s: %v", r.Method, r.URL.Path, err)
		http.Error(w, fmt.Sprintf("Proxy error: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Determine if response was mocked
	isMocked := resp.Header.Get("X-Mocked") == "true"

	// Read response body into buffer so we can use it for both logging and copying
	var responseBodyBytes []byte
	var responseBody interface{}
	if resp.Body != nil {
		responseBodyBytes, err = io.ReadAll(resp.Body)
		if err != nil {
			log.Printf("Error reading response body: %v", err)
			http.Error(w, fmt.Sprintf("Error reading response: %v", err), http.StatusInternalServerError)
			return
		}
		// Parse response body for logging — decompress if gzip-encoded
		if len(responseBodyBytes) > 0 {
			loggableBytes := responseBodyBytes
			if strings.EqualFold(resp.Header.Get("Content-Encoding"), "gzip") {
				gr, gzErr := gzip.NewReader(bytes.NewReader(responseBodyBytes))
				if gzErr == nil {
					if decompressed, readErr := io.ReadAll(gr); readErr == nil {
						loggableBytes = decompressed
					}
					gr.Close()
				}
			}
			var jsonBody interface{}
			if err := json.Unmarshal(loggableBytes, &jsonBody); err == nil {
				responseBody = jsonBody
			} else {
				responseBody = string(loggableBytes)
			}
		}
	}

	// Log complete request/response pair (async, non-blocking)
	if logger != nil {
		logger.LogResponse(r, actionID, resp, isMocked, urlMap, cfg.Namespace, cfg.Origin, cfg.NamespaceItemID, targetServiceName, requestBody, responseBody, &requestSentAt, &responseReceivedAt)
	}
	if testLogger != nil {
		testLogger.LogRequestCompleted(r.Method, targetURL, cfg.Origin, resp.StatusCode, durationMs, nil)
	}

	// Copy response headers
	for key, values := range resp.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}

	// Set status code
	w.WriteHeader(resp.StatusCode)

	// Copy response body from buffer
	if len(responseBodyBytes) > 0 {
		if _, err := w.Write(responseBodyBytes); err != nil {
			log.Printf("[Interceptor] Error writing response body to client: %v", err)
			return
		}
	}

	log.Printf("[Interceptor] Sent response to client: status=%d, bodySize=%d bytes", resp.StatusCode, len(responseBodyBytes))
}

// handleHealthCheck handles health check requests
func handleHealthCheck(w http.ResponseWriter, _ *http.Request, cache *MockCache) {
	// Check if cache is initialized (basic health check)
	_ = cache.GetMocks() // This will never fail, just ensures cache is accessible

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"healthy"}`))
}

// loadCA reads and parses a CA certificate and private key from PEM files.
func loadCA(certPath, keyPath string) (*x509.Certificate, *rsa.PrivateKey, error) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return nil, nil, fmt.Errorf("read CA cert: %w", err)
	}

	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, nil, fmt.Errorf("read CA key: %w", err)
	}

	certBlock, _ := pem.Decode(certPEM)
	if certBlock == nil {
		return nil, nil, errors.New("failed to decode CA cert PEM")
	}

	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("parse CA cert: %w", err)
	}

	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return nil, nil, errors.New("failed to decode CA key PEM")
	}

	// Try PKCS8 first, then PKCS1
	if parsedKey, err := x509.ParsePKCS8PrivateKey(keyBlock.Bytes); err == nil {
		rsaKey, ok := parsedKey.(*rsa.PrivateKey)
		if !ok {
			return nil, nil, errors.New("CA key is not RSA")
		}
		log.Printf("Loaded CA cert and key for HTTPS MITM")
		return cert, rsaKey, nil
	}

	rsaKey, err := x509.ParsePKCS1PrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("parse CA key (not PKCS8 or PKCS1): %w", err)
	}

	log.Printf("Loaded CA cert and key for HTTPS MITM (PKCS1)")
	return cert, rsaKey, nil
}
