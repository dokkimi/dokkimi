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
	fieldTypeTimestamp  byte = 0x07
	fieldTypeDate       byte = 0x0a
	fieldTypeTime       byte = 0x0b
	fieldTypeDatetime   byte = 0x0c
	fieldTypeYear       byte = 0x0d
	fieldTypeNewDecimal byte = 0xf6
	fieldTypeVarString  byte = 0xfd

	columnFlagUnsigned uint16 = 0x0020
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

// serverMoreResultsExists is the status flag the server sets on a result
// that more results follow (several statements, or a CALL)
const serverMoreResultsExists = 0x0008

// okMoreResults reports whether an OK packet says more results follow:
// header, affected rows and last insert ID (length-encoded), status flags.
func okMoreResults(payload []byte) bool {
	pos := 1
	for i := 0; i < 2; i++ {
		_, n := readLenEncInt(payload[min(pos, len(payload)):])
		if n == 0 {
			return false
		}
		pos += n
	}
	return pos+2 <= len(payload) && binary.LittleEndian.Uint16(payload[pos:])&serverMoreResultsExists != 0
}

// eofMoreResults reports whether an EOF packet says more results follow:
// header, warnings, status flags.
func eofMoreResults(payload []byte) bool {
	return len(payload) >= 5 && binary.LittleEndian.Uint16(payload[3:])&serverMoreResultsExists != 0
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
	if n == 0 || length > uint64(len(data)-n) {
		return "", 0, false
	}
	return string(data[n : n+int(length)]), n + int(length), false
}

