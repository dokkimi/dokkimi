package main

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// RESP2 type prefixes
const (
	respSimpleString = '+'
	respError        = '-'
	respInteger      = ':'
	respBulkString   = '$'
	respArray        = '*'
)

// RESP3 type prefixes (returned when client sends HELLO 3)
const (
	respMap            = '%'
	respSet            = '~'
	respAttribute      = '|'
	respPush           = '>'
	respNull           = '_'
	respDouble         = ','
	respBoolean        = '#'
	respBigNumber      = '('
	respBulkError      = '!'
	respVerbatimString = '='
)

// respValue represents a parsed RESP value
type respValue struct {
	typ      byte
	str      string
	integer  int64
	array    []respValue
	isNull   bool
	rawBytes []byte // original wire bytes for forwarding
}

// readRESP reads a complete RESP value from the reader, accumulating raw bytes
// for forwarding. Only the top-level value gets rawBytes set.
func readRESP(r *bufio.Reader) (*respValue, error) {
	var raw []byte
	val, err := readRESPInner(r, &raw)
	if err != nil {
		return nil, err
	}
	val.rawBytes = raw
	return val, nil
}

func readRESPInner(r *bufio.Reader, raw *[]byte) (*respValue, error) {
	line, err := r.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	*raw = append(*raw, line...)

	if len(line) < 3 || line[len(line)-2] != '\r' {
		return nil, fmt.Errorf("invalid RESP line: %q", line)
	}

	typ := line[0]
	content := string(line[1 : len(line)-2])

	switch typ {
	case respSimpleString:
		return &respValue{typ: typ, str: content}, nil

	case respError:
		return &respValue{typ: typ, str: content}, nil

	case respInteger:
		n, err := strconv.ParseInt(content, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid integer: %w", err)
		}
		return &respValue{typ: typ, integer: n}, nil

	case respBulkString:
		length, err := strconv.Atoi(content)
		if err != nil {
			return nil, fmt.Errorf("invalid bulk string length: %w", err)
		}
		if length == -1 {
			return &respValue{typ: typ, isNull: true}, nil
		}
		buf := make([]byte, length+2) // data + \r\n
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, fmt.Errorf("read bulk string body: %w", err)
		}
		*raw = append(*raw, buf...)
		return &respValue{typ: typ, str: string(buf[:length])}, nil

	case respArray, respSet, respPush:
		count, err := strconv.Atoi(content)
		if err != nil {
			return nil, fmt.Errorf("invalid array/set/push count: %w", err)
		}
		if count == -1 {
			return &respValue{typ: typ, isNull: true}, nil
		}
		elements := make([]respValue, count)
		for i := 0; i < count; i++ {
			elem, err := readRESPInner(r, raw)
			if err != nil {
				return nil, fmt.Errorf("read element %d: %w", i, err)
			}
			elements[i] = *elem
		}
		return &respValue{typ: typ, array: elements}, nil

	case respMap, respAttribute:
		// Maps and attributes have N entries, each entry is a key-value pair (2N elements)
		count, err := strconv.Atoi(content)
		if err != nil {
			return nil, fmt.Errorf("invalid map/attribute count: %w", err)
		}
		elements := make([]respValue, count*2)
		for i := 0; i < count*2; i++ {
			elem, err := readRESPInner(r, raw)
			if err != nil {
				return nil, fmt.Errorf("read map element %d: %w", i, err)
			}
			elements[i] = *elem
		}
		return &respValue{typ: typ, array: elements}, nil

	case respNull:
		return &respValue{typ: typ, isNull: true}, nil

	case respDouble:
		f, err := strconv.ParseFloat(content, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid double: %w", err)
		}
		return &respValue{typ: typ, str: content, integer: int64(f)}, nil

	case respBoolean:
		return &respValue{typ: typ, str: content, integer: boolToInt(content)}, nil

	case respBigNumber:
		return &respValue{typ: typ, str: content}, nil

	case respBulkError:
		length, err := strconv.Atoi(content)
		if err != nil {
			return nil, fmt.Errorf("invalid bulk error length: %w", err)
		}
		if length == -1 {
			return &respValue{typ: respError, isNull: true}, nil
		}
		buf := make([]byte, length+2)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, fmt.Errorf("read bulk error body: %w", err)
		}
		*raw = append(*raw, buf...)
		return &respValue{typ: respError, str: string(buf[:length])}, nil

	case respVerbatimString:
		length, err := strconv.Atoi(content)
		if err != nil {
			return nil, fmt.Errorf("invalid verbatim string length: %w", err)
		}
		if length == -1 {
			return &respValue{typ: respBulkString, isNull: true}, nil
		}
		buf := make([]byte, length+2)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, fmt.Errorf("read verbatim string body: %w", err)
		}
		*raw = append(*raw, buf...)
		// Verbatim string: first 3 bytes are encoding (e.g. "txt"), then ":", then content
		s := string(buf[:length])
		if len(s) > 4 && s[3] == ':' {
			s = s[4:]
		}
		return &respValue{typ: respBulkString, str: s}, nil

	default:
		// Inline command (no type prefix) — treat entire line as a simple string.
		// This handles clients that send plain-text commands like "PING\r\n".
		full := string(line[:len(line)-2])
		return &respValue{typ: respSimpleString, str: full}, nil
	}
}

