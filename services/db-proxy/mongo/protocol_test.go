package main

import (
	"bytes"
	"encoding/binary"
	"math"
	"testing"
)

// buildHeader creates a MongoDB wire protocol header.
func buildHeader(length, requestID, responseTo, opCode int32) []byte {
	buf := make([]byte, 16)
	binary.LittleEndian.PutUint32(buf[0:4], uint32(length))
	binary.LittleEndian.PutUint32(buf[4:8], uint32(requestID))
	binary.LittleEndian.PutUint32(buf[8:12], uint32(responseTo))
	binary.LittleEndian.PutUint32(buf[12:16], uint32(opCode))
	return buf
}

// buildBSONString builds a BSON-encoded string value (length-prefixed + null terminator).
func buildBSONString(s string) []byte {
	b := make([]byte, 4+len(s)+1)
	binary.LittleEndian.PutUint32(b[0:4], uint32(len(s)+1))
	copy(b[4:], s)
	b[4+len(s)] = 0
	return b
}

// buildBSONDoc builds a minimal BSON document with a single string key-value pair.
func buildBSONDoc(key, value string) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0, 0, 0, 0}) // placeholder for doc length

	// string element: type 0x02 + cstring key + string value
	buf.WriteByte(bsonString)
	buf.WriteString(key)
	buf.WriteByte(0)
	buf.Write(buildBSONString(value))

	buf.WriteByte(0) // document terminator

	doc := buf.Bytes()
	binary.LittleEndian.PutUint32(doc[0:4], uint32(len(doc)))
	return doc
}

// buildOPMsg builds a complete OP_MSG with a Kind 0 body section.
func buildOPMsg(requestID, responseTo int32, flags uint32, bsonDoc []byte) []byte {
	// header(16) + flagBits(4) + kind(1) + bsonDoc
	msgLen := int32(16 + 4 + 1 + len(bsonDoc))
	var buf bytes.Buffer
	buf.Write(buildHeader(msgLen, requestID, responseTo, opMsg))

	flagBytes := make([]byte, 4)
	binary.LittleEndian.PutUint32(flagBytes, flags)
	buf.Write(flagBytes)

	buf.WriteByte(0) // kind 0
	buf.Write(bsonDoc)

	return buf.Bytes()
}

func TestReadMessage(t *testing.T) {
	doc := buildBSONDoc("find", "orders")
	raw := buildOPMsg(42, 0, 0, doc)

	r := bytes.NewReader(raw)
	msg, err := readMessage(r)
	if err != nil {
		t.Fatalf("readMessage failed: %v", err)
	}

	if msg.requestID != 42 {
		t.Errorf("requestID = %d, want 42", msg.requestID)
	}
	if msg.opCode != opMsg {
		t.Errorf("opCode = %d, want %d", msg.opCode, opMsg)
	}
	if msg.moreToCome {
		t.Error("moreToCome should be false")
	}
}

func TestReadMessageMoreToCome(t *testing.T) {
	doc := buildBSONDoc("find", "orders")
	raw := buildOPMsg(1, 0, flagMoreToCome, doc)

	msg, err := readMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("readMessage failed: %v", err)
	}
	if !msg.moreToCome {
		t.Error("moreToCome should be true")
	}
}

func TestReadMessageChecksumPresent(t *testing.T) {
	doc := buildBSONDoc("find", "orders")
	raw := buildOPMsg(1, 0, flagChecksumPresent, doc)
	// append 4 bytes for checksum
	raw = append(raw, 0, 0, 0, 0)
	binary.LittleEndian.PutUint32(raw[0:4], uint32(len(raw)))

	msg, err := readMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("readMessage failed: %v", err)
	}
	if msg.flags&flagChecksumPresent == 0 {
		t.Error("checksumPresent flag should be set")
	}
}

func TestReadMessageInvalidLength(t *testing.T) {
	raw := make([]byte, 16)
	binary.LittleEndian.PutUint32(raw[0:4], 3) // too short

	_, err := readMessage(bytes.NewReader(raw))
	if err == nil {
		t.Error("expected error for invalid message length")
	}
}

