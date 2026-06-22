package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

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