func boolToInt(s string) int64 {
	if s == "t" {
		return 1
	}
	return 0
}

// extractCommand extracts the command string from a RESP array (e.g. ["SET", "key", "value"] → "SET key value")
func extractCommand(v *respValue) string {
	if v.typ != respArray || v.isNull || len(v.array) == 0 {
		if v.typ == respSimpleString {
			return v.str
		}
		return ""
	}
	parts := make([]string, len(v.array))
	for i, elem := range v.array {
		parts[i] = elem.str
	}
	return strings.Join(parts, " ")
}

// extractCommandName returns just the command name (first element, uppercased)
func extractCommandName(v *respValue) string {
	if v.typ != respArray || v.isNull || len(v.array) == 0 {
		if v.typ == respSimpleString {
			parts := strings.Fields(v.str)
			if len(parts) > 0 {
				return strings.ToUpper(parts[0])
			}
		}
		return ""
	}
	return strings.ToUpper(v.array[0].str)
}

// normalizeResponse converts a RESP response value into []map[string]interface{} for logging
func normalizeResponse(cmdName string, v *respValue) []map[string]interface{} {
	if v == nil || v.isNull {
		return []map[string]interface{}{}
	}

	switch v.typ {
	case respArray, respSet, respPush:
		if cmdName == "HGETALL" && len(v.array)%2 == 0 {
			row := make(map[string]interface{})
			for i := 0; i < len(v.array); i += 2 {
				key := respToInterface(v.array[i])
				row[fmt.Sprintf("%v", key)] = respToInterface(v.array[i+1])
			}
			return []map[string]interface{}{row}
		}
		rows := make([]map[string]interface{}, len(v.array))
		for i, elem := range v.array {
			rows[i] = map[string]interface{}{"value": respToInterface(elem)}
		}
		return rows

	case respMap, respAttribute:
		if len(v.array)%2 == 0 {
			row := make(map[string]interface{})
			for i := 0; i < len(v.array); i += 2 {
				key := respToInterface(v.array[i])
				row[fmt.Sprintf("%v", key)] = respToInterface(v.array[i+1])
			}
			return []map[string]interface{}{row}
		}
		return []map[string]interface{}{}

	case respInteger:
		return []map[string]interface{}{{"value": v.integer}}

	case respDouble:
		return []map[string]interface{}{{"value": v.str}}

	case respBoolean:
		return []map[string]interface{}{{"value": v.integer == 1}}

	case respSimpleString, respBulkString:
		return []map[string]interface{}{{"value": v.str}}

	case respError, respBulkError:
		return nil

	case respNull:
		return []map[string]interface{}{}

	default:
		return []map[string]interface{}{}
	}
}

func respToInterface(v respValue) interface{} {
	if v.isNull {
		return nil
	}
	switch v.typ {
	case respInteger:
		return v.integer
	case respDouble:
		f, err := strconv.ParseFloat(v.str, 64)
		if err != nil {
			return v.str
		}
		return f
	case respBoolean:
		return v.integer == 1
	case respBulkString, respSimpleString, respBigNumber:
		return v.str
	case respArray, respSet, respPush:
		arr := make([]interface{}, len(v.array))
		for i, e := range v.array {
			arr[i] = respToInterface(e)
		}
		return arr
	case respMap, respAttribute:
		m := make(map[string]interface{})
		for i := 0; i+1 < len(v.array); i += 2 {
			key := fmt.Sprintf("%v", respToInterface(v.array[i]))
			m[key] = respToInterface(v.array[i+1])
		}
		return m
	default:
		return v.str
	}
}
