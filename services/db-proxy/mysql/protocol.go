package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"strconv"
)

const (
	comQuit        byte = 0x01
	comQuery       byte = 0x03
	comStmtPrepare byte = 0x16
	comStmtExecute byte = 0x17

	okHeader  byte = 0x00
	errHeader byte = 0xff
	eofHeader byte = 0xfe
	nullValue byte = 0xfb

	fieldTypeTiny       byte = 0x01
	fieldTypeShort      byte = 0x02
	fieldTypeLong       byte = 0x03
	fieldTypeFloat      byte = 0x04
	fieldTypeDouble     byte = 0x05
	fieldTypeLongLong   byte = 0x08
	fieldTypeInt24      byte = 0x09
	fieldTypeNewDecimal byte = 0xf6
	fieldTypeVarString  byte = 0xfd
)

// mysqlPacket represents a single MySQL protocol packet
type mysqlPacket struct {
	sequenceID byte
	payload    []byte
}

// readPacket reads a single MySQL packet (4-byte header + payload)
func readPacket(r io.Reader) (*mysqlPacket, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}

	payloadLen := int(header[0]) | int(header[1])<<8 | int(header[2])<<16
	seqID := header[3]

	payload := make([]byte, payloadLen)
	if payloadLen > 0 {
		if _, err := io.ReadFull(r, payload); err != nil {
			return nil, fmt.Errorf("read packet payload: %w", err)
		}
	}

	return &mysqlPacket{sequenceID: seqID, payload: payload}, nil
}

// rawBytes returns the full wire-format bytes of the packet (header + payload)
func (p *mysqlPacket) rawBytes() []byte {
	buf := make([]byte, 4+len(p.payload))
	buf[0] = byte(len(p.payload))
	buf[1] = byte(len(p.payload) >> 8)
	buf[2] = byte(len(p.payload) >> 16)
	buf[3] = p.sequenceID
	copy(buf[4:], p.payload)
	return buf
}

// isOK returns true if this is an OK packet
func (p *mysqlPacket) isOK() bool {
	return len(p.payload) > 0 && p.payload[0] == okHeader
}

// isERR returns true if this is an ERR packet
func (p *mysqlPacket) isERR() bool {
	return len(p.payload) > 0 && p.payload[0] == errHeader
}

// isEOF returns true if this is an EOF packet (0xFE with payload < 9 bytes)
func (p *mysqlPacket) isEOF() bool {
	return len(p.payload) > 0 && p.payload[0] == eofHeader && len(p.payload) < 9
}

// isResultSet returns true if the first payload byte indicates a column count
func (p *mysqlPacket) isResultSet() bool {
	if len(p.payload) == 0 {
		return false
	}
	b := p.payload[0]
	return b != okHeader && b != errHeader && b != eofHeader && b != nullValue
}

// extractErrorMessage extracts the error message from an ERR packet
func extractErrorMessage(payload []byte) string {
	if len(payload) < 4 {
		return ""
	}
	// Skip header(1) + error_code(2)
	off := 3
	// If CLIENT_PROTOCOL_41: sql_state_marker(1) + sql_state(5)
	if off < len(payload) && payload[off] == '#' {
		off += 6
	}
	if off >= len(payload) {
		return ""
	}
	return string(payload[off:])
}

// extractOKAffectedRows extracts affected_rows from an OK packet
func extractOKAffectedRows(payload []byte) int64 {
	if len(payload) < 2 {
		return 0
	}
	val, _ := readLenEncInt(payload[1:])
	return int64(val)
}

// readLenEncInt reads a length-encoded integer from a byte slice.
// Returns the value and number of bytes consumed.
func readLenEncInt(data []byte) (uint64, int) {
	if len(data) == 0 {
		return 0, 0
	}
	switch {
	case data[0] < 0xfb:
		return uint64(data[0]), 1
	case data[0] == 0xfc:
		if len(data) < 3 {
			return 0, 0
		}
		return uint64(binary.LittleEndian.Uint16(data[1:3])), 3
	case data[0] == 0xfd:
		if len(data) < 4 {
			return 0, 0
		}
		return uint64(data[1]) | uint64(data[2])<<8 | uint64(data[3])<<16, 4
	case data[0] == 0xfe:
		if len(data) < 9 {
			return 0, 0
		}
		return binary.LittleEndian.Uint64(data[1:9]), 9
	default:
		return 0, 0
	}
}

// readLenEncString reads a length-encoded string from a byte slice.
// Returns the string, bytes consumed, and whether it was NULL.
func readLenEncString(data []byte) (string, int, bool) {
	if len(data) == 0 {
		return "", 0, false
	}
	if data[0] == nullValue {
		return "", 1, true
	}
	length, n := readLenEncInt(data)
	if n == 0 || int(length) > len(data)-n {
		return "", 0, false
	}
	return string(data[n : n+int(length)]), n + int(length), false
}

// columnDef holds column name and type from a ColumnDefinition41 packet
type columnDef struct {
	name     string
	fieldType byte
}

