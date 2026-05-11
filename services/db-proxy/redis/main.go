package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
	shared "dokkimi.com/db-proxy-shared"
)

func main() {
	cfg, err := shared.LoadConfig("")
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	if cfg.DatabaseType == "" {
		cfg.DatabaseType = "Redis"
	}

	if cfg.QueryPort == "8080" {
		cfg.QueryPort = "16379"
	}

	log.Printf("db-proxy (Redis wire protocol) version=%s starting: listen=:%s upstream=localhost:%s",
		shared.Version, cfg.QueryPort, cfg.DatabasePort)

	queryLogger := shared.NewQueryLogger(cfg.ControlTowerURL, 10*time.Second)
	defer queryLogger.Stop()

	proxy := NewProxy(cfg, queryLogger)
	if err := proxy.Listen(); err != nil {
		log.Fatalf("Proxy failed to listen: %v", err)
	}

	healthChecker := shared.NewHealthCheckerWithFunc(cfg, func(ctx context.Context) error {
		db := 0
		if cfg.DatabaseCredentials.DBName != "" {
			fmt.Sscanf(cfg.DatabaseCredentials.DBName, "%d", &db)
		}
		client := redis.NewClient(&redis.Options{
			Addr:     fmt.Sprintf("localhost:%s", cfg.DatabasePort),
			Password: cfg.DatabaseCredentials.DBPassword,
			DB:       db,
		})
		defer client.Close()
		return client.Ping(ctx).Err()
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
