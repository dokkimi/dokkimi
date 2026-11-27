package main

import (
	"context"
	"database/sql"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	shared "github.com/dokkimi/dokkimi/services/db-proxy/shared"
	"github.com/go-sql-driver/mysql"
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
	if cfg.TestAgentURL != "" {
		queryLogger.SetTestAgentURL(cfg.TestAgentURL)
	}
	defer queryLogger.Stop()

	proxy := NewProxy(cfg, queryLogger)
	if err := proxy.Listen(); err != nil {
		log.Fatalf("Proxy failed to listen: %v", err)
	}

	healthChecker := shared.NewHealthCheckerWithFunc(cfg, func(ctx context.Context) error {
		// The driver's own format escapes nothing it doesn't have to: a
		// hand-built DSN broke on a password with "/" or "@"
		dsn := mysql.NewConfig()
		dsn.User = cfg.DatabaseCredentials.DBUser
		dsn.Passwd = cfg.DatabaseCredentials.DBPassword
		dsn.Net = "tcp"
		dsn.Addr = net.JoinHostPort("localhost", cfg.DatabasePort)
		dsn.DBName = cfg.DatabaseCredentials.DBName
		db, err := sql.Open("mysql", dsn.FormatDSN())
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