func TestReadMessageTruncated(t *testing.T) {
	raw := make([]byte, 16)
	binary.LittleEndian.PutUint32(raw[0:4], 100) // claims 100 bytes but only 16 available
	binary.LittleEndian.PutUint32(raw[12:16], uint32(opMsg))

	_, err := readMessage(bytes.NewReader(raw))
	if err == nil {
		t.Error("expected error for truncated message")
	}
}

func TestExtractCommandInfo(t *testing.T) {
	tests := []struct {
		name     string
		key      string
		value    string
		wantCmd  string
		wantColl string
	}{
		{"find", "find", "orders", "find", "orders"},
		{"insert", "insert", "users", "insert", "users"},
		{"update", "update", "products", "update", "products"},
		{"delete", "delete", "sessions", "delete", "sessions"},
		{"aggregate", "aggregate", "events", "aggregate", "events"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doc := buildBSONDoc(tt.key, tt.value)
			msg := &mongoMessage{
				raw:    buildOPMsg(1, 0, 0, doc),
				opCode: opMsg,
			}
			msg.raw = buildOPMsg(1, 0, 0, doc)

			ci := extractCommandInfo(msg)
			if ci.commandName != tt.wantCmd {
				t.Errorf("commandName = %q, want %q", ci.commandName, tt.wantCmd)
			}
			if ci.collectionName != tt.wantColl {
				t.Errorf("collectionName = %q, want %q", ci.collectionName, tt.wantColl)
			}
		})
	}
}

func TestExtractCommandInfoNonOpMsg(t *testing.T) {
	msg := &mongoMessage{opCode: opQuery}
	ci := extractCommandInfo(msg)
	if ci.commandName != "" {
		t.Errorf("expected empty commandName for non-OP_MSG, got %q", ci.commandName)
	}
}

func TestExtractResponseInfo(t *testing.T) {
	// Build a BSON doc with ok:1, n:5, errmsg:"test error"
	var buf bytes.Buffer
	buf.Write([]byte{0, 0, 0, 0}) // doc length placeholder

	// ok: 1.0 (double)
	buf.WriteByte(bsonDouble)
	buf.WriteString("ok")
	buf.WriteByte(0)
	okBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(okBytes, math.Float64bits(1.0))
	buf.Write(okBytes)

	// n: 5 (int32)
	buf.WriteByte(bsonInt32)
	buf.WriteString("n")
	buf.WriteByte(0)
	nBytes := make([]byte, 4)
	binary.LittleEndian.PutUint32(nBytes, 5)
	buf.Write(nBytes)

	// errmsg: "test error" (string)
	buf.WriteByte(bsonString)
	buf.WriteString("errmsg")
	buf.WriteByte(0)
	buf.Write(buildBSONString("test error"))

	buf.WriteByte(0) // doc terminator

	doc := buf.Bytes()
	binary.LittleEndian.PutUint32(doc[0:4], uint32(len(doc)))

	raw := buildOPMsg(1, 42, 0, doc)
	msg := &mongoMessage{
		raw:        raw,
		opCode:     opMsg,
		responseTo: 42,
	}

	ri := extractResponseInfo(msg, "")
	if !ri.hasOk || ri.ok != 1 {
		t.Errorf("ok = %v (hasOk=%v), want 1", ri.ok, ri.hasOk)
	}
	if ri.n != 5 {
		t.Errorf("n = %d, want 5", ri.n)
	}
	if ri.errmsg != "test error" {
		t.Errorf("errmsg = %q, want %q", ri.errmsg, "test error")
	}
}

func TestIsDriverInternalCommand(t *testing.T) {
	internals := []string{"hello", "isMaster", "ismaster", "saslStart", "saslContinue", "ping", "endSessions"}
	for _, cmd := range internals {
		if !isDriverInternalCommand(cmd) {
			t.Errorf("%q should be internal", cmd)
		}
	}

	userCmds := []string{"find", "insert", "update", "delete", "aggregate", "count"}
	for _, cmd := range userCmds {
		if isDriverInternalCommand(cmd) {
			t.Errorf("%q should NOT be internal", cmd)
		}
	}
}

