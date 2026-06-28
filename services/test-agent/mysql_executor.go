package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

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
	typeName := ""
	if colTypes != nil && idx < len(colTypes) {
		typeName = colTypes[idx].DatabaseTypeName()
	}
	return coerceMysqlString(string(b), typeName)
}

func coerceMysqlString(s string, typeName string) interface{} {
	switch typeName {
	case "TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT", "YEAR":
		if v, err := strconv.ParseInt(s, 10, 64); err == nil {
			return v
		}
	case "FLOAT", "DOUBLE", "DECIMAL":
		if v, err := strconv.ParseFloat(s, 64); err == nil {
			return v
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
