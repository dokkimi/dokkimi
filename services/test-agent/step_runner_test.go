package main

import (
	"testing"
)

func TestStepLoopBody_WithBlocks(t *testing.T) {
	blocks := []AssertionBlock{
		{Assertions: []Assertion{{Path: "$.response.status", Operator: "eq", Value: float64(200)}}},
	}
	la := LoopAssertions{Blocks: blocks}
	extract := map[string]ExtractRule{"userId": {Path: "$.response.body.id"}}

	resultBlocks, resultExtract := stepLoopBody(la, nil, extract, nil, nil, nil)

	if len(resultBlocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(resultBlocks))
	}
	if resultBlocks[0].Assertions[0].Operator != "eq" {
		t.Error("expected assertion block passed through")
	}
	if resultExtract == nil || resultExtract["userId"].Path != "$.response.body.id" {
		t.Error("expected extract passed through when blocks present")
	}
}

func TestStepLoopBody_WithFlatAssertions(t *testing.T) {
	flat := []Assertion{
		{Path: "$.response.status", Operator: "eq", Value: float64(200)},
	}
	la := LoopAssertions{Flat: flat}
	extract := map[string]ExtractRule{"name": {Path: "$.response.body.name"}}

	resultBlocks, resultExtract := stepLoopBody(la, nil, extract, nil, nil, nil)

	if len(resultBlocks) != 1 {
		t.Fatalf("expected 1 synthesized block, got %d", len(resultBlocks))
	}
	block := resultBlocks[0]
	if len(block.Assertions) != 1 {
		t.Errorf("expected 1 assertion in block, got %d", len(block.Assertions))
	}
	if block.Extract == nil || block.Extract["name"].Path != "$.response.body.name" {
		t.Error("expected extract folded into block")
	}
	if resultExtract != nil {
		t.Error("expected nil extract return when folded into block")
	}
}

func TestStepLoopBody_WithMatch(t *testing.T) {
	la := LoopAssertions{}
	match := &MatchCriteria{Path: "$.traffic", Where: []WhereEntry{{Path: "$$.to", Operator: "eq", Value: "svc-b"}}}

	resultBlocks, _ := stepLoopBody(la, match, nil, nil, nil, nil)

	if len(resultBlocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(resultBlocks))
	}
	if resultBlocks[0].Match == nil {
		t.Error("expected match criteria in synthesized block")
	}
}

func TestStepLoopBody_WithNestedLoops(t *testing.T) {
	la := LoopAssertions{}
	nested := &ForEachLoop{Items: []interface{}{"a", "b"}, As: "item"}

	resultBlocks, _ := stepLoopBody(la, nil, nil, nested, nil, nil)

	if len(resultBlocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(resultBlocks))
	}
	if resultBlocks[0].ForEach == nil {
		t.Error("expected forEach in synthesized block")
	}
}

func TestStepLoopBody_Empty(t *testing.T) {
	la := LoopAssertions{}

	resultBlocks, resultExtract := stepLoopBody(la, nil, nil, nil, nil, nil)

	if resultBlocks != nil {
		t.Error("expected nil blocks when no content at all")
	}
	if resultExtract != nil {
		t.Error("expected nil extract when nothing provided")
	}
}

func TestStepLoopBody_ExtractOnly(t *testing.T) {
	la := LoopAssertions{}
	extract := map[string]ExtractRule{"val": {Path: "$.response.body.val"}}

	resultBlocks, resultExtract := stepLoopBody(la, nil, extract, nil, nil, nil)

	// extract counts as body content, so it gets folded into a block
	if len(resultBlocks) != 1 {
		t.Fatalf("expected 1 block with extract folded in, got %d", len(resultBlocks))
	}
	if resultBlocks[0].Extract == nil || resultBlocks[0].Extract["val"].Path != "$.response.body.val" {
		t.Error("expected extract in the synthesized block")
	}
	if resultExtract != nil {
		t.Error("expected nil extract return when folded into block")
	}
}

func TestStepLoopBody_BlocksTakePrecedence(t *testing.T) {
	blocks := []AssertionBlock{
		{Assertions: []Assertion{{Path: "$.response.status", Operator: "eq", Value: float64(200)}}},
	}
	flat := []Assertion{
		{Path: "$.response.body", Operator: "exists"},
	}
	la := LoopAssertions{Blocks: blocks, Flat: flat}

	resultBlocks, _ := stepLoopBody(la, nil, nil, nil, nil, nil)

	if len(resultBlocks) != 1 {
		t.Fatalf("expected 1 block (from Blocks), got %d", len(resultBlocks))
	}
	if resultBlocks[0].Assertions[0].Operator != "eq" {
		t.Error("expected Blocks to take precedence over Flat")
	}
}
