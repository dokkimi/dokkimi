package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"strconv"
	"strings"
)

const (
	sslRequestCode    = 80877103
	cancelRequestCode = 80877102

	// Client message types
	msgQuery     byte = 'Q'
	msgParse     byte = 'P'
	msgBind      byte = 'B'
	msgExecute   byte = 'E'
	msgSync      byte = 'S'
	msgTerminate byte = 'X'

	// Server message types
	msgAuthRequest     byte = 'R'
	msgParameterStatus byte = 'S'
	msgBackendKeyData  byte = 'K'
	msgReadyForQuery   byte = 'Z'
	msgCommandComplete byte = 'C'
	msgErrorResponse   byte = 'E'
	msgRowDescription  byte = 'T'
	msgDataRow         byte = 'D'
	msgParseComplete   byte = '1'
	msgBindComplete    byte = '2'
	msgNoData          byte = 'n'
	msgNoticeResponse  byte = 'N'
)

// StartupMessage represents the initial message from a PG client
type StartupMessage struct {
	ProtocolVersion uint32
	Parameters      map[string]string
	Raw             []byte
}

// readStartupMessage reads the initial (untyped) startup message from a client.
// PG startup messages have no type byte — just length(4) + payload.
func readStartupMessage(r io.Reader) (msgLen int32, raw []byte, err error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return 0, nil, fmt.Errorf("read startup length: %w", err)
	}
	msgLen = int32(binary.BigEndian.Uint32(lenBuf[:]))
	if msgLen < 4 || msgLen > 10000 {
		return 0, nil, fmt.Errorf("invalid startup message length: %d", msgLen)
	}

	raw = make([]byte, msgLen)
	copy(raw[:4], lenBuf[:])
	if _, err := io.ReadFull(r, raw[4:]); err != nil {
		return 0, nil, fmt.Errorf("read startup body: %w", err)
	}
	return msgLen, raw, nil
}

// isSSLRequest checks if a startup message is an SSL request
func isSSLRequest(raw []byte) bool {
	if len(raw) != 8 {
		return false
	}
	code := binary.BigEndian.Uint32(raw[4:8])
	return code == sslRequestCode
}

// isCancelRequest checks if a startup message is a cancel request
func isCancelRequest(raw []byte) bool {
	if len(raw) < 8 {
		return false
	}
	code := binary.BigEndian.Uint32(raw[4:8])
	return code == cancelRequestCode
}

// parseStartupParams extracts key=value parameters from a startup message
func parseStartupParams(raw []byte) map[string]string {
	params := make(map[string]string)
	// Skip length(4) + protocol version(4)
	payload := raw[8:]
	for len(payload) > 1 {
		keyEnd := indexOf(payload, 0)
		if keyEnd < 0 {
			break
		}
		key := string(payload[:keyEnd])
		payload = payload[keyEnd+1:]

		valEnd := indexOf(payload, 0)
		if valEnd < 0 {
			break
		}
		value := string(payload[:valEnd])
		payload = payload[valEnd+1:]

		params[key] = value
	}
	return params
}

func indexOf(b []byte, target byte) int {
	for i, v := range b {
		if v == target {
			return i
		}
	}
	return -1
}

// readMessage reads a typed PG protocol message (type byte + length + payload).
// Returns the type byte and the full frame (type + length + body) for forwarding.
func readMessage(r io.Reader) (msgType byte, frame []byte, err error) {
	var header [5]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return 0, nil, err
	}

	msgType = header[0]
	bodyLen := int(binary.BigEndian.Uint32(header[1:5])) - 4
	if bodyLen < 0 || bodyLen > 1<<24 {
		return 0, nil, fmt.Errorf("invalid message length: %d", bodyLen+4)
	}

	frame = make([]byte, 5+bodyLen)
	copy(frame[:5], header[:])
	if bodyLen > 0 {
		if _, err := io.ReadFull(r, frame[5:]); err != nil {
			return 0, nil, fmt.Errorf("read message body: %w", err)
		}
	}
	return msgType, frame, nil
}

// extractSimpleQuery extracts the SQL string from a Query ('Q') message frame
func extractSimpleQuery(frame []byte) string {
	// frame: type(1) + length(4) + null-terminated query string
	if len(frame) < 6 {
		return ""
	}
	body := frame[5:]
	// Remove trailing null
	if len(body) > 0 && body[len(body)-1] == 0 {
		body = body[:len(body)-1]
	}
	return string(body)
}