func TestStripCompressionFromHello(t *testing.T) {
	// Build a hello response with "helloOk" and "compression" fields
	var buf bytes.Buffer
	buf.Write([]byte{0, 0, 0, 0}) // doc length placeholder

	// helloOk: true (bool)
	buf.WriteByte(bsonBool)
	buf.WriteString("helloOk")
	buf.WriteByte(0)
	buf.WriteByte(1)

	// compression: ["snappy"] (array with one string)
	buf.WriteByte(bsonArray)
	buf.WriteString("compression")
	buf.WriteByte(0)
	// Build a small BSON array: { "0": "snappy" }
	var arrBuf bytes.Buffer
	arrBuf.Write([]byte{0, 0, 0, 0}) // array doc length
	arrBuf.WriteByte(bsonString)
	arrBuf.WriteString("0")
	arrBuf.WriteByte(0)
	arrBuf.Write(buildBSONString("snappy"))
	arrBuf.WriteByte(0) // terminator
	arrDoc := arrBuf.Bytes()
	binary.LittleEndian.PutUint32(arrDoc[0:4], uint32(len(arrDoc)))
	buf.Write(arrDoc)

	// maxWireVersion: 17 (int32)
	buf.WriteByte(bsonInt32)
	buf.WriteString("maxWireVersion")
	buf.WriteByte(0)
	mwv := make([]byte, 4)
	binary.LittleEndian.PutUint32(mwv, 17)
	buf.Write(mwv)

	buf.WriteByte(0) // doc terminator

	doc := buf.Bytes()
	binary.LittleEndian.PutUint32(doc[0:4], uint32(len(doc)))

	raw := buildOPMsg(1, 1, 0, doc)

	stripped := stripCompressionFromHello(raw)

	// The stripped message should be shorter (compression field removed)
	if len(stripped) >= len(raw) {
		t.Errorf("stripped message should be shorter: got %d, original %d", len(stripped), len(raw))
	}

	// Parse the stripped message and verify compression field is gone
	msg, err := readMessage(bytes.NewReader(stripped))
	if err != nil {
		t.Fatalf("failed to read stripped message: %v", err)
	}

	// Extract all field names from the BSON doc
	body := msg.raw[headerSize:]
	bsonDoc := body[5:] // skip flags(4) + kind(1)
	docLen := int(binary.LittleEndian.Uint32(bsonDoc[0:4]))
	pos := 4
	for pos < docLen-1 && pos < len(bsonDoc) {
		elemType := bsonDoc[pos]
		pos++
		fieldName, newPos := readCString(bsonDoc, pos, docLen)
		if fieldName == "" {
			break
		}
		pos = newPos
		if fieldName == "compression" {
			t.Error("compression field should have been stripped")
		}
		pos = skipBSONValue(elemType, bsonDoc, pos, docLen)
		if pos < 0 {
			break
		}
	}
}

func TestExtractCommandInfoNonOpMsgOpcodes(t *testing.T) {
	// OP_QUERY, OP_REPLY, OP_COMPRESSED should all return empty commandInfo
	for _, code := range []int32{opQuery, opReply, opCompressed} {
		raw := make([]byte, 20)
		binary.LittleEndian.PutUint32(raw[0:4], 20)
		binary.LittleEndian.PutUint32(raw[12:16], uint32(code))
		// pad body
		msg := &mongoMessage{raw: raw, opCode: code}
		ci := extractCommandInfo(msg)
		if ci.commandName != "" {
			t.Errorf("opCode %d: expected empty commandName, got %q", code, ci.commandName)
		}
	}
}

