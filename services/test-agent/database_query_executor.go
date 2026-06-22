package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// DatabaseQueryExecutor handles database query execution and logging
type DatabaseQueryExecutor struct {
	httpClient     *http.Client
	logEndpointURL string
	databaseMap    map[string]DatabaseInfo
	instanceId     string
	mu             sync.Mutex
	pgPools        map[string]*sql.DB       // cached postgres connection pools, keyed by database name
	mysqlPools     map[string]*sql.DB       // cached mysql connection pools, keyed by database name
	redisClients   map[string]*redis.Client // cached redis clients, keyed by database name
	mongoClients   map[string]*mongo.Client // cached mongo clients, keyed by database name
}

// DatabaseInfo contains connection information for a database
type DatabaseInfo struct {
	Type           string `json:"type"`
	User           string `json:"user"`
	Password       string `json:"password"`
	Database       string `json:"database"`
	Port           int    `json:"port,omitempty"`
	InstanceItemID string `json:"instanceItemId"`
}

// DBQueryResult holds the result of a database query for the caller
type DBQueryResult struct {
	Success      bool                     `json:"success"`
	Data         []map[string]interface{} `json:"data,omitempty"`
	RowsAffected int64                    `json:"rowsAffected,omitempty"`
	Error        string                   `json:"error,omitempty"`
	Duration     int                      `json:"duration,omitempty"`
}

// NewDatabaseQueryExecutor creates a new database query executor
func NewDatabaseQueryExecutor(logEndpointURL string, databaseMap map[string]DatabaseInfo, instanceId string) *DatabaseQueryExecutor {
	return &DatabaseQueryExecutor{
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		logEndpointURL: logEndpointURL,
		databaseMap:    databaseMap,
		instanceId:     instanceId,
		pgPools:        make(map[string]*sql.DB),
		mysqlPools:     make(map[string]*sql.DB),
		redisClients:   make(map[string]*redis.Client),
		mongoClients:   make(map[string]*mongo.Client),
	}
}

// ExecuteQuery forwards a database query to db-proxy and logs the result.
// Returns the query result so the caller can use it for variable extraction.
func (e *DatabaseQueryExecutor) ExecuteQuery(
	ctx context.Context,
	databaseType string,
	databaseName string,
	query string,
	params map[string]interface{},
) (*DBQueryResult, error) {
	query = strings.TrimSpace(query)
	startTime := time.Now()

	// Validate database exists in databaseMap
	if _, ok := e.databaseMap[databaseName]; !ok {
		err := fmt.Errorf("database '%s' not found in databaseMap", databaseName)
		e.logQueryResult(ctx, databaseType, databaseName, query, params, false, nil, 0, err.Error(), 0)
		return nil, err
	}

	// Normalize database type for logging
	dbType := strings.ToLower(databaseType)
	if dbType == "postgres" {
		dbType = "postgresql"
	} else if dbType == "mongo" {
		dbType = "mongodb"
	} else if dbType == "mariadb" {
		dbType = "mysql"
	}

	// Postgres, MySQL, and Redis use native wire protocol through the db-proxy
	if dbType == "postgresql" {
		return e.executePostgresQuery(ctx, dbType, databaseName, query, params, startTime)
	}
	if dbType == "mysql" {
		return e.executeMysqlQuery(ctx, dbType, databaseName, query, params, startTime)
	}
	if dbType == "redis" {
		return e.executeRedisQuery(ctx, dbType, databaseName, query, params, startTime)
	}
	if dbType == "mongodb" {
		return e.executeMongoQuery(ctx, dbType, databaseName, query, params, startTime)
	}

	return e.executeViaHTTP(ctx, dbType, databaseName, query, params, startTime)
}

// Close cleans up cached connection pools. Called when the executor is done.
func (e *DatabaseQueryExecutor) Close() {
	for name, db := range e.pgPools {
		if err := db.Close(); err != nil {
			log.Printf("error closing postgres pool for %s: %v", name, err)
		}
	}
	for name, db := range e.mysqlPools {
		if err := db.Close(); err != nil {
			log.Printf("error closing mysql pool for %s: %v", name, err)
		}
	}
	for name, client := range e.redisClients {
		if err := client.Close(); err != nil {
			log.Printf("error closing redis client for %s: %v", name, err)
		}
	}
	for name, client := range e.mongoClients {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		if err := client.Disconnect(ctx); err != nil {
			log.Printf("error closing mongo client for %s: %v", name, err)
		}
		cancel()
	}
}