// extractParseQuery extracts the statement name and SQL from a Parse ('P') message frame
func extractParseQuery(frame []byte) (stmtName string, query string) {
	if len(frame) < 6 {
		return "", ""
	}
	body := frame[5:]

	// Statement name (null-terminated)
	nameEnd := indexOf(body, 0)
	if nameEnd < 0 {
		return "", ""
	}
	stmtName = string(body[:nameEnd])
	body = body[nameEnd+1:]

	// Query string (null-terminated)
	queryEnd := indexOf(body, 0)
	if queryEnd < 0 {
		return stmtName, ""
	}
	query = string(body[:queryEnd])
	return stmtName, query
}

// extractCommandTag extracts the command tag from a CommandComplete ('C') message frame
// Returns the tag string and parsed rows affected (if any)
func extractCommandTag(frame []byte) (tag string, rowsAffected int64) {
	if len(frame) < 6 {
		return "", 0
	}
	body := frame[5:]
	if len(body) > 0 && body[len(body)-1] == 0 {
		body = body[:len(body)-1]
	}
	tag = string(body)

	// Parse rows affected from tags like "INSERT 0 5", "UPDATE 3", "DELETE 1"
	parts := strings.Fields(tag)
	if len(parts) >= 2 {
		last := parts[len(parts)-1]
		var n int64
		for _, c := range last {
			if c >= '0' && c <= '9' {
				n = n*10 + int64(c-'0')
			} else {
				return tag, 0
			}
		}
		rowsAffected = n
	}
	return tag, rowsAffected
}

// columnMeta holds the name and type OID for a column from RowDescription
type columnMeta struct {
	name    string
	typeOID uint32
}

// extractColumnInfo extracts column names and type OIDs from a RowDescription ('T') frame
func extractColumnInfo(frame []byte) []columnMeta {
	if len(frame) < 7 {
		return nil
	}
	body := frame[5:]
	if len(body) < 2 {
		return nil
	}
	numFields := int(binary.BigEndian.Uint16(body[:2]))
	body = body[2:]

	cols := make([]columnMeta, 0, numFields)
	for i := 0; i < numFields && len(body) > 0; i++ {
		nameEnd := indexOf(body, 0)
		if nameEnd < 0 {
			break
		}
		name := string(body[:nameEnd])
		body = body[nameEnd+1:]
		// tableOID(4) + columnAttr(2) + typeOID(4) + typeLen(2) + typeMod(4) + formatCode(2) = 18 bytes
		if len(body) < 18 {
			break
		}
		typeOID := binary.BigEndian.Uint32(body[6:10])
		cols = append(cols, columnMeta{name: name, typeOID: typeOID})
		body = body[18:]
	}
	return cols
}


// extractTypedDataRow extracts column values from a DataRow ('D') frame, using
// type OIDs from RowDescription to coerce text-format values to native types.
func extractTypedDataRow(frame []byte, cols []columnMeta) []interface{} {
	if len(frame) < 7 {
		return nil
	}
	body := frame[5:]
	if len(body) < 2 {
		return nil
	}
	numCols := int(binary.BigEndian.Uint16(body[:2]))
	body = body[2:]

	values := make([]interface{}, 0, numCols)
	for i := 0; i < numCols && len(body) >= 4; i++ {
		colLen := int32(binary.BigEndian.Uint32(body[:4]))
		body = body[4:]
		if colLen == -1 {
			values = append(values, nil)
		} else {
			if int(colLen) > len(body) {
				break
			}
			s := string(body[:colLen])
			if i < len(cols) {
				values = append(values, coerceValue(s, cols[i].typeOID))
			} else {
				values = append(values, s)
			}
			body = body[colLen:]
		}
	}
	return values
}

// coerceValue converts a text-format PG wire value to a native Go type based on the type OID.
func coerceValue(s string, oid uint32) interface{} {
	switch oid {
	case 20, 21, 23: // int8, int2, int4
		if v, err := strconv.ParseInt(s, 10, 64); err == nil {
			return v
		}
	case 700, 701, 1700: // float4, float8, numeric
		if v, err := strconv.ParseFloat(s, 64); err == nil {
			return v
		}
	case 16: // bool
		return s == "t" || s == "true"
	}
	return s
}

// extractErrorMessage extracts the primary error message from an ErrorResponse ('E') frame
func extractErrorMessage(frame []byte) string {
	if len(frame) < 6 {
		return ""
	}
	body := frame[5:]
	// ErrorResponse is a series of field type(1) + null-terminated string, terminated by \0
	for len(body) > 1 {
		fieldType := body[0]
		body = body[1:]
		end := indexOf(body, 0)
		if end < 0 {
			break
		}
		if fieldType == 'M' {
			return string(body[:end])
		}
		body = body[end+1:]
	}
	return ""
}
