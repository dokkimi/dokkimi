package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/lib/pq"
	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	mongoOptions "go.mongodb.org/mongo-driver/v2/mongo/options"
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

// getPostgresPool returns a cached *sql.DB pool for the given database, creating one on first use.
func (e *DatabaseQueryExecutor) getPostgresPool(databaseName string) (*sql.DB, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if db, ok := e.pgPools[databaseName]; ok {
		return db, nil
	}

	dbInfo := e.databaseMap[databaseName]
	port := dbInfo.Port
	if port == 0 {
		port = 5432
	}
	connStr := fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=disable",
		dbInfo.User, dbInfo.Password, databaseName, port, dbInfo.Database)

	db, err := sql.Open("postgres", connStr)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(5)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(5 * time.Minute)

	e.pgPools[databaseName] = db
	return db, nil
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

// getMysqlPool returns a cached *sql.DB pool for the given MySQL database, creating one on first use.
func (e *DatabaseQueryExecutor) getMysqlPool(databaseName string) (*sql.DB, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if db, ok := e.mysqlPools[databaseName]; ok {
		return db, nil
	}

	dbInfo := e.databaseMap[databaseName]
	port := dbInfo.Port
	if port == 0 {
		port = 3306
	}
	connStr := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s",
		dbInfo.User, dbInfo.Password, databaseName, port, dbInfo.Database)

	db, err := sql.Open("mysql", connStr)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(5)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(5 * time.Minute)

	e.mysqlPools[databaseName] = db
	return db, nil
}

