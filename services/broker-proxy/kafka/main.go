package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/dokkimi/dokkimi/services/broker-proxy/shared"
)

func main() {
	cfg, err := shared.LoadConfig()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	if cfg.BrokerType == "" {
		cfg.BrokerType = "kafka"
	}

	log.Printf("broker-proxy (Kafka) version=%s starting: listen=:%s upstream=localhost:%s",
		shared.Version, cfg.ProxyPort, cfg.BrokerPort)

	messageLogger := shared.NewMessageLogger(cfg.ControlTowerURL, 10*time.Second)
	if cfg.TestAgentURL != "" {
		messageLogger.SetTestAgentURL(cfg.TestAgentURL)
	}
	defer messageLogger.Stop()

	proxy := NewProxy(cfg, messageLogger)
	if err := proxy.Listen(); err != nil {
		log.Fatalf("Proxy failed to listen: %v", err)
	}

	healthChecker := shared.NewHealthCheckerWithFunc(cfg, shared.BuildHealthCheckFunc(cfg))
	healthChecker.Start()
	defer healthChecker.Stop()

	go func() {
		if err := proxy.Serve(); err != nil {
			log.Fatalf("Proxy failed: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down broker-proxy...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	proxy.Shutdown(shutdownCtx)
	log.Println("broker-proxy exited")
}