func TestExtractResponseInfoErrorResponse(t *testing.T) {
	// Build a response doc with ok:0 and errmsg
	var buf bytes.Buffer
	buf.Write([]byte{0, 0, 0, 0})

	// ok: 0.0 (double)
	buf.WriteByte(bsonDouble)
	buf.WriteString("ok")
	buf.WriteByte(0)
	okBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(okBytes, math.Float64bits(0.0))
	buf.Write(okBytes)

	// errmsg: "ns not found"
	buf.WriteByte(bsonString)
	buf.WriteString("errmsg")
	buf.WriteByte(0)
	buf.Write(buildBSONString("ns not found"))

	buf.WriteByte(0)

	doc := buf.Bytes()
	binary.LittleEndian.PutUint32(doc[0:4], uint32(len(doc)))

	raw := buildOPMsg(1, 42, 0, doc)
	msg := &mongoMessage{raw: raw, opCode: opMsg, responseTo: 42}

	ri := extractResponseInfo(msg, "")
	if !ri.hasOk || ri.ok != 0 {
		t.Errorf("ok = %v (hasOk=%v), want 0", ri.ok, ri.hasOk)
	}
	if ri.errmsg != "ns not found" {
		t.Errorf("errmsg = %q, want %q", ri.errmsg, "ns not found")
	}
}

func TestExtractResponseInfoOkAsInt32(t *testing.T) {
	var buf bytes.Buffer
	buf.Write([]byte{0, 0, 0, 0})

	// ok: 1 (int32)
	buf.WriteByte(bsonInt32)
	buf.WriteString("ok")
	buf.WriteByte(0)
	okBytes := make([]byte, 4)
	binary.LittleEndian.PutUint32(okBytes, 1)
	buf.Write(okBytes)

	buf.WriteByte(0)
	doc := buf.Bytes()
	binary.LittleEndian.PutUint32(doc[0:4], uint32(len(doc)))

	raw := buildOPMsg(1, 1, 0, doc)
	msg := &mongoMessage{raw: raw, opCode: opMsg, responseTo: 1}

	ri := extractResponseInfo(msg, "")
	if !ri.hasOk || ri.ok != 1 {
		t.Errorf("ok = %v (hasOk=%v), want 1 as int32", ri.ok, ri.hasOk)
	}
}

func TestExtractResponseInfoMultipleFields(t *testing.T) {
	// Build: { ok: 1.0, n: 3, nModified: 2 (should be skipped), errmsg: "" (absent) }
	var buf bytes.Buffer
	buf.Write([]byte{0, 0, 0, 0})

	// ok: 1.0
	buf.WriteByte(bsonDouble)
	buf.WriteString("ok")
	buf.WriteByte(0)
	okBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(okBytes, math.Float64bits(1.0))
	buf.Write(okBytes)

	// n: 3 (int64)
	buf.WriteByte(bsonInt64)
	buf.WriteString("n")
	buf.WriteByte(0)
	nBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(nBytes, 3)
	buf.Write(nBytes)

	// nModified: 2 (int32) — not a field we extract
	buf.WriteByte(bsonInt32)
	buf.WriteString("nModified")
	buf.WriteByte(0)
	nmBytes := make([]byte, 4)
	binary.LittleEndian.PutUint32(nmBytes, 2)
	buf.Write(nmBytes)

	buf.WriteByte(0)
	doc := buf.Bytes()
	binary.LittleEndian.PutUint32(doc[0:4], uint32(len(doc)))

	raw := buildOPMsg(1, 1, 0, doc)
	msg := &mongoMessage{raw: raw, opCode: opMsg, responseTo: 1}

	ri := extractResponseInfo(msg, "")
	if ri.ok != 1 {
		t.Errorf("ok = %v, want 1", ri.ok)
	}
	if ri.n != 3 {
		t.Errorf("n = %d, want 3", ri.n)
	}
	if ri.errmsg != "" {
		t.Errorf("errmsg = %q, want empty", ri.errmsg)
	}
}

func TestExtractCommandInfoEmptyDoc(t *testing.T) {
	// Minimal empty BSON document: { } = 5 bytes (length=5, terminator=0x00)
	doc := []byte{5, 0, 0, 0, 0}
	raw := buildOPMsg(1, 0, 0, doc)
	msg := &mongoMessage{raw: raw, opCode: opMsg}
	ci := extractCommandInfo(msg)
	if ci.commandName != "" {
		t.Errorf("expected empty commandName for empty doc, got %q", ci.commandName)
	}
}

