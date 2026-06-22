package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	mongoOptions "go.mongodb.org/mongo-driver/v2/mongo/options"
)

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
