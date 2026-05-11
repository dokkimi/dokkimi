package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	shared "github.com/dokkimi/dokkimi/services/db-proxy/shared"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func main() {
	cfg, err := shared.LoadConfig("dokkimi")
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	if cfg.DatabaseType == "" {
		cfg.DatabaseType = "MongoDB"
	}

	if cfg.QueryPort == "8080" {
		cfg.QueryPort = "17017"
	}

	log.Printf("db-proxy (MongoDB wire protocol) version=%s starting: listen=:%s upstream=localhost:%s",
		shared.Version, cfg.QueryPort, cfg.DatabasePort)

	queryLogger := shared.NewQueryLogger(cfg.ControlTowerURL, 10*time.Second)
	defer queryLogger.Stop()

	proxy := NewProxy(cfg, queryLogger)
	if err := proxy.Listen(); err != nil {
		log.Fatalf("Proxy failed to listen: %v", err)
	}

	healthChecker := shared.NewHealthCheckerWithFunc(cfg, func(ctx context.Context) error {
		creds := cfg.DatabaseCredentials
		var connStr string
		if creds.DBUser != "" && creds.DBPassword != "" {
			connStr = fmt.Sprintf("mongodb://%s:%s@localhost:%s/%s?authSource=admin",
				creds.DBUser, creds.DBPassword, cfg.DatabasePort, creds.DBName)
		} else {
			connStr = fmt.Sprintf("mongodb://localhost:%s/%s", cfg.DatabasePort, creds.DBName)
		}

		client, err := mongo.Connect(options.Client().ApplyURI(connStr))
		if err != nil {
			return err
		}
		defer client.Disconnect(ctx)

		var result bson.M
		err = client.Database("dokkimi_internal").Collection("health").
			FindOne(ctx, bson.M{"_id": "ready"}).Decode(&result)
		if err != nil {
			return fmt.Errorf("sentinel not found: %w", err)
		}
		return nil
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