// columnDef holds column name, type, flags and decimals from a ColumnDefinition41 packet
type columnDef struct {
	name      string
	fieldType byte
	flags     uint16
	decimals  byte
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
	col := columnDef{name: name, fieldType: ft}
	// flags(2) + decimals(1)
	if off+4 <= len(payload) {
		col.flags = binary.LittleEndian.Uint16(payload[off+1:])
		col.decimals = payload[off+3]
	}
	return col
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

// parseBinaryRowValues extracts column values from a binary resultset row
// (the reply to COM_STMT_EXECUTE). Format: 0x00 header + NULL bitmap (offset 2)
// + the non-NULL values. Values come out the same as the text protocol's, so a
// query logs the same whether it was prepared or not.
func parseBinaryRowValues(payload []byte, columns []columnDef) []interface{} {
	numCols := len(columns)
	nullBitmapLen := (numCols + 7 + 2) / 8
	if len(payload) < 1+nullBitmapLen {
		return nil
	}

	nullBitmap := payload[1 : 1+nullBitmapLen]
	values := make([]interface{}, numCols)
	off := 1 + nullBitmapLen

	for i, col := range columns {
		bytePos := (i + 2) / 8
		bitPos := uint((i + 2) % 8)
		if nullBitmap[bytePos]&(1<<bitPos) != 0 {
			values[i] = nil
			continue
		}

		unsigned := col.flags&columnFlagUnsigned != 0
		fixed := func(size int) []byte {
			if off+size > len(payload) {
				return nil
			}
			b := payload[off : off+size]
			off += size
			return b
		}

		switch col.fieldType {
		case fieldTypeTiny:
			b := fixed(1)
			if b == nil {
				return values
			}
			if unsigned {
				values[i] = int64(b[0])
			} else {
				values[i] = int64(int8(b[0]))
			}
		case fieldTypeShort, fieldTypeYear:
			b := fixed(2)
			if b == nil {
				return values
			}
			v := binary.LittleEndian.Uint16(b)
			if unsigned || col.fieldType == fieldTypeYear {
				values[i] = int64(v)
			} else {
				values[i] = int64(int16(v))
			}
		case fieldTypeLong, fieldTypeInt24:
			b := fixed(4)
			if b == nil {
				return values
			}
			v := binary.LittleEndian.Uint32(b)
			if unsigned {
				values[i] = int64(v)
			} else {
				values[i] = int64(int32(v))
			}
		case fieldTypeLongLong:
			b := fixed(8)
			if b == nil {
				return values
			}
			v := binary.LittleEndian.Uint64(b)
			if unsigned && v > math.MaxInt64 {
				values[i] = strconv.FormatUint(v, 10) // as the text protocol gives it
			} else {
				values[i] = int64(v)
			}
		case fieldTypeFloat:
			b := fixed(4)
			if b == nil {
				return values
			}
			values[i] = float64(math.Float32frombits(binary.LittleEndian.Uint32(b)))
		case fieldTypeDouble:
			b := fixed(8)
			if b == nil {
				return values
			}
			values[i] = math.Float64frombits(binary.LittleEndian.Uint64(b))
		case fieldTypeDate, fieldTypeDatetime, fieldTypeTimestamp, fieldTypeTime:
			if off >= len(payload) {
				return values
			}
			n := int(payload[off])
			off++
			b := fixed(n)
			if b == nil {
				return values
			}
			if col.fieldType == fieldTypeTime {
				values[i] = formatBinaryTime(b, col.decimals)
			} else {
				values[i] = formatBinaryDatetime(b, col.fieldType == fieldTypeDate, col.decimals)
			}
		default:
			s, n, _ := readLenEncString(payload[off:])
			if n == 0 {
				return values
			}
			values[i] = coerceValue(s, col.fieldType)
			off += n
		}
	}
	return values
}

// formatFraction formats microseconds with the column's number of decimals,
// as the text protocol does (DATETIME(3) gives ".789"). Without a fixed number
// (0x1f, e.g. for expressions) it shows all six digits when there are any.
func formatFraction(micro uint32, decimals byte) string {
	if decimals == 0x1f {
		if micro == 0 {
			return ""
		}
		decimals = 6
	}
	if decimals == 0 || decimals > 6 {
		return ""
	}
	return fmt.Sprintf(".%0*d", int(decimals), micro/uint32(math.Pow10(6-int(decimals))))
}

// formatBinaryDatetime formats a binary DATE, DATETIME or TIMESTAMP value
// (length 0, 4, 7 or 11) as "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS[.fff]".
func formatBinaryDatetime(b []byte, dateOnly bool, decimals byte) string {
	var year uint16
	var month, day, hour, minute, second byte
	var micro uint32
	if len(b) >= 4 {
		year, month, day = binary.LittleEndian.Uint16(b), b[2], b[3]
	}
	if len(b) >= 7 {
		hour, minute, second = b[4], b[5], b[6]
	}
	if len(b) >= 11 {
		micro = binary.LittleEndian.Uint32(b[7:])
	}
	date := fmt.Sprintf("%04d-%02d-%02d", year, month, day)
	if dateOnly {
		return date
	}
	return fmt.Sprintf("%s %02d:%02d:%02d%s", date, hour, minute, second, formatFraction(micro, decimals))
}

// formatBinaryTime formats a binary TIME value (length 0, 8 or 12) as
// "[-]HH:MM:SS[.fff]", with days folded into the hours as the text protocol does.
func formatBinaryTime(b []byte, decimals byte) string {
	sign := ""
	var hours int
	var minute, second byte
	var micro uint32
	if len(b) >= 8 {
		if b[0] == 1 {
			sign = "-"
		}
		hours = int(binary.LittleEndian.Uint32(b[1:]))*24 + int(b[5])
		minute, second = b[6], b[7]
	}
	if len(b) >= 12 {
		micro = binary.LittleEndian.Uint32(b[8:])
	}
	return fmt.Sprintf("%s%02d:%02d:%02d%s", sign, hours, minute, second, formatFraction(micro, decimals))
}

// coerceValue converts a text-format MySQL value to a native Go type
func coerceValue(s string, ft byte) interface{} {
	switch ft {
	case fieldTypeTiny, fieldTypeShort, fieldTypeLong, fieldTypeLongLong, fieldTypeInt24, fieldTypeYear:
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