func TestSkipBSONValueTypes(t *testing.T) {
	// Verify skipBSONValue correctly advances past each type
	tests := []struct {
		name     string
		elemType byte
		data     []byte
		wantSkip int
	}{
		{"double", bsonDouble, make([]byte, 8), 8},
		{"bool", bsonBool, []byte{1}, 1},
		{"int32", bsonInt32, make([]byte, 4), 4},
		{"int64", bsonInt64, make([]byte, 8), 8},
		{"objectId", 0x07, make([]byte, 12), 12},
		{"datetime", 0x09, make([]byte, 8), 8},
		{"timestamp", 0x11, make([]byte, 8), 8},
		{"decimal128", 0x13, make([]byte, 16), 16},
		{"null", 0x0A, []byte{}, 0},
		{"minKey", 0xFF, []byte{}, 0},
		{"maxKey", 0x7F, []byte{}, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := skipBSONValue(tt.elemType, tt.data, 0, len(tt.data)+100)
			if got != tt.wantSkip {
				t.Errorf("skipBSONValue(%s) = %d, want %d", tt.name, got, tt.wantSkip)
			}
		})
	}
}

func TestSkipBSONString(t *testing.T) {
	// BSON string: 4-byte length (includes null terminator) + string + null
	s := buildBSONString("hello")
	got := skipBSONValue(bsonString, s, 0, len(s)+100)
	want := len(s)
	if got != want {
		t.Errorf("skipBSONValue(string) = %d, want %d", got, want)
	}
}

func TestSkipBSONSubDocument(t *testing.T) {
	doc := buildBSONDoc("key", "value")
	got := skipBSONValue(bsonDocument, doc, 0, len(doc)+100)
	if got != len(doc) {
		t.Errorf("skipBSONValue(document) = %d, want %d", got, len(doc))
	}
}

func TestReadMessageMultipleSequential(t *testing.T) {
	// Two messages back-to-back in the same reader
	doc1 := buildBSONDoc("find", "orders")
	doc2 := buildBSONDoc("insert", "users")
	raw1 := buildOPMsg(1, 0, 0, doc1)
	raw2 := buildOPMsg(2, 0, 0, doc2)

	combined := append(raw1, raw2...)
	r := bytes.NewReader(combined)

	msg1, err := readMessage(r)
	if err != nil {
		t.Fatalf("first readMessage failed: %v", err)
	}
	if msg1.requestID != 1 {
		t.Errorf("first msg requestID = %d, want 1", msg1.requestID)
	}

	msg2, err := readMessage(r)
	if err != nil {
		t.Fatalf("second readMessage failed: %v", err)
	}
	if msg2.requestID != 2 {
		t.Errorf("second msg requestID = %d, want 2", msg2.requestID)
	}

	ci1 := extractCommandInfo(msg1)
	ci2 := extractCommandInfo(msg2)
	if ci1.commandName != "find" || ci1.collectionName != "orders" {
		t.Errorf("first command = %q %q, want find orders", ci1.commandName, ci1.collectionName)
	}
	if ci2.commandName != "insert" || ci2.collectionName != "users" {
		t.Errorf("second command = %q %q, want insert users", ci2.commandName, ci2.collectionName)
	}
}

