package main

import (
	"fmt"
	"log"
	"sync"
	"time"
)

// HealthTracker tracks the health status of all expected namespace items
type HealthTracker struct {
	expectedItemIds     map[string]bool   // Map of item IDs we're waiting for
	healthStatus        map[string]bool   // Map of item ID -> ready status
	itemIdToName        map[string]string // Map of item ID -> human-readable name
	mutex               sync.RWMutex
	allReadyChan        chan struct{} // Channel to signal when all items are ready
	allReadyOnce        sync.Once
	testExecutionLogger *TestExecutionLogger
}

// NewHealthTracker creates a new health tracker
func NewHealthTracker(expectedItemIds []string, testExecutionLogger *TestExecutionLogger, itemIdToName map[string]string) *HealthTracker {
	expectedMap := make(map[string]bool)
	healthMap := make(map[string]bool)

	for _, id := range expectedItemIds {
		expectedMap[id] = true
		healthMap[id] = false // Initially not ready
	}

	ht := &HealthTracker{
		expectedItemIds:     expectedMap,
		healthStatus:        healthMap,
		itemIdToName:        itemIdToName,
		allReadyChan:        make(chan struct{}),
		testExecutionLogger: testExecutionLogger,
	}
	ht.checkAndSignalAllReady()
	return ht
}

// Reset swaps in a new set of expected items and creates a fresh allReadyChan.
// Used for staged bootup: after stage N is healthy, Reset is called with stage N+1's item IDs.
// Health updates for items not in the new expected set are harmlessly dropped.
func (h *HealthTracker) Reset(expectedItemIds []string) {
	h.mutex.Lock()
	defer h.mutex.Unlock()

	h.expectedItemIds = make(map[string]bool)
	h.healthStatus = make(map[string]bool)
	for _, id := range expectedItemIds {
		h.expectedItemIds[id] = true
		h.healthStatus[id] = false
	}
	h.allReadyChan = make(chan struct{})
	h.allReadyOnce = sync.Once{}

	log.Printf("Health tracker reset: now tracking %d items", len(expectedItemIds))
	h.checkAndSignalAllReady()
}

// resolveName returns the human-readable name for an item ID, falling back to the ID itself
func (h *HealthTracker) resolveName(itemId string) string {
	if name, ok := h.itemIdToName[itemId]; ok && name != "" {
		return name
	}
	return itemId
}

// UpdateHealth updates the health status for a specific item
// itemId can be either the instanceItemId or instanceItemName
func (h *HealthTracker) UpdateHealth(itemId string, ready bool) {
	h.mutex.Lock()
	defer h.mutex.Unlock()

	// Check if this item is in our expected list
	if _, expected := h.expectedItemIds[itemId]; !expected {
		log.Printf("Health update for item %s (ready: %v) - not in expected list", itemId, ready)
		return
	}

	wasReady := h.healthStatus[itemId]
	h.healthStatus[itemId] = ready

	if !wasReady && ready {
		name := h.resolveName(itemId)
		log.Printf("Item %s became ready", name)
		if h.testExecutionLogger != nil {
			h.testExecutionLogger.LogEvent("HEALTH_ITEM_READY", fmt.Sprintf("%s is ready", name), nil, nil)
		}
	}

	h.checkAndSignalAllReady()
}

// checkAndSignalAllReady closes allReadyChan if all expected items are ready (caller must hold the lock or guarantee exclusive access)
func (h *HealthTracker) checkAndSignalAllReady() {
	if h.allReady() {
		h.allReadyOnce.Do(func() {
			close(h.allReadyChan)
			log.Printf("All expected items are now ready!")
			if h.testExecutionLogger != nil {
				h.testExecutionLogger.LogEvent("HEALTH_ALL_READY", "All services ready", nil, nil)
			}
		})
	}
}

// allReady checks if all expected items are ready (must be called with lock held)
func (h *HealthTracker) allReady() bool {
	for itemId := range h.expectedItemIds {
		if !h.healthStatus[itemId] {
			return false
		}
	}
	return true
}

// WaitForAllReady waits for all items to be ready, with optional timeout
func (h *HealthTracker) WaitForAllReady(timeout time.Duration) bool {
	select {
	case <-h.allReadyChan:
		return true
	case <-time.After(timeout):
		h.mutex.RLock()
		defer h.mutex.RUnlock()
		log.Printf("Timeout waiting for all items to be ready")
		for itemId, ready := range h.healthStatus {
			if !ready {
				name := h.resolveName(itemId)
				log.Printf("  %s is still not ready", name)
			}
		}
		return false
	}
}

// NotReadyNames returns the human-readable names of items that are not yet ready.
func (h *HealthTracker) NotReadyNames() []string {
	h.mutex.RLock()
	defer h.mutex.RUnlock()

	var names []string
	for itemId, ready := range h.healthStatus {
		if !ready {
			names = append(names, h.resolveName(itemId))
		}
	}
	return names
}

// GetStatus returns the current health status (for debugging)
func (h *HealthTracker) GetStatus() map[string]bool {
	h.mutex.RLock()
	defer h.mutex.RUnlock()

	status := make(map[string]bool)
	for k, v := range h.healthStatus {
		status[k] = v
	}
	return status
}
