package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// ConfigMapReader handles reading configuration from Kubernetes ConfigMaps
type ConfigMapReader struct {
	clientset     *kubernetes.Clientset
	namespace     string
	configMapName string
}

// NewConfigMapReader creates a new ConfigMap reader
func NewConfigMapReader(namespace, configMapName string) (*ConfigMapReader, error) {
	var config *rest.Config
	var err error

	// Try in-cluster config first (when running in K8s)
	config, err = rest.InClusterConfig()
	if err != nil {
		// Fall back to kubeconfig file (for local development)
		kubeconfig := filepath.Join(os.Getenv("HOME"), ".kube", "config")
		if kubeconfigEnv := os.Getenv("KUBECONFIG"); kubeconfigEnv != "" {
			kubeconfig = kubeconfigEnv
		}
		config, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
		if err != nil {
			return nil, fmt.Errorf("failed to get Kubernetes config: %w", err)
		}
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create Kubernetes client: %w", err)
	}

	return &ConfigMapReader{
		clientset:     clientset,
		namespace:     namespace,
		configMapName: configMapName,
	}, nil
}

// ReadConfigMapData reads the ConfigMap and parses the data
func (r *ConfigMapReader) ReadConfigMapData(ctx context.Context) (*ConfigMapData, error) {
	cm, err := r.clientset.CoreV1().ConfigMaps(r.namespace).Get(ctx, r.configMapName, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to get ConfigMap %s/%s: %w", r.namespace, r.configMapName, err)
	}

	data := &ConfigMapData{}

	// Parse expectedNamespaceItemIds
	if idsJSON, ok := cm.Data["expectedNamespaceItemIds"]; ok {
		if err := json.Unmarshal([]byte(idsJSON), &data.ExpectedNamespaceItemIds); err != nil {
			return nil, fmt.Errorf("failed to parse expectedNamespaceItemIds: %w", err)
		}
		log.Printf("Read %d expected namespace item IDs from ConfigMap", len(data.ExpectedNamespaceItemIds))
	} else {
		log.Printf("Warning: expectedNamespaceItemIds not found in ConfigMap")
	}

	// Parse testConfig
	if testConfigJSON, ok := cm.Data["testConfig"]; ok {
		var testConfig TestConfig
		if err := json.Unmarshal([]byte(testConfigJSON), &testConfig); err != nil {
			return nil, fmt.Errorf("failed to parse testConfig: %w", err)
		}
		data.TestConfig = &testConfig
		log.Printf("Read test config with testRunId: %s", testConfig.TestRunID)
	} else {
		return nil, fmt.Errorf("testConfig not found in ConfigMap")
	}

	// Parse urlMap
	if urlMapJSON, ok := cm.Data["urlMap"]; ok {
		if err := json.Unmarshal([]byte(urlMapJSON), &data.URLMap); err != nil {
			return nil, fmt.Errorf("failed to parse urlMap: %w", err)
		}
		log.Printf("Read URL map with %d entries", len(data.URLMap))
	} else {
		log.Printf("Warning: urlMap not found in ConfigMap")
		data.URLMap = make(map[string]URLMapEntry)
	}

	// Parse databaseMap
	if databaseMapJSON, ok := cm.Data["databaseMap"]; ok {
		if err := json.Unmarshal([]byte(databaseMapJSON), &data.DatabaseMap); err != nil {
			return nil, fmt.Errorf("failed to parse databaseMap: %w", err)
		}
		log.Printf("Read database map with %d entries", len(data.DatabaseMap))
	} else {
		log.Printf("Warning: databaseMap not found in ConfigMap")
		data.DatabaseMap = make(map[string]DatabaseInfo)
	}

	return data, nil
}

// GetClientset returns the Kubernetes clientset (for use by other components)
func (r *ConfigMapReader) GetClientset() *kubernetes.Clientset {
	return r.clientset
}
