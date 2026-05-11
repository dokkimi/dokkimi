package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/dokkimi/dokkimi/services/db-proxy/shared"
	_ "github.com/lib/pq"
)

func main() {
	cfg, err := shared.LoadConfig("dokkimi")
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	if cfg.DatabaseType == "" {
		cfg.DatabaseType = "PostgreSQL"
	}

	// Default to 15432 for the wire protocol proxy. Can't use 5432 because the
	// real PostgreSQL container uses it in the same pod.
	if cfg.QueryPort == "8080" {
		cfg.QueryPort = "15432"
	}

	log.Printf("db-proxy (PostgreSQL wire protocol) version=%s starting: listen=:%s upstream=localhost:%s",
		shared.Version, cfg.QueryPort, cfg.DatabasePort)

	// Query logger (reused from shared — sends to Control Tower)
	queryLogger := shared.NewQueryLogger(cfg.ControlTowerURL, 10*time.Second)
	defer queryLogger.Stop()

	// Wire protocol proxy — bind the port before starting health checks
	// so "ready" is never reported while the listener is still down.
	proxy := NewProxy(cfg, queryLogger)
	if err := proxy.Listen(); err != nil {
		log.Fatalf("Proxy failed to listen: %v", err)
	}

	// Health checker — connects directly to upstream PG to verify it's alive.
	// Started after Listen() so the proxy port is already accepting by the time
	// health reports "ready" to Control Tower.
	healthChecker := shared.NewHealthCheckerWithFunc(cfg, func(ctx context.Context) error {
		connStr := fmt.Sprintf("postgres://%s:%s@localhost:%s/%s?sslmode=disable",
			cfg.DatabaseCredentials.DBUser, cfg.DatabaseCredentials.DBPassword,
			cfg.DatabasePort, cfg.DatabaseCredentials.DBName)
		db, err := sql.Open("postgres", connStr)
		if err != nil {
			return err
		}
		defer db.Close()
		return db.PingContext(ctx)
	})
	healthChecker.Start()
	defer healthChecker.Stop()

	go func() {
		if err := proxy.Serve(); err != nil {
			log.Fatalf("Proxy failed: %v", err)
		}
	}()

	// Wait for shutdown signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down db-proxy...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	proxy.Shutdown(shutdownCtx)
	log.Println("db-proxy exited")
}
