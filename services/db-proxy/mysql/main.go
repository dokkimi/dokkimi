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

	shared "github.com/dokkimi/dokkimi/services/db-proxy/shared"
	_ "github.com/go-sql-driver/mysql"
)

func main() {
	cfg, err := shared.LoadConfig("mysql")
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	if cfg.DatabaseType == "" {
		cfg.DatabaseType = "MySQL"
	}

	if cfg.QueryPort == "8080" {
		cfg.QueryPort = "13306"
	}

	log.Printf("db-proxy (MySQL wire protocol) version=%s starting: listen=:%s upstream=localhost:%s",
		shared.Version, cfg.QueryPort, cfg.DatabasePort)

	queryLogger := shared.NewQueryLogger(cfg.ControlTowerURL, 10*time.Second)
	defer queryLogger.Stop()

	proxy := NewProxy(cfg, queryLogger)
	if err := proxy.Listen(); err != nil {
		log.Fatalf("Proxy failed to listen: %v", err)
	}

	healthChecker := shared.NewHealthCheckerWithFunc(cfg, func(ctx context.Context) error {
		connStr := fmt.Sprintf("%s:%s@tcp(localhost:%s)/%s",
			cfg.DatabaseCredentials.DBUser, cfg.DatabaseCredentials.DBPassword,
			cfg.DatabasePort, cfg.DatabaseCredentials.DBName)
		db, err := sql.Open("mysql", connStr)
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

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down db-proxy...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	proxy.Shutdown(shutdownCtx)
	log.Println("db-proxy exited")
}