// executeViaHTTP forwards a query to a db-proxy REST endpoint
func (e *DatabaseQueryExecutor) executeViaHTTP(
	ctx context.Context,
	dbType string,
	databaseName string,
	query string,
	params map[string]interface{},
	startTime time.Time,
) (*DBQueryResult, error) {
	url := fmt.Sprintf("http://%s:8080/api/db/query", databaseName)

	forwardReq := map[string]interface{}{
		"query":  query,
		"params": params,
	}

	body, err := json.Marshal(forwardReq)
	if err != nil {
		duration := int(time.Since(startTime).Milliseconds())
		errMsg := fmt.Sprintf("Failed to marshal request: %v", err)
		e.logQueryResult(ctx, dbType, databaseName, query, params, false, nil, 0, errMsg, duration)
		return nil, fmt.Errorf("%s", errMsg)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, strings.NewReader(string(body)))
	if err != nil {
		duration := int(time.Since(startTime).Milliseconds())
		errMsg := fmt.Sprintf("Failed to create request: %v", err)
		e.logQueryResult(ctx, dbType, databaseName, query, params, false, nil, 0, errMsg, duration)
		return nil, fmt.Errorf("%s", errMsg)
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		duration := int(time.Since(startTime).Milliseconds())
		errMsg := fmt.Sprintf("Failed to forward query to db-proxy: %v", err)
		e.logQueryResult(ctx, dbType, databaseName, query, params, false, nil, 0, errMsg, duration)
		return nil, fmt.Errorf("%s", errMsg)
	}
	defer resp.Body.Close()

	var dbProxyResponse struct {
		Success      bool                     `json:"success"`
		Data         []map[string]interface{} `json:"data,omitempty"`
		Error        string                   `json:"error,omitempty"`
		RowsAffected int64                    `json:"rowsAffected,omitempty"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&dbProxyResponse); err != nil {
		duration := int(time.Since(startTime).Milliseconds())
		errMsg := fmt.Sprintf("Failed to parse db-proxy response: %v", err)
		e.logQueryResult(ctx, dbType, databaseName, query, params, false, nil, 0, errMsg, duration)
		return nil, fmt.Errorf("%s", errMsg)
	}

	duration := int(time.Since(startTime).Milliseconds())
	success := dbProxyResponse.Success && resp.StatusCode == http.StatusOK

	e.logQueryResult(ctx, dbType, databaseName, query, params, success, dbProxyResponse.Data, dbProxyResponse.RowsAffected, dbProxyResponse.Error, duration)

	result := &DBQueryResult{
		Success:      success,
		Data:         dbProxyResponse.Data,
		RowsAffected: dbProxyResponse.RowsAffected,
		Error:        dbProxyResponse.Error,
		Duration:     duration,
	}

	if !success {
		return result, fmt.Errorf("db-proxy query failed: %s", dbProxyResponse.Error)
	}

	return result, nil
}

// logQueryResult sends the query result to Control Tower
func (e *DatabaseQueryExecutor) logQueryResult(
	ctx context.Context,
	databaseType string,
	databaseName string,
	query string,
	params map[string]interface{},
	success bool,
	data []map[string]interface{},
	rowsAffected int64,
	errorMsg string,
	duration int,
) {
	// Find database info for instanceItemId
	dbInfo, ok := e.databaseMap[databaseName]
	instanceItemId := ""
	if ok {
		instanceItemId = dbInfo.InstanceItemID
	}

	// Build log message
	logMessage := map[string]interface{}{
		"instanceId":     e.instanceId,
		"instanceItemId": instanceItemId,
		"databaseType":   databaseType,
		"databaseName":   databaseName,
		"query":          query,
		"success":        success,
		"timestamp":      time.Now().UTC().Format(time.RFC3339Nano),
	}

	if params != nil && len(params) > 0 {
		logMessage["params"] = params
	}

	if success {
		if data != nil && len(data) > 0 {
			logMessage["data"] = data
		} else if data != nil {
			logMessage["data"] = []interface{}{}
		}
		if rowsAffected > 0 {
			logMessage["rowsAffected"] = rowsAffected
		}
		if duration > 0 {
			logMessage["duration"] = duration
		}
	} else {
		if errorMsg != "" {
			logMessage["error"] = errorMsg
		}
	}

	// Send to Control Tower
	body, err := json.Marshal(logMessage)
	if err != nil {
		log.Printf("Failed to marshal database log message: %v", err)
		return
	}

	url := e.logEndpointURL + "/logs/database"
	req, err := http.NewRequestWithContext(ctx, "POST", url, strings.NewReader(string(body)))
	if err != nil {
		log.Printf("Failed to create database log request: %v", err)
		return
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		log.Printf("Failed to send database log to Control Tower: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		log.Printf("Log-processor-service returned non-OK status: %d", resp.StatusCode)
		return
	}

	log.Printf("Successfully logged database query for %s/%s", databaseType, databaseName)
}
