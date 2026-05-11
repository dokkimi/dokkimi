package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"net/http"
	"sync"
	"time"
)

// CertCache is a thread-safe cache for dynamically generated TLS certificates.
// Entries expire after 1 hour. Expired entries are evicted periodically.
type CertCache struct {
	mu      sync.RWMutex
	entries map[string]certEntry
	stopCh  chan struct{}
}

type certEntry struct {
	cert      *tls.Certificate
	expiresAt time.Time
}

// NewCertCache creates a new CertCache and starts a background goroutine
// that evicts expired entries every 10 minutes.
func NewCertCache() *CertCache {
	c := &CertCache{
		entries: make(map[string]certEntry),
		stopCh:  make(chan struct{}),
	}
	go c.evictLoop()
	return c
}

// Stop terminates the background eviction goroutine.
func (c *CertCache) Stop() {
	select {
	case <-c.stopCh:
	default:
		close(c.stopCh)
	}
}

func (c *CertCache) evictLoop() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			c.mu.Lock()
			now := time.Now()
			for hostname, entry := range c.entries {
				if now.After(entry.expiresAt) {
					delete(c.entries, hostname)
				}
			}
			c.mu.Unlock()
		case <-c.stopCh:
			return
		}
	}
}

// Get returns a cached certificate for the given hostname, or nil if not found or expired.
// Note: there is a small race window where an entry could expire between the read and the
// expiry check. This is acceptable — the cert is still cryptographically valid (24h lifetime),
// it's just past the 1h cache TTL. Worst case, a cert is served for a few extra milliseconds.
func (c *CertCache) Get(hostname string) *tls.Certificate {
	c.mu.RLock()
	entry, ok := c.entries[hostname]
	c.mu.RUnlock()
	if !ok || time.Now().After(entry.expiresAt) {
		return nil
	}
	return entry.cert
}

// Set stores a certificate in the cache for the given hostname. It expires after 1 hour.
func (c *CertCache) Set(hostname string, cert *tls.Certificate) {
	c.mu.Lock()
	c.entries[hostname] = certEntry{
		cert:      cert,
		expiresAt: time.Now().Add(1 * time.Hour),
	}
	c.mu.Unlock()
}

// generateLeafCert creates a leaf certificate signed by the given CA for the specified hostname.
// The hostname is added as a SAN (DNS name or IP address). The certificate is valid for 24 hours.
func generateLeafCert(hostname string, caCert *x509.Certificate, caKey *rsa.PrivateKey) (*tls.Certificate, error) {
	leafKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}

	serialNumber, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}

	template := &x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			CommonName: hostname,
		},
		NotBefore:             time.Now().Add(-5 * time.Minute), // small clock-skew buffer
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}

	// Add hostname as SAN — either IP or DNS name
	if ip := net.ParseIP(hostname); ip != nil {
		template.IPAddresses = []net.IP{ip}
	} else {
		template.DNSNames = []string{hostname}
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		return nil, err
	}

	leafCert, err := x509.ParseCertificate(certDER)
	if err != nil {
		return nil, err
	}

	return &tls.Certificate{
		Certificate: [][]byte{certDER, caCert.Raw},
		PrivateKey:  leafKey,
		Leaf:        leafCert,
	}, nil
}

// NewTLSServer creates an HTTPS server that dynamically generates leaf certificates
// signed by the provided CA, using SNI to determine the hostname.
// The caller is responsible for calling server.Shutdown() and cache.Stop() on cleanup.
func NewTLSServer(addr string, caCert *x509.Certificate, caKey *rsa.PrivateKey, handler http.Handler) (*http.Server, *CertCache) {
	cache := NewCertCache()

	tlsConfig := &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
			hostname := hello.ServerName
			if hostname == "" {
				hostname = "localhost"
			}

			// Check cache first
			if cert := cache.Get(hostname); cert != nil {
				return cert, nil
			}

			// Generate a new leaf cert signed by our CA
			cert, err := generateLeafCert(hostname, caCert, caKey)
			if err != nil {
				return nil, err
			}

			cache.Set(hostname, cert)
			return cert, nil
		},
	}

	server := &http.Server{
		Addr:      addr,
		Handler:   handler,
		TLSConfig: tlsConfig,
	}

	return server, cache
}
