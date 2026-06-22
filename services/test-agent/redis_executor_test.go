package main

import (
	"testing"
)

func TestParseRedisCommand(t *testing.T) {
	t.Run("simple command", func(t *testing.T) {
		args := parseRedisCommand("GET mykey")
		assertArgs(t, args, []string{"GET", "mykey"})
	})

	t.Run("quoted value", func(t *testing.T) {
		args := parseRedisCommand(`SET mykey "hello world"`)
		assertArgs(t, args, []string{"SET", "mykey", "hello world"})
	})

	t.Run("empty quoted string", func(t *testing.T) {
		args := parseRedisCommand(`SET mykey ""`)
		assertArgs(t, args, []string{"SET", "mykey", ""})
	})

	t.Run("empty quoted string in middle", func(t *testing.T) {
		args := parseRedisCommand(`MSET key1 "" key2 value2`)
		assertArgs(t, args, []string{"MSET", "key1", "", "key2", "value2"})
	})

	t.Run("multiple spaces between args", func(t *testing.T) {
		args := parseRedisCommand("GET   mykey")
		assertArgs(t, args, []string{"GET", "mykey"})
	})

	t.Run("leading and trailing whitespace", func(t *testing.T) {
		args := parseRedisCommand("  GET mykey  ")
		assertArgs(t, args, []string{"GET", "mykey"})
	})

	t.Run("quoted string with spaces", func(t *testing.T) {
		args := parseRedisCommand(`HSET user:1 name "John Doe" age 30`)
		assertArgs(t, args, []string{"HSET", "user:1", "name", "John Doe", "age", "30"})
	})

	t.Run("single arg command", func(t *testing.T) {
		args := parseRedisCommand("PING")
		assertArgs(t, args, []string{"PING"})
	})

	t.Run("empty string returns empty", func(t *testing.T) {
		args := parseRedisCommand("")
		if len(args) != 0 {
			t.Errorf("expected empty, got %v", args)
		}
	})

	t.Run("only spaces returns empty", func(t *testing.T) {
		args := parseRedisCommand("   ")
		if len(args) != 0 {
			t.Errorf("expected empty, got %v", args)
		}
	})

	t.Run("multiple quoted strings", func(t *testing.T) {
		args := parseRedisCommand(`SET "my key" "my value"`)
		assertArgs(t, args, []string{"SET", "my key", "my value"})
	})

	t.Run("adjacent empty quoted strings", func(t *testing.T) {
		args := parseRedisCommand(`MSET "" ""`)
		assertArgs(t, args, []string{"MSET", "", ""})
	})
}

func assertArgs(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("expected %d args %v, got %d args %v", len(want), want, len(got), got)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("arg[%d]: expected %q, got %q", i, want[i], got[i])
		}
	}
}