// parseColumnDef extracts column name and type from a ColumnDefinition41 packet payload
func parseColumnDef(payload []byte) columnDef {
	off := 0
	// Skip: catalog, schema, table, org_table (all lenenc strings)
	for i := 0; i < 4; i++ {
		_, n, _ := readLenEncString(payload[off:])
		if n == 0 {
			return columnDef{}
		}
		off += n
	}
	// name (lenenc string) — this is the column alias
	name, n, _ := readLenEncString(payload[off:])
	if n == 0 {
		return columnDef{}
	}
	off += n
	// Skip org_name
	_, n, _ = readLenEncString(payload[off:])
	off += n
	// fixed_length_fields marker (lenenc = 0x0C)
	_, n = readLenEncInt(payload[off:])
	off += n
	// character_set(2) + column_length(4)
	if off+6 > len(payload) {
		return columnDef{name: name}
	}
	off += 6
	// type (1 byte)
	if off >= len(payload) {
		return columnDef{name: name}
	}
	ft := payload[off]
	return columnDef{name: name, fieldType: ft}
}

// parseTextRowValues extracts column values from a text resultset row.
// Each value is either NULL (0xFB) or a length-encoded string.
func parseTextRowValues(payload []byte, numCols int) []interface{} {
	values := make([]interface{}, 0, numCols)
	off := 0
	for i := 0; i < numCols && off < len(payload); i++ {
		if payload[off] == nullValue {
			values = append(values, nil)
			off++
			continue
		}
		s, n, _ := readLenEncString(payload[off:])
		if n == 0 {
			break
		}
		values = append(values, s)
		off += n
	}
	return values
}

// parseBinaryRowValues extracts column values from a binary resultset row.
// Binary row format: 0x00 header + NULL bitmap + binary-encoded values.
func parseBinaryRowValues(payload []byte, columns []columnDef) []interface{} {
	numCols := len(columns)
	nullBitmapLen := (numCols + 7 + 2) / 8
	if len(payload) < 1+nullBitmapLen {
		return nil
	}

	nullBitmap := payload[1 : 1+nullBitmapLen]
	values := make([]interface{}, numCols)
	off := 1 + nullBitmapLen

	for i := 0; i < numCols; i++ {
		bytePos := (i + 2) / 8
		bitPos := uint((i + 2) % 8)
		if nullBitmap[bytePos]&(1<<bitPos) != 0 {
			values[i] = nil
			continue
		}

		switch columns[i].fieldType {
		case fieldTypeTiny:
			if off >= len(payload) {
				return values
			}
			values[i] = int64(int8(payload[off]))
			off++
		case fieldTypeShort:
			if off+2 > len(payload) {
				return values
			}
			values[i] = int64(int16(binary.LittleEndian.Uint16(payload[off:])))
			off += 2
		case fieldTypeLong, fieldTypeInt24:
			if off+4 > len(payload) {
				return values
			}
			values[i] = int64(int32(binary.LittleEndian.Uint32(payload[off:])))
			off += 4
		case fieldTypeLongLong:
			if off+8 > len(payload) {
				return values
			}
			values[i] = int64(binary.LittleEndian.Uint64(payload[off:]))
			off += 8
		case fieldTypeFloat:
			if off+4 > len(payload) {
				return values
			}
			bits := binary.LittleEndian.Uint32(payload[off:])
			values[i] = float64(math.Float32frombits(bits))
			off += 4
		case fieldTypeDouble:
			if off+8 > len(payload) {
				return values
			}
			bits := binary.LittleEndian.Uint64(payload[off:])
			values[i] = math.Float64frombits(bits)
			off += 8
		default:
			s, n, isNull := readLenEncString(payload[off:])
			if isNull {
				values[i] = nil
				off++
			} else if n == 0 {
				return values
			} else {
				values[i] = coerceValue(s, columns[i].fieldType)
				off += n
			}
		}
	}
	return values
}

// coerceValue converts a text-format MySQL value to a native Go type
func coerceValue(s string, ft byte) interface{} {
	switch ft {
	case fieldTypeTiny, fieldTypeShort, fieldTypeLong, fieldTypeLongLong, fieldTypeInt24:
		if v, err := strconv.ParseInt(s, 10, 64); err == nil {
			return v
		}
	case fieldTypeFloat, fieldTypeDouble, fieldTypeNewDecimal:
		if v, err := strconv.ParseFloat(s, 64); err == nil {
			return v
		}
	}
	return s
}

// extractQueryText extracts the SQL query from a COM_QUERY packet payload
func extractQueryText(payload []byte) string {
	if len(payload) < 2 {
		return ""
	}
	return string(payload[1:])
}

// extractStmtPrepareQuery extracts the SQL from a COM_STMT_PREPARE payload
func extractStmtPrepareQuery(payload []byte) string {
	if len(payload) < 2 {
		return ""
	}
	return string(payload[1:])
}

// extractStmtID extracts the 4-byte statement ID from COM_STMT_EXECUTE or COM_STMT_CLOSE payload
func extractStmtID(payload []byte) uint32 {
	if len(payload) < 5 {
		return 0
	}
	return binary.LittleEndian.Uint32(payload[1:5])
}

// extractPrepareOKStmtID extracts the statement ID from a COM_STMT_PREPARE_OK response
func extractPrepareOKStmtID(payload []byte) (stmtID uint32, numColumns uint16, numParams uint16) {
	if len(payload) < 10 {
		return 0, 0, 0
	}
	// status(1) + stmt_id(4) + num_columns(2) + num_params(2)
	stmtID = binary.LittleEndian.Uint32(payload[1:5])
	numColumns = binary.LittleEndian.Uint16(payload[5:7])
	numParams = binary.LittleEndian.Uint16(payload[7:9])
	return
}
