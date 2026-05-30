package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
)

// FileConfigReader reads configuration from a JSON file on disk.
// The file uses the same structure as a K8s ConfigMap data field:
// each top-level key maps to a JSON-stringified value.
type FileConfigReader struct {
	filePath string
}

func NewFileConfigReader(filePath string) *FileConfigReader {
	return &FileConfigReader{filePath: filePath}
}

func (r *FileConfigReader) ReadConfigData() (*ConfigMapData, error) {
	raw, err := os.ReadFile(r.filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file %s: %w", r.filePath, err)
	}

	var fileData map[string]string
	if err := json.Unmarshal(raw, &fileData); err != nil {
		return nil, fmt.Errorf("failed to parse config file as JSON: %w", err)
	}

	data := &ConfigMapData{}

	if idsJSON, ok := fileData["expectedNamespaceItemIds"]; ok {
		if err := json.Unmarshal([]byte(idsJSON), &data.ExpectedNamespaceItemIds); err != nil {
			return nil, fmt.Errorf("failed to parse expectedNamespaceItemIds: %w", err)
		}
		log.Printf("Read %d expected namespace item IDs from config file", len(data.ExpectedNamespaceItemIds))
	} else {
		log.Printf("Warning: expectedNamespaceItemIds not found in config file")
	}

	if testConfigJSON, ok := fileData["testConfig"]; ok {
		var testConfig TestConfig
		if err := json.Unmarshal([]byte(testConfigJSON), &testConfig); err != nil {
			return nil, fmt.Errorf("failed to parse testConfig: %w", err)
		}
		data.TestConfig = &testConfig
		log.Printf("Read test config with testRunId: %s", testConfig.TestRunID)
	} else {
		return nil, fmt.Errorf("testConfig not found in config file")
	}

	if urlMapJSON, ok := fileData["urlMap"]; ok {
		if err := json.Unmarshal([]byte(urlMapJSON), &data.URLMap); err != nil {
			return nil, fmt.Errorf("failed to parse urlMap: %w", err)
		}
		log.Printf("Read URL map with %d entries", len(data.URLMap))
	} else {
		log.Printf("Warning: urlMap not found in config file")
		data.URLMap = make(map[string]URLMapEntry)
	}

	if databaseMapJSON, ok := fileData["databaseMap"]; ok {
		if err := json.Unmarshal([]byte(databaseMapJSON), &data.DatabaseMap); err != nil {
			return nil, fmt.Errorf("failed to parse databaseMap: %w", err)
		}
		log.Printf("Read database map with %d entries", len(data.DatabaseMap))
	} else {
		log.Printf("Warning: databaseMap not found in config file")
		data.DatabaseMap = make(map[string]DatabaseInfo)
	}

	return data, nil
}
