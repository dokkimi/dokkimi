package main

import "io"

// Helper functions for tests

func intPtr(i int) *int {
	return &i
}

func stringPtr(s string) *string {
	return &s
}

// errorReader is a ReadCloser that always returns an error
type errorReader struct{}

func (e *errorReader) Read(p []byte) (n int, err error) {
	return 0, io.ErrUnexpectedEOF
}

func (e *errorReader) Close() error {
	return nil
}