// executeMysqlQuery connects natively to the mysql wire protocol proxy
func (e *DatabaseQueryExecutor) executeMysqlQuery(
	ctx context.Context,
	dbType string,
	databaseName string,
	query string,
	params map[string]interface{},
	startTime time.Time,
) (*DBQueryResult, error) {
	db, err := e.getMysqlPool(databaseName)
	if err != nil {
		duration := int(time.Since(startTime).Milliseconds())
		errMsg := fmt.Sprintf("failed to open mysql connection: %v", err)
		e.logQueryResult(ctx, dbType, databaseName, query, params, false, nil, 0, errMsg, duration)
		return nil, errors.New(errMsg)
	}

	args := bindMysqlParams(query, params)

	queryUpper := strings.TrimSpace(strings.ToUpper(query))
	returnsRows := strings.HasPrefix(queryUpper, "SELECT") ||
		strings.HasPrefix(queryUpper, "WITH") ||
		strings.HasPrefix(queryUpper, "SHOW") ||
		strings.HasPrefix(queryUpper, "DESCRIBE") ||
		strings.HasPrefix(queryUpper, "EXPLAIN")

	var result *DBQueryResult

	if returnsRows {
		rows, err := db.QueryContext(ctx, query, args...)
		if err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("query execution failed: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		defer rows.Close()

		columns, err := rows.Columns()
		if err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("failed to get columns: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}

		colTypes, _ := rows.ColumnTypes()

		var data []map[string]interface{}
		for rows.Next() {
			values := make([]interface{}, len(columns))
			valuePtrs := make([]interface{}, len(columns))
			for i := range values {
				valuePtrs[i] = &values[i]
			}
			if err := rows.Scan(valuePtrs...); err != nil {
				duration := int(time.Since(startTime).Milliseconds())
				errMsg := fmt.Sprintf("failed to scan row: %v", err)
				return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
			}
			row := make(map[string]interface{})
			for i, col := range columns {
				row[col] = coerceMysqlValue(values[i], colTypes, i)
			}
			data = append(data, row)
		}
		if err := rows.Err(); err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("row iteration error: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}

		duration := int(time.Since(startTime).Milliseconds())
		if data == nil {
			data = []map[string]interface{}{}
		}
		result = &DBQueryResult{Success: true, Data: data, Duration: duration}
	} else {
		res, err := db.ExecContext(ctx, query, args...)
		if err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("query execution failed: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		rowsAffected, _ := res.RowsAffected()
		duration := int(time.Since(startTime).Milliseconds())
		result = &DBQueryResult{Success: true, Data: []map[string]interface{}{}, RowsAffected: rowsAffected, Duration: duration}
	}

	return result, nil
}

// coerceMysqlValue converts a scanned value to the appropriate Go type.
// go-sql-driver/mysql returns []byte for text protocol queries; we use
// the column's DatabaseTypeName to coerce to int64/float64 where appropriate.
func coerceMysqlValue(val interface{}, colTypes []*sql.ColumnType, idx int) interface{} {
	if val == nil {
		return nil
	}
	b, ok := val.([]byte)
	if !ok {
		return val
	}
	s := string(b)
	if colTypes != nil && idx < len(colTypes) {
		switch colTypes[idx].DatabaseTypeName() {
		case "TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT", "YEAR":
			if v, err := strconv.ParseInt(s, 10, 64); err == nil {
				return v
			}
		case "FLOAT", "DOUBLE", "DECIMAL":
			if v, err := strconv.ParseFloat(s, 64); err == nil {
				return v
			}
		}
	}
	return s
}

// bindMysqlParams builds an ordered args slice from a map of positional
// params (keys "1","2",...) matching ? placeholders in the query.
func bindMysqlParams(query string, params map[string]interface{}) []interface{} {
	if len(params) == 0 {
		return nil
	}
	count := strings.Count(query, "?")
	if count == 0 {
		return nil
	}
	args := make([]interface{}, count)
	for i := 0; i < count; i++ {
		if v, ok := params[strconv.Itoa(i+1)]; ok {
			args[i] = v
		}
	}
	return args
}

// executePostgresQuery connects natively to the postgres wire protocol proxy
func (e *DatabaseQueryExecutor) executePostgresQuery(
	ctx context.Context,
	dbType string,
	databaseName string,
	query string,
	params map[string]interface{},
	startTime time.Time,
) (*DBQueryResult, error) {
	db, err := e.getPostgresPool(databaseName)
	if err != nil {
		duration := int(time.Since(startTime).Milliseconds())
		errMsg := fmt.Sprintf("failed to open postgres connection: %v", err)
		e.logQueryResult(ctx, dbType, databaseName, query, params, false, nil, 0, errMsg, duration)
		return nil, errors.New(errMsg)
	}

	// Convert params to positional args, rewriting named $placeholders in the query
	query, args := convertPostgresParams(query, params)

	queryUpper := strings.TrimSpace(strings.ToUpper(query))
	returnsRows := strings.HasPrefix(queryUpper, "SELECT") || strings.Contains(queryUpper, "RETURNING")

	var result *DBQueryResult

	if returnsRows {
		rows, err := db.QueryContext(ctx, query, args...)
		if err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("query execution failed: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		defer rows.Close()

		columns, err := rows.Columns()
		if err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("failed to get columns: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}

		var data []map[string]interface{}
		for rows.Next() {
			values := make([]interface{}, len(columns))
			valuePtrs := make([]interface{}, len(columns))
			for i := range values {
				valuePtrs[i] = &values[i]
			}
			if err := rows.Scan(valuePtrs...); err != nil {
				duration := int(time.Since(startTime).Milliseconds())
				errMsg := fmt.Sprintf("failed to scan row: %v", err)
				return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
			}
			row := make(map[string]interface{})
			for i, col := range columns {
				if b, ok := values[i].([]byte); ok {
					row[col] = string(b)
				} else {
					row[col] = values[i]
				}
			}
			data = append(data, row)
		}
		if err := rows.Err(); err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("row iteration error: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}

		duration := int(time.Since(startTime).Milliseconds())
		if data == nil {
			data = []map[string]interface{}{}
		}
		result = &DBQueryResult{Success: true, Data: data, Duration: duration}
	} else {
		res, err := db.ExecContext(ctx, query, args...)
		if err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("query execution failed: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		rowsAffected, _ := res.RowsAffected()
		duration := int(time.Since(startTime).Milliseconds())
		result = &DBQueryResult{Success: true, Data: []map[string]interface{}{}, RowsAffected: rowsAffected, Duration: duration}
	}

	return result, nil
}

// convertPostgresParams builds an ordered args slice from a map of positional
// params (keys "1","2",...) matching $1,$2,... placeholders in the query.
// The query is passed through unchanged — it must already use standard postgres syntax.
func convertPostgresParams(query string, params map[string]interface{}) (string, []interface{}) {
	if len(params) == 0 {
		return query, nil
	}

	// Find the highest positional index to size the args slice
	maxIdx := 0
	for key := range params {
		if idx, err := strconv.Atoi(key); err == nil && idx > maxIdx {
			maxIdx = idx
		}
	}

	if maxIdx == 0 {
		return query, nil
	}

	args := make([]interface{}, maxIdx)
	for key, val := range params {
		if idx, err := strconv.Atoi(key); err == nil && idx >= 1 && idx <= maxIdx {
			args[idx-1] = val
		}
	}

	return query, args
}

// getRedisClient returns a cached redis.Client for the given database, creating one on first use.
func (e *DatabaseQueryExecutor) getRedisClient(databaseName string) (*redis.Client, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if client, ok := e.redisClients[databaseName]; ok {
		return client, nil
	}

	dbInfo := e.databaseMap[databaseName]
	db := 0
	if dbInfo.Database != "" {
		fmt.Sscanf(dbInfo.Database, "%d", &db)
	}

	port := dbInfo.Port
	if port == 0 {
		port = 6379
	}
	client := redis.NewClient(&redis.Options{
		Addr:     fmt.Sprintf("%s:%d", databaseName, port),
		Password: dbInfo.Password,
		DB:       db,
	})

	e.redisClients[databaseName] = client
	return client, nil
}

// executeRedisQuery connects natively to the Redis wire protocol proxy
func (e *DatabaseQueryExecutor) executeRedisQuery(
	ctx context.Context,
	dbType string,
	databaseName string,
	query string,
	params map[string]interface{},
	startTime time.Time,
) (*DBQueryResult, error) {
	client, err := e.getRedisClient(databaseName)
	if err != nil {
		duration := int(time.Since(startTime).Milliseconds())
		errMsg := fmt.Sprintf("failed to create redis client: %v", err)
		e.logQueryResult(ctx, dbType, databaseName, query, params, false, nil, 0, errMsg, duration)
		return nil, errors.New(errMsg)
	}

	args := parseRedisCommand(query)
	if len(args) == 0 {
		duration := int(time.Since(startTime).Milliseconds())
		errMsg := "empty Redis command"
		e.logQueryResult(ctx, dbType, databaseName, query, params, false, nil, 0, errMsg, duration)
		return nil, errors.New(errMsg)
	}

	iargs := make([]interface{}, len(args))
	for i, a := range args {
		iargs[i] = a
	}

	result, err := client.Do(ctx, iargs...).Result()
	if err == redis.Nil {
		duration := int(time.Since(startTime).Milliseconds())
		data := []map[string]interface{}{}
		return &DBQueryResult{Success: true, Data: data, Duration: duration}, nil
	}
	if err != nil {
		duration := int(time.Since(startTime).Milliseconds())
		errMsg := fmt.Sprintf("Redis command failed: %v", err)
		return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
	}

	data := normalizeRedisResult(strings.ToUpper(args[0]), result)
	duration := int(time.Since(startTime).Milliseconds())
	return &DBQueryResult{Success: true, Data: data, RowsAffected: int64(len(data)), Duration: duration}, nil
}

// parseRedisCommand splits a command string into tokens, respecting double-quoted strings.
func parseRedisCommand(cmd string) []string {
	cmd = strings.TrimSpace(cmd)
	var args []string
	var current strings.Builder
	inQuote := false

	for i := 0; i < len(cmd); i++ {
		ch := cmd[i]
		switch {
		case ch == '"' && !inQuote:
			inQuote = true
		case ch == '"' && inQuote:
			inQuote = false
		case ch == ' ' && !inQuote:
			if current.Len() > 0 {
				args = append(args, current.String())
				current.Reset()
			}
		default:
			current.WriteByte(ch)
		}
	}
	if current.Len() > 0 {
		args = append(args, current.String())
	}
	return args
}

// normalizeRedisResult converts a Redis reply into the standard []map[string]interface{} format.
func normalizeRedisResult(command string, result interface{}) []map[string]interface{} {
	switch v := result.(type) {
	case []interface{}:
		if command == "HGETALL" && len(v)%2 == 0 {
			row := make(map[string]interface{})
			for i := 0; i < len(v); i += 2 {
				key := fmt.Sprintf("%v", v[i])
				row[key] = v[i+1]
			}
			return []map[string]interface{}{row}
		}
		rows := make([]map[string]interface{}, len(v))
		for i, item := range v {
			rows[i] = map[string]interface{}{"value": item}
		}
		return rows
	default:
		return []map[string]interface{}{{"value": v}}
	}
}

// getMongoClient returns a cached mongo.Client for the given database, creating one on first use.
func (e *DatabaseQueryExecutor) getMongoClient(databaseName string) (*mongo.Client, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if client, ok := e.mongoClients[databaseName]; ok {
		return client, nil
	}

	dbInfo := e.databaseMap[databaseName]
	port := dbInfo.Port
	if port == 0 {
		port = 27017
	}
	var connStr string
	if dbInfo.User != "" && dbInfo.Password != "" {
		connStr = fmt.Sprintf("mongodb://%s:%s@%s:%d/%s?authSource=admin",
			dbInfo.User, dbInfo.Password, databaseName, port, dbInfo.Database)
	} else {
		connStr = fmt.Sprintf("mongodb://%s:%d/%s", databaseName, port, dbInfo.Database)
	}

	client, err := mongo.Connect(mongoOptions.Client().ApplyURI(connStr))
	if err != nil {
		return nil, err
	}

	e.mongoClients[databaseName] = client
	return client, nil
}

// mongoCommand is the structured JSON command format for MongoDB queries.
// Uses bson.D for ordered fields to preserve key order from the test definition
// through the wire protocol, so the proxy's reconstructed query matches exactly.
type mongoCommand struct {
	Operation  string   `json:"operation"`
	Collection string   `json:"collection"`
	Filter     bson.D   `json:"-"`
	Document   bson.D   `json:"-"`
	Documents  []bson.D `json:"-"`
	Update     bson.D   `json:"-"`
}

// parseMongoCommand parses a JSON query string into a mongoCommand, preserving
// key ordering by using bson.D for document fields.
func parseMongoCommand(query string) (mongoCommand, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(query), &raw); err != nil {
		return mongoCommand{}, err
	}

	var cmd mongoCommand
	if v, ok := raw["operation"]; ok {
		json.Unmarshal(v, &cmd.Operation)
	}
	if v, ok := raw["collection"]; ok {
		json.Unmarshal(v, &cmd.Collection)
	}
	if v, ok := raw["filter"]; ok {
		cmd.Filter = jsonToBsonD(v)
	}
	if v, ok := raw["document"]; ok {
		cmd.Document = jsonToBsonD(v)
	}
	if v, ok := raw["documents"]; ok {
		var arr []json.RawMessage
		json.Unmarshal(v, &arr)
		cmd.Documents = make([]bson.D, len(arr))
		for i, item := range arr {
			cmd.Documents[i] = jsonToBsonD(item)
		}
	}
	if v, ok := raw["update"]; ok {
		cmd.Update = jsonToBsonD(v)
	}
	return cmd, nil
}

// jsonToBsonD parses a JSON object into bson.D, preserving key order.
func jsonToBsonD(data json.RawMessage) bson.D {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return jsonDecToBsonD(dec)
}

func jsonDecToBsonD(dec *json.Decoder) bson.D {
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil
	}
	var d bson.D
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			break
		}
		key := keyTok.(string)
		val := jsonDecToValue(dec)
		d = append(d, bson.E{Key: key, Value: val})
	}
	dec.Token() // consume closing }
	return d
}

func jsonDecToValue(dec *json.Decoder) interface{} {
	tok, err := dec.Token()
	if err != nil {
		return nil
	}
	switch v := tok.(type) {
	case json.Delim:
		if v == '{' {
			// Push back by re-parsing — but since we already consumed '{',
			// build the bson.D inline
			var d bson.D
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					break
				}
				key := keyTok.(string)
				val := jsonDecToValue(dec)
				d = append(d, bson.E{Key: key, Value: val})
			}
			dec.Token() // consume closing }
			return d
		}
		if v == '[' {
			var arr bson.A
			for dec.More() {
				arr = append(arr, jsonDecToValue(dec))
			}
			dec.Token() // consume closing ]
			return arr
		}
	case json.Number:
		if i, err := v.Int64(); err == nil {
			return int32(i)
		}
		if f, err := v.Float64(); err == nil {
			return f
		}
	case string:
		return v
	case bool:
		return v
	case nil:
		return nil
	}
	return tok
}

// executeMongoQuery connects natively to the MongoDB wire protocol proxy
func (e *DatabaseQueryExecutor) executeMongoQuery(
	ctx context.Context,
	dbType string,
	databaseName string,
	query string,
	params map[string]interface{},
	startTime time.Time,
) (*DBQueryResult, error) {
	client, err := e.getMongoClient(databaseName)
	if err != nil {
		duration := int(time.Since(startTime).Milliseconds())
		errMsg := fmt.Sprintf("failed to create mongo client: %v", err)
		e.logQueryResult(ctx, dbType, databaseName, query, params, false, nil, 0, errMsg, duration)
		return nil, errors.New(errMsg)
	}

	cmd, err := parseMongoCommand(query)
	if err != nil {
		duration := int(time.Since(startTime).Milliseconds())
		errMsg := fmt.Sprintf("invalid MongoDB query format: %v", err)
		return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
	}

	if cmd.Collection == "" {
		duration := int(time.Since(startTime).Milliseconds())
		errMsg := "collection name is required"
		return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
	}

	dbInfo := e.databaseMap[databaseName]
	db := client.Database(dbInfo.Database)
	collection := db.Collection(cmd.Collection)

	switch cmd.Operation {
	case "find":
		filter := cmd.Filter
		if filter == nil {
			filter = bson.D{}
		}
		cursor, err := collection.Find(ctx, filter)
		if err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("MongoDB find failed: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		defer cursor.Close(ctx)

		var results []map[string]interface{}
		if err := cursor.All(ctx, &results); err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("failed to decode results: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		if results == nil {
			results = []map[string]interface{}{}
		}
		duration := int(time.Since(startTime).Milliseconds())
		return &DBQueryResult{Success: true, Data: normalizeMongoResults(results), RowsAffected: int64(len(results)), Duration: duration}, nil

	case "findOne":
		filter := cmd.Filter
		if filter == nil {
			filter = bson.D{}
		}
		var result map[string]interface{}
		err := collection.FindOne(ctx, filter).Decode(&result)
		if err != nil {
			if err == mongo.ErrNoDocuments {
				duration := int(time.Since(startTime).Milliseconds())
				return &DBQueryResult{Success: true, Data: []map[string]interface{}{}, Duration: duration}, nil
			}
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("MongoDB findOne failed: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		duration := int(time.Since(startTime).Milliseconds())
		return &DBQueryResult{Success: true, Data: normalizeMongoResults([]map[string]interface{}{result}), RowsAffected: 1, Duration: duration}, nil

	case "insertOne":
		if cmd.Document == nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := "insertOne requires 'document' field"
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		res, err := collection.InsertOne(ctx, cmd.Document)
		if err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("MongoDB insertOne failed: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		duration := int(time.Since(startTime).Milliseconds())
		data := []map[string]interface{}{{"acknowledged": true, "insertedId": fmt.Sprintf("%v", res.InsertedID)}}
		return &DBQueryResult{Success: true, Data: data, RowsAffected: 1, Duration: duration}, nil

	case "insertMany":
		if len(cmd.Documents) == 0 {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := "insertMany requires 'documents' field"
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		docs := make([]interface{}, len(cmd.Documents))
		for i, d := range cmd.Documents {
			docs[i] = d
		}
		res, err := collection.InsertMany(ctx, docs)
		if err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("MongoDB insertMany failed: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		duration := int(time.Since(startTime).Milliseconds())
		ids := make([]interface{}, len(res.InsertedIDs))
		for i, id := range res.InsertedIDs {
			ids[i] = fmt.Sprintf("%v", id)
		}
		data := []map[string]interface{}{{"acknowledged": true, "insertedIds": ids}}
		return &DBQueryResult{Success: true, Data: data, RowsAffected: int64(len(res.InsertedIDs)), Duration: duration}, nil

	case "updateOne":
		if cmd.Update == nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := "updateOne requires 'update' field"
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		res, err := collection.UpdateOne(ctx, cmd.Filter, cmd.Update)
		if err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("MongoDB updateOne failed: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		duration := int(time.Since(startTime).Milliseconds())
		data := []map[string]interface{}{{"acknowledged": true, "matchedCount": res.MatchedCount, "modifiedCount": res.ModifiedCount}}
		return &DBQueryResult{Success: true, Data: data, RowsAffected: res.ModifiedCount, Duration: duration}, nil

	case "updateMany":
		if cmd.Update == nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := "updateMany requires 'update' field"
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		res, err := collection.UpdateMany(ctx, cmd.Filter, cmd.Update)
		if err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("MongoDB updateMany failed: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		duration := int(time.Since(startTime).Milliseconds())
		data := []map[string]interface{}{{"acknowledged": true, "matchedCount": res.MatchedCount, "modifiedCount": res.ModifiedCount}}
		return &DBQueryResult{Success: true, Data: data, RowsAffected: res.ModifiedCount, Duration: duration}, nil

	case "deleteOne":
		res, err := collection.DeleteOne(ctx, cmd.Filter)
		if err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("MongoDB deleteOne failed: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		duration := int(time.Since(startTime).Milliseconds())
		data := []map[string]interface{}{{"acknowledged": true, "deletedCount": res.DeletedCount}}
		return &DBQueryResult{Success: true, Data: data, RowsAffected: res.DeletedCount, Duration: duration}, nil

	case "deleteMany":
		res, err := collection.DeleteMany(ctx, cmd.Filter)
		if err != nil {
			duration := int(time.Since(startTime).Milliseconds())
			errMsg := fmt.Sprintf("MongoDB deleteMany failed: %v", err)
			return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
		}
		duration := int(time.Since(startTime).Milliseconds())
		data := []map[string]interface{}{{"acknowledged": true, "deletedCount": res.DeletedCount}}
		return &DBQueryResult{Success: true, Data: data, RowsAffected: res.DeletedCount, Duration: duration}, nil

	default:
		duration := int(time.Since(startTime).Milliseconds())
		errMsg := fmt.Sprintf("unsupported MongoDB operation: %s", cmd.Operation)
		return &DBQueryResult{Success: false, Error: errMsg, Duration: duration}, errors.New(errMsg)
	}
}

// normalizeMongoResults converts BSON ObjectIDs and other special types to strings
// for JSON-compatible output.
func normalizeMongoResults(results []map[string]interface{}) []map[string]interface{} {
	for i, row := range results {
		for k, v := range row {
			switch val := v.(type) {
			case bson.M:
				sub := map[string]interface{}(val)
				results[i][k] = sub
			case bson.A:
				arr := []interface{}(val)
				results[i][k] = arr
			default:
				results[i][k] = v
			}
		}
	}
	return results
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
		return nil, errors.New(errMsg)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(body))
	if err != nil {
		duration := int(time.Since(startTime).Milliseconds())
		errMsg := fmt.Sprintf("Failed to create request: %v", err)
		e.logQueryResult(ctx, dbType, databaseName, query, params, false, nil, 0, errMsg, duration)
		return nil, errors.New(errMsg)
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		duration := int(time.Since(startTime).Milliseconds())
		errMsg := fmt.Sprintf("Failed to forward query to db-proxy: %v", err)
		e.logQueryResult(ctx, dbType, databaseName, query, params, false, nil, 0, errMsg, duration)
		return nil, errors.New(errMsg)
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
		return nil, errors.New(errMsg)
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
			// Include empty array for SELECT queries that return no rows
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

	// Accept both 200 (OK) and 201 (Created) as success
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		log.Printf("Log-processor-service returned non-OK status: %d", resp.StatusCode)
		return
	}

	log.Printf("Successfully logged database query for %s/%s", databaseType, databaseName)
}
