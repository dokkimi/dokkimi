package main

import "testing"

func TestErrorReader(t *testing.T) {
	reader := &errorReader{}

	// Test Read
	buf := make([]byte, 10)
	n, err := reader.Read(buf)
	if n != 0 {
		t.Errorf("Expected 0 bytes read, got %d", n)
	}
	if err == nil {
		t.Error("Expected error from Read")
	}

	// Test Close
	err = reader.Close()
	if err != nil {
		t.Errorf("Close() should not return error, got %v", err)
	}
}

