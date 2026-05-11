package main

import (
	"testing"
	"time"
)

func TestNewHealthTracker(t *testing.T) {
	expectedItemIds := []string{"item-1", "item-2", "item-3"}

	tracker := NewHealthTracker(expectedItemIds, nil, nil)

	if tracker == nil {
		t.Fatal("NewHealthTracker returned nil")
	}

	status := tracker.GetStatus()
	if len(status) != len(expectedItemIds) {
		t.Errorf("Expected %d items in status, got %d", len(expectedItemIds), len(status))
	}

	for _, id := range expectedItemIds {
		if ready, exists := status[id]; !exists {
			t.Errorf("Expected item %s to be in status map", id)
		} else if ready {
			t.Errorf("Expected item %s to be initially not ready, got ready=true", id)
		}
	}
}

func TestHealthTracker_UpdateHealth(t *testing.T) {
	expectedItemIds := []string{"item-1", "item-2", "item-3"}
	tracker := NewHealthTracker(expectedItemIds, nil, nil)

	tests := []struct {
		name     string
		itemId   string
		ready    bool
		expected map[string]bool
	}{
		{
			name:   "update item to ready",
			itemId: "item-1",
			ready:  true,
			expected: map[string]bool{
				"item-1": true,
				"item-2": false,
				"item-3": false,
			},
		},
		{
			name:   "update item to not ready",
			itemId: "item-1",
			ready:  false,
			expected: map[string]bool{
				"item-1": false,
				"item-2": false,
				"item-3": false,
			},
		},
		{
			name:   "update multiple items",
			itemId: "item-2",
			ready:  true,
			expected: map[string]bool{
				"item-1": false,
				"item-2": true,
				"item-3": false,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tracker.UpdateHealth(tt.itemId, tt.ready)

			status := tracker.GetStatus()
			for itemId, expectedReady := range tt.expected {
				if ready, exists := status[itemId]; !exists {
					t.Errorf("Item %s not found in status", itemId)
				} else if ready != expectedReady {
					t.Errorf("Item %s ready status = %v, want %v", itemId, ready, expectedReady)
				}
			}
		})
	}
}

func TestHealthTracker_WaitForAllReady(t *testing.T) {
	expectedItemIds := []string{"item-1", "item-2", "item-3"}
	tracker := NewHealthTracker(expectedItemIds, nil, nil)

	// Initially not all ready
	allReady := tracker.WaitForAllReady(100 * time.Millisecond)
	if allReady {
		t.Error("Expected WaitForAllReady to return false when items are not ready")
	}

	// Make all items ready
	for _, id := range expectedItemIds {
		tracker.UpdateHealth(id, true)
	}

	// Now should be ready
	allReady = tracker.WaitForAllReady(1 * time.Second)
	if !allReady {
		t.Error("Expected WaitForAllReady to return true when all items are ready")
	}
}

func TestHealthTracker_WaitForAllReady_Timeout(t *testing.T) {
	expectedItemIds := []string{"item-1", "item-2", "item-3"}
	tracker := NewHealthTracker(expectedItemIds, nil, nil)

	// Make only one item ready
	tracker.UpdateHealth("item-1", true)

	// Should timeout because not all items are ready
	allReady := tracker.WaitForAllReady(100 * time.Millisecond)
	if allReady {
		t.Error("Expected WaitForAllReady to return false when not all items are ready")
	}
}

func TestHealthTracker_AllReady(t *testing.T) {
	expectedItemIds := []string{"item-1", "item-2"}
	tracker := NewHealthTracker(expectedItemIds, nil, nil)

	// Make all items ready
	tracker.UpdateHealth("item-1", true)
	tracker.UpdateHealth("item-2", true)

	// Should be ready immediately
	allReady := tracker.WaitForAllReady(1 * time.Second)
	if !allReady {
		t.Error("Expected all items to be ready")
	}
}

func TestHealthTracker_NotReadyNames(t *testing.T) {
	expectedItemIds := []string{"item-1", "item-2", "item-3"}
	nameMap := map[string]string{
		"item-1": "api-gateway",
		"item-2": "user-service",
		"item-3": "postgres-db",
	}
	tracker := NewHealthTracker(expectedItemIds, nil, nameMap)

	// All items not ready initially
	names := tracker.NotReadyNames()
	if len(names) != 3 {
		t.Errorf("Expected 3 not-ready names, got %d", len(names))
	}

	// Mark one as ready
	tracker.UpdateHealth("item-1", true)
	names = tracker.NotReadyNames()
	if len(names) != 2 {
		t.Errorf("Expected 2 not-ready names, got %d", len(names))
	}
	for _, name := range names {
		if name == "api-gateway" {
			t.Error("api-gateway should not be in not-ready list after marking ready")
		}
	}

	// Mark all as ready
	tracker.UpdateHealth("item-2", true)
	tracker.UpdateHealth("item-3", true)
	names = tracker.NotReadyNames()
	if len(names) != 0 {
		t.Errorf("Expected 0 not-ready names, got %d", len(names))
	}
}

func TestHealthTracker_NotReadyNames_FallbackToId(t *testing.T) {
	expectedItemIds := []string{"item-1", "item-2"}
	// No name map — should fall back to item IDs
	tracker := NewHealthTracker(expectedItemIds, nil, nil)

	names := tracker.NotReadyNames()
	if len(names) != 2 {
		t.Errorf("Expected 2 not-ready names, got %d", len(names))
	}
	foundItem1 := false
	for _, name := range names {
		if name == "item-1" {
			foundItem1 = true
		}
	}
	if !foundItem1 {
		t.Error("Expected item-1 in not-ready names when no name map provided")
	}
}

func TestHealthTracker_UnknownItem(t *testing.T) {
	expectedItemIds := []string{"item-1", "item-2"}
	tracker := NewHealthTracker(expectedItemIds, nil, nil)

	// Update an item that's not in the expected list
	tracker.UpdateHealth("unknown-item", true)

	// Should not affect the ready status
	status := tracker.GetStatus()
	if len(status) != len(expectedItemIds) {
		t.Errorf("Expected %d items in status, got %d", len(expectedItemIds), len(status))
	}
}