func TestReconstructQueryFind(t *testing.T) {
	// Build a BSON doc like what the Go driver sends for:
	//   {"operation":"find","collection":"orders","filter":{}}
	var buf bytes.Buffer
	buf.Write([]byte{0, 0, 0, 0}) // doc length placeholder

	// find: "orders" (the command key)
	buf.WriteByte(bsonString)
	buf.WriteString("find")
	buf.WriteByte(0)
	buf.Write(buildBSONString("orders"))

	// filter: {} (empty sub-document)
	buf.WriteByte(bsonDocument)
	buf.WriteString("filter")
	buf.WriteByte(0)
	emptyDoc := []byte{5, 0, 0, 0, 0} // empty BSON document
	buf.Write(emptyDoc)

	// $db: "dokkimi" (driver-internal, should be skipped)
	buf.WriteByte(bsonString)
	buf.WriteString("$db")
	buf.WriteByte(0)
	buf.Write(buildBSONString("dokkimi"))

	buf.WriteByte(0) // doc terminator
	doc := buf.Bytes()
	binary.LittleEndian.PutUint32(doc[0:4], uint32(len(doc)))

	raw := buildOPMsg(1, 0, 0, doc)
	msg := &mongoMessage{raw: raw, opCode: opMsg}
	ci := extractCommandInfo(msg)

	got := reconstructQuery(ci)
	want := `{"operation":"find","collection":"orders","filter":{}}`
	if got != want {
		t.Errorf("reconstructQuery =\n  %s\nwant:\n  %s", got, want)
	}
}

func TestReconstructQueryInsertOne(t *testing.T) {
	// Build: insert "users" with a document containing a key
	var buf bytes.Buffer
	buf.Write([]byte{0, 0, 0, 0})

	buf.WriteByte(bsonString)
	buf.WriteString("insert")
	buf.WriteByte(0)
	buf.Write(buildBSONString("users"))

	// documents: [{"name":"alice"}] — this is what the driver sends for insertOne
	buf.WriteByte(bsonArray)
	buf.WriteString("documents")
	buf.WriteByte(0)
	innerDoc := buildBSONDoc("name", "alice")
	var arrBuf bytes.Buffer
	arrBuf.Write([]byte{0, 0, 0, 0})
	arrBuf.WriteByte(bsonDocument)
	arrBuf.WriteString("0")
	arrBuf.WriteByte(0)
	arrBuf.Write(innerDoc)
	arrBuf.WriteByte(0)
	arr := arrBuf.Bytes()
	binary.LittleEndian.PutUint32(arr[0:4], uint32(len(arr)))
	buf.Write(arr)

	// $db
	buf.WriteByte(bsonString)
	buf.WriteString("$db")
	buf.WriteByte(0)
	buf.Write(buildBSONString("dokkimi"))

	buf.WriteByte(0)
	doc := buf.Bytes()
	binary.LittleEndian.PutUint32(doc[0:4], uint32(len(doc)))

	raw := buildOPMsg(1, 0, 0, doc)
	msg := &mongoMessage{raw: raw, opCode: opMsg}
	ci := extractCommandInfo(msg)

	got := reconstructQuery(ci)
	want := `{"operation":"insertOne","collection":"users","document":{"name":"alice"}}`
	if got != want {
		t.Errorf("reconstructQuery =\n  %s\nwant:\n  %s", got, want)
	}
}

func TestReconstructQueryNoBody(t *testing.T) {
	ci := commandInfo{commandName: "find", collectionName: "orders"}
	got := reconstructQuery(ci)
	if got != "find orders" {
		t.Errorf("reconstructQuery with no rawBSONBody = %q, want %q", got, "find orders")
	}
}

func TestExtractCommandInfoInt32Value(t *testing.T) {
	// Command where the first value is int32 (e.g. "listCollections": 1)
	var buf bytes.Buffer
	buf.Write([]byte{0, 0, 0, 0})

	buf.WriteByte(bsonInt32)
	buf.WriteString("listCollections")
	buf.WriteByte(0)
	v := make([]byte, 4)
	binary.LittleEndian.PutUint32(v, 1)
	buf.Write(v)

	buf.WriteByte(0)
	doc := buf.Bytes()
	binary.LittleEndian.PutUint32(doc[0:4], uint32(len(doc)))

	raw := buildOPMsg(1, 0, 0, doc)
	msg := &mongoMessage{raw: raw, opCode: opMsg}
	ci := extractCommandInfo(msg)
	if ci.commandName != "listCollections" {
		t.Errorf("commandName = %q, want listCollections", ci.commandName)
	}
	if ci.collectionName != "" {
		t.Errorf("collectionName = %q, want empty (value is int32, not string)", ci.collectionName)
	}
}
