package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	_ "github.com/lib/pq"
)

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
				row[col] = coercePostgresValue(values[i], colTypes, i)
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

// coercePostgresValue converts a scanned value to the appropriate Go type.
// lib/pq returns most values as native types, but NUMERIC columns arrive as
// []byte. We use the column's DatabaseTypeName to coerce to int64/float64.
func coercePostgresValue(val interface{}, colTypes []*sql.ColumnType, idx int) interface{} {
	if val == nil {
		return nil
	}
	b, ok := val.([]byte)
	if !ok {
		return val
	}
	typeName := ""
	if colTypes != nil && idx < len(colTypes) {
		typeName = colTypes[idx].DatabaseTypeName()
	}
	return coercePostgresString(string(b), typeName)
}

func coercePostgresString(s string, typeName string) interface{} {
	switch typeName {
	case "INT2", "INT4", "INT8":
		if v, err := strconv.ParseInt(s, 10, 64); err == nil {
			return v
		}
	case "FLOAT4", "FLOAT8", "NUMERIC":
		if v, err := strconv.ParseFloat(s, 64); err == nil {
			return v
		}
	}
	return s
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
