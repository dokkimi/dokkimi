package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"

	"go.mongodb.org/mongo-driver/v2/bson"
)

const (
	opReply      int32 = 1
	opQuery      int32 = 2004
	opMsg        int32 = 2013
	opCompressed int32 = 2012

	headerSize = 16

	flagChecksumPresent uint32 = 1 << 0
	flagMoreToCome      uint32 = 1 << 1
)

// BSON type tags we care about
const (
	bsonDouble   byte = 0x01
	bsonString   byte = 0x02
	bsonDocument byte = 0x03
	bsonArray    byte = 0x04
	bsonBool     byte = 0x08
	bsonInt32    byte = 0x10
	bsonInt64    byte = 0x12
)

type mongoMessage struct {
	raw        []byte
	length     int32
	requestID  int32
	responseTo int32
	opCode     int32
	flags      uint32
	moreToCome bool
}

type commandInfo struct {
	commandName    string
	collectionName string
	rawBSONBody    []byte // Kind 0 BSON document, for reconstructing the JSON query
	// kind1Sections maps identifier (e.g. "documents", "updates", "deletes") to
	// the raw BSON documents from Kind 1 document sequence sections.
	kind1Sections map[string][]bson.D
}

type responseInfo struct {
	ok       float64
	n        int64
	errmsg   string
	hasOk    bool
	data     []map[string]interface{}
	cursorID int64
}

// readMessage reads a complete MongoDB wire protocol message from the reader.
func readMessage(r io.Reader) (*mongoMessage, error) {
	var header [headerSize]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}

	length := int32(binary.LittleEndian.Uint32(header[0:4]))
	if length < headerSize || length > 48*1024*1024 {
		return nil, fmt.Errorf("invalid message length: %d", length)
	}

	raw := make([]byte, length)
	copy(raw[:headerSize], header[:])
	if _, err := io.ReadFull(r, raw[headerSize:]); err != nil {
		return nil, err
	}

	msg := &mongoMessage{
		raw:        raw,
		length:     length,
		requestID:  int32(binary.LittleEndian.Uint32(raw[4:8])),
		responseTo: int32(binary.LittleEndian.Uint32(raw[8:12])),
		opCode:     int32(binary.LittleEndian.Uint32(raw[12:16])),
	}

	if msg.opCode == opMsg && len(raw) > headerSize+4 {
		msg.flags = binary.LittleEndian.Uint32(raw[headerSize : headerSize+4])
		msg.moreToCome = msg.flags&flagMoreToCome != 0
	}

	return msg, nil
}

// extractCommandInfo extracts the command name, collection, and Kind 1
// document sequences from an OP_MSG.
func extractCommandInfo(msg *mongoMessage) commandInfo {
	if msg.opCode != opMsg {
		return commandInfo{}
	}

	body := msg.raw[headerSize:]
	if len(body) < 5 {
		return commandInfo{}
	}

	flags := binary.LittleEndian.Uint32(body[0:4])
	hasChecksum := flags&flagChecksumPresent != 0

	// Determine the end of sections (exclude optional 4-byte checksum)
	endPos := len(body)
	if hasChecksum && endPos >= 4 {
		endPos -= 4
	}

	body = body[4:] // skip flagBits
	endPos -= 4     // adjust for the flagBits we skipped

	// find Kind 0 section
	if len(body) < 1 || body[0] != 0 {
		return commandInfo{}
	}
	// skip kind byte
	bsonDoc := body[1:]

	info := extractFirstKeyValue(bsonDoc)
	if info.commandName == "" {
		return info
	}

	docLen := int(binary.LittleEndian.Uint32(bsonDoc[0:4]))
	if docLen >= 5 && docLen <= len(bsonDoc) {
		info.rawBSONBody = bsonDoc[:docLen]
	}

	// Parse Kind 1 sections that follow the Kind 0 body
	pos := 1 + docLen // 1 byte kind + BSON doc
	for pos < endPos {
		if pos >= len(body) {
			break
		}
		kind := body[pos]
		pos++

		if kind == 1 {
			// Kind 1: Document Sequence
			// Format: int32 size, cstring identifier, then BSON documents
			if pos+4 > len(body) {
				break
			}
			sectionSize := int(binary.LittleEndian.Uint32(body[pos : pos+4]))
			if sectionSize < 4 || pos+sectionSize > len(body) {
				break
			}
			sectionEnd := pos + sectionSize
			pos += 4 // skip size

			// Read identifier (cstring)
			identifier, newPos := readCString(body, pos, sectionEnd)
			if identifier == "" {
				break
			}
			pos = newPos

			// Read BSON documents until section end
			var docs []bson.D
			for pos < sectionEnd {
				if pos+4 > len(body) {
					break
				}
				subDocLen := int(binary.LittleEndian.Uint32(body[pos : pos+4]))
				if subDocLen < 5 || pos+subDocLen > sectionEnd {
					break
				}
				var d bson.D
				if err := bson.Unmarshal(body[pos:pos+subDocLen], &d); err == nil {
					docs = append(docs, d)
				}
				pos += subDocLen
			}

			if len(docs) > 0 {
				if info.kind1Sections == nil {
					info.kind1Sections = make(map[string][]bson.D)
				}
				info.kind1Sections[identifier] = docs
			}

			pos = sectionEnd
		} else {
			// Unknown kind, stop parsing
			break
		}
	}

	return info
}

// extractResponseInfo extracts ok, n, errmsg, and result data from an OP_MSG response.
func extractResponseInfo(msg *mongoMessage, cmdName string) responseInfo {
	if msg.opCode != opMsg {
		return responseInfo{}
	}

	body := msg.raw[headerSize:]
	if len(body) < 5 {
		return responseInfo{}
	}
	body = body[4:] // skip flagBits

	if len(body) < 1 || body[0] != 0 {
		return responseInfo{}
	}
	bsonDoc := body[1:]

	info := extractResponseFields(bsonDoc)

	docLen := int(binary.LittleEndian.Uint32(bsonDoc[0:4]))
	if docLen >= 5 && docLen <= len(bsonDoc) {
		if cmdName == "find" || cmdName == "getMore" {
			batch, cursorID := extractCursorBatch(bsonDoc[:docLen])
			info.data = batch
			info.cursorID = cursorID
		} else {
			info.data = extractResponseData(bsonDoc[:docLen], cmdName)
		}
	}

	return info
}

// extractCursorBatch extracts the batch of documents and cursor ID from a cursor
// response document. Works for both find (firstBatch) and getMore (nextBatch).
func extractCursorBatch(rawDoc []byte) ([]map[string]interface{}, int64) {
	var doc bson.D
	if err := bson.Unmarshal(rawDoc, &doc); err != nil {
		return nil, 0
	}

	for _, elem := range doc {
		if elem.Key == "cursor" {
			cursorDoc, ok := elem.Value.(bson.D)
			if !ok {
				return nil, 0
			}
			var results []map[string]interface{}
			var cursorID int64
			for _, ce := range cursorDoc {
				if ce.Key == "firstBatch" || ce.Key == "nextBatch" {
					arr, ok := ce.Value.(bson.A)
					if !ok {
						continue
					}
					results = make([]map[string]interface{}, 0, len(arr))
					for _, item := range arr {
						if d, ok := item.(bson.D); ok {
							results = append(results, bsonDToMap(d))
						}
					}
				}
				if ce.Key == "id" {
					cursorID = bsonNumToInt64(ce.Value)
				}
			}
			return results, cursorID
		}
	}
	return nil, 0
}

// extractResponseData parses the response BSON to produce result data matching
// the format that the test-agent returns to the validator.
func extractResponseData(rawDoc []byte, cmdName string) []map[string]interface{} {
	var doc bson.D
	if err := bson.Unmarshal(rawDoc, &doc); err != nil {
		return nil
	}

	switch cmdName {
	case "find", "getMore":
		batch, _ := extractCursorBatch(rawDoc)
		if batch != nil {
			return batch
		}
		return []map[string]interface{}{}

	case "insert":
		row := map[string]interface{}{"acknowledged": true}
		for _, elem := range doc {
			if elem.Key == "n" {
				row["n"] = bsonNumToInt64(elem.Value)
			}
		}
		return []map[string]interface{}{row}

	case "update":
		row := map[string]interface{}{"acknowledged": true}
		for _, elem := range doc {
			switch elem.Key {
			case "n":
				row["matchedCount"] = bsonNumToInt64(elem.Value)
			case "nModified":
				row["modifiedCount"] = bsonNumToInt64(elem.Value)
			}
		}
		return []map[string]interface{}{row}

	case "delete":
		row := map[string]interface{}{"acknowledged": true}
		for _, elem := range doc {
			if elem.Key == "n" {
				row["deletedCount"] = bsonNumToInt64(elem.Value)
			}
		}
		return []map[string]interface{}{row}

	default:
		return nil
	}
}

// bsonDToMap converts a bson.D to map[string]interface{}, recursively converting
// sub-documents and arrays. Strips the _id field since test assertions don't reference it.
func bsonDToMap(d bson.D) map[string]interface{} {
	m := make(map[string]interface{}, len(d))
	for _, elem := range d {
		if elem.Key == "_id" {
			continue
		}
		m[elem.Key] = bsonValueToGo(elem.Value)
	}
	return m
}

func bsonValueToGo(v interface{}) interface{} {
	switch val := v.(type) {
	case bson.D:
		return bsonDToMap(val)
	case bson.A:
		arr := make([]interface{}, len(val))
		for i, item := range val {
			arr[i] = bsonValueToGo(item)
		}
		return arr
	case int32:
		return int64(val)
	default:
		return v
	}
}

func bsonNumToInt64(v interface{}) int64 {
	switch val := v.(type) {
	case int32:
		return int64(val)
	case int64:
		return val
	case float64:
		return int64(val)
	default:
		return 0
	}
}

// extractFirstKeyValue reads the first key-value pair from a BSON document
// to determine the command name and collection.
func extractFirstKeyValue(doc []byte) commandInfo {
	if len(doc) < 5 {
		return commandInfo{}
	}
	docLen := int(binary.LittleEndian.Uint32(doc[0:4]))
	if docLen < 5 || docLen > len(doc) {
		return commandInfo{}
	}

	pos := 4 // skip document length
	if pos >= docLen-1 {
		return commandInfo{}
	}

	elemType := doc[pos]
	pos++

	name, newPos := readCString(doc, pos, docLen)
	if name == "" {
		return commandInfo{}
	}
	pos = newPos

	info := commandInfo{commandName: name}

	if elemType == bsonString {
		s, _ := readBSONString(doc, pos, docLen)
		info.collectionName = s
	}

	return info
}

// extractResponseFields extracts ok, n, and errmsg from a BSON document.
func extractResponseFields(doc []byte) responseInfo {
	if len(doc) < 5 {
		return responseInfo{}
	}
	docLen := int(binary.LittleEndian.Uint32(doc[0:4]))
	if docLen < 5 || docLen > len(doc) {
		return responseInfo{}
	}

	var info responseInfo
	pos := 4

	for pos < docLen-1 {
		if pos >= len(doc) {
			break
		}
		elemType := doc[pos]
		pos++

		fieldName, newPos := readCString(doc, pos, docLen)
		if fieldName == "" {
			break
		}
		pos = newPos

		switch fieldName {
		case "ok":
			switch elemType {
			case bsonDouble:
				if pos+8 <= len(doc) {
					info.ok = math.Float64frombits(binary.LittleEndian.Uint64(doc[pos : pos+8]))
					info.hasOk = true
				}
			case bsonInt32:
				if pos+4 <= len(doc) {
					info.ok = float64(int32(binary.LittleEndian.Uint32(doc[pos : pos+4])))
					info.hasOk = true
				}
			case bsonInt64:
				if pos+8 <= len(doc) {
					info.ok = float64(int64(binary.LittleEndian.Uint64(doc[pos : pos+8])))
					info.hasOk = true
				}
			}
		case "n":
			switch elemType {
			case bsonInt32:
				if pos+4 <= len(doc) {
					info.n = int64(int32(binary.LittleEndian.Uint32(doc[pos : pos+4])))
				}
			case bsonInt64:
				if pos+8 <= len(doc) {
					info.n = int64(binary.LittleEndian.Uint64(doc[pos : pos+8]))
				}
			case bsonDouble:
				if pos+8 <= len(doc) {
					info.n = int64(math.Float64frombits(binary.LittleEndian.Uint64(doc[pos : pos+8])))
				}
			}
		case "errmsg":
			if elemType == bsonString {
				info.errmsg, _ = readBSONString(doc, pos, docLen)
			}
		}

		pos = skipBSONValue(elemType, doc, pos, docLen)
		if pos < 0 {
			break
		}
	}

	return info
}

// readCString reads a null-terminated string from doc starting at pos.
func readCString(doc []byte, pos int, docLen int) (string, int) {
	start := pos
	for pos < docLen && pos < len(doc) {
		if doc[pos] == 0 {
			return string(doc[start:pos]), pos + 1
		}
		pos++
	}
	return "", pos
}

// readBSONString reads a BSON string (length-prefixed UTF-8) from doc starting at pos.
func readBSONString(doc []byte, pos int, docLen int) (string, int) {
	if pos+4 > len(doc) || pos+4 > docLen {
		return "", pos
	}
	strLen := int(binary.LittleEndian.Uint32(doc[pos : pos+4]))
	pos += 4
	if strLen <= 0 || pos+strLen > len(doc) || pos+strLen > docLen {
		return "", pos
	}
	s := string(doc[pos : pos+strLen-1]) // exclude null terminator
	return s, pos + strLen
}

// skipBSONValue advances past a BSON value of the given type.
func skipBSONValue(elemType byte, doc []byte, pos int, docLen int) int {
	switch elemType {
	case bsonDouble:
		return pos + 8
	case bsonString:
		if pos+4 > len(doc) {
			return -1
		}
		strLen := int(binary.LittleEndian.Uint32(doc[pos : pos+4]))
		return pos + 4 + strLen
	case bsonDocument, bsonArray:
		if pos+4 > len(doc) {
			return -1
		}
		subLen := int(binary.LittleEndian.Uint32(doc[pos : pos+4]))
		if subLen < 5 {
			return -1
		}
		return pos + subLen
	case 0x05: // binary
		if pos+5 > len(doc) {
			return -1
		}
		binLen := int(binary.LittleEndian.Uint32(doc[pos : pos+4]))
		return pos + 5 + binLen
	case 0x06, 0x0A: // undefined, null
		return pos
	case 0x07: // ObjectId
		return pos + 12
	case bsonBool:
		return pos + 1
	case 0x09: // datetime
		return pos + 8
	case 0x0B: // regex
		// two cstrings
		_, p := readCString(doc, pos, docLen)
		_, p2 := readCString(doc, p, docLen)
		return p2
	case 0x0C: // DBPointer (deprecated)
		if pos+4 > len(doc) {
			return -1
		}
		strLen := int(binary.LittleEndian.Uint32(doc[pos : pos+4]))
		return pos + 4 + strLen + 12
	case 0x0D, 0x0E: // JavaScript, Symbol (deprecated)
		if pos+4 > len(doc) {
			return -1
		}
		strLen := int(binary.LittleEndian.Uint32(doc[pos : pos+4]))
		return pos + 4 + strLen
	case 0x0F: // JavaScript with scope
		if pos+4 > len(doc) {
			return -1
		}
		totalLen := int(binary.LittleEndian.Uint32(doc[pos : pos+4]))
		return pos + totalLen
	case bsonInt32:
		return pos + 4
	case 0x11: // timestamp
		return pos + 8
	case bsonInt64:
		return pos + 8
	case 0x13: // Decimal128
		return pos + 16
	case 0xFF, 0x7F: // min/max key
		return pos
	default:
		return -1
	}
}

// reconstructQuery rebuilds the JSON query string from the BSON command document.
// The wire protocol uses different command names/structures than the high-level
// driver API. This function maps wire-level commands back to the format used in
// test definitions so the validator's exact string match works:
//
//	Wire "insert" + 1 doc   → {"operation":"insertOne","collection":"...","document":{...}}
//	Wire "insert" + N docs  → {"operation":"insertMany","collection":"...","documents":[...]}
//	Wire "update" + multi:false → {"operation":"updateOne","collection":"...","filter":{...},"update":{...}}
//	Wire "update" + multi:true  → {"operation":"updateMany","collection":"...","filter":{...},"update":{...}}
//	Wire "delete" + limit:1 → {"operation":"deleteOne","collection":"...","filter":{...}}
//	Wire "delete" + limit:0 → {"operation":"deleteMany","collection":"...","filter":{...}}
//	Wire "find"             → {"operation":"find","collection":"...","filter":{...}}
func reconstructQuery(cmd commandInfo) string {
	if cmd.rawBSONBody == nil || cmd.commandName == "" {
		query := cmd.commandName
		if cmd.collectionName != "" {
			query += " " + cmd.collectionName
		}
		return query
	}

	var doc bson.D
	if err := bson.Unmarshal(cmd.rawBSONBody, &doc); err != nil {
		query := cmd.commandName
		if cmd.collectionName != "" {
			query += " " + cmd.collectionName
		}
		return query
	}

	switch cmd.commandName {
	case "insert":
		return reconstructInsert(cmd.collectionName, doc, cmd.kind1Sections)
	case "update":
		return reconstructUpdate(cmd.collectionName, doc, cmd.kind1Sections)
	case "delete":
		return reconstructDelete(cmd.collectionName, doc, cmd.kind1Sections)
	case "find":
		return reconstructFind(cmd.collectionName, doc)
	default:
		return reconstructGeneric(cmd.commandName, cmd.collectionName, doc)
	}
}

func reconstructInsert(collection string, doc bson.D, kind1 map[string][]bson.D) string {
	// Check Kind 0 body first, then Kind 1 sections
	var documents bson.A
	for _, elem := range doc {
		if elem.Key == "documents" {
			if arr, ok := elem.Value.(bson.A); ok {
				documents = arr
			}
		}
	}

	// If documents not in Kind 0, check Kind 1 section
	if len(documents) == 0 && kind1 != nil {
		if k1docs, ok := kind1["documents"]; ok && len(k1docs) > 0 {
			for _, d := range k1docs {
				documents = append(documents, d)
			}
		}
	}

	if len(documents) == 1 {
		pairs := []orderedPair{
			{key: "operation", value: "insertOne"},
			{key: "collection", value: collection},
			{key: "document", value: bsonToInterface(documents[0])},
		}
		return marshalOrdered(pairs)
	}

	pairs := []orderedPair{
		{key: "operation", value: "insertMany"},
		{key: "collection", value: collection},
		{key: "documents", value: bsonToInterface(documents)},
	}
	return marshalOrdered(pairs)
}

func reconstructUpdate(collection string, doc bson.D, kind1 map[string][]bson.D) string {
	var updates bson.A
	for _, elem := range doc {
		if elem.Key == "updates" {
			if arr, ok := elem.Value.(bson.A); ok {
				updates = arr
			}
		}
	}

	// If updates not in Kind 0, check Kind 1 section
	if len(updates) == 0 && kind1 != nil {
		if k1docs, ok := kind1["updates"]; ok && len(k1docs) > 0 {
			for _, d := range k1docs {
				updates = append(updates, d)
			}
		}
	}

	if len(updates) == 0 {
		return marshalOrdered([]orderedPair{
			{key: "operation", value: "updateOne"},
			{key: "collection", value: collection},
		})
	}

	first, ok := updates[0].(bson.D)
	if !ok {
		return marshalOrdered([]orderedPair{
			{key: "operation", value: "updateOne"},
			{key: "collection", value: collection},
		})
	}

	opName := "updateOne"
	for _, elem := range first {
		if elem.Key == "multi" {
			if b, ok := elem.Value.(bool); ok && b {
				opName = "updateMany"
			}
		}
	}

	pairs := []orderedPair{
		{key: "operation", value: opName},
		{key: "collection", value: collection},
	}
	for _, elem := range first {
		if elem.Key == "q" {
			pairs = append(pairs, orderedPair{key: "filter", value: bsonToInterface(elem.Value)})
		}
		if elem.Key == "u" {
			pairs = append(pairs, orderedPair{key: "update", value: bsonToInterface(elem.Value)})
		}
	}
	return marshalOrdered(pairs)
}

func reconstructDelete(collection string, doc bson.D, kind1 map[string][]bson.D) string {
	var deletes bson.A
	for _, elem := range doc {
		if elem.Key == "deletes" {
			if arr, ok := elem.Value.(bson.A); ok {
				deletes = arr
			}
		}
	}

	// If deletes not in Kind 0, check Kind 1 section
	if len(deletes) == 0 && kind1 != nil {
		if k1docs, ok := kind1["deletes"]; ok && len(k1docs) > 0 {
			for _, d := range k1docs {
				deletes = append(deletes, d)
			}
		}
	}

	if len(deletes) == 0 {
		return marshalOrdered([]orderedPair{
			{key: "operation", value: "deleteOne"},
			{key: "collection", value: collection},
		})
	}

	first, ok := deletes[0].(bson.D)
	if !ok {
		return marshalOrdered([]orderedPair{
			{key: "operation", value: "deleteOne"},
			{key: "collection", value: collection},
		})
	}

	opName := "deleteOne"
	for _, elem := range first {
		if elem.Key == "limit" {
			switch v := elem.Value.(type) {
			case int32:
				if v == 0 {
					opName = "deleteMany"
				}
			case int64:
				if v == 0 {
					opName = "deleteMany"
				}
			}
		}
	}

	pairs := []orderedPair{
		{key: "operation", value: opName},
		{key: "collection", value: collection},
	}
	for _, elem := range first {
		if elem.Key == "q" {
			pairs = append(pairs, orderedPair{key: "filter", value: bsonToInterface(elem.Value)})
		}
	}
	return marshalOrdered(pairs)
}

func reconstructFind(collection string, doc bson.D) string {
	// Detect findOne: the Go driver sends find with limit=1 and singleBatch=true
	isFindOne := false
	hasLimit1 := false
	hasSingleBatch := false
	for _, elem := range doc {
		if elem.Key == "limit" {
			if n := bsonNumToInt64(elem.Value); n == 1 {
				hasLimit1 = true
			}
		}
		if elem.Key == "singleBatch" {
			if b, ok := elem.Value.(bool); ok && b {
				hasSingleBatch = true
			}
		}
	}
	isFindOne = hasLimit1 && hasSingleBatch

	opName := "find"
	if isFindOne {
		opName = "findOne"
	}

	pairs := []orderedPair{
		{key: "operation", value: opName},
		{key: "collection", value: collection},
	}
	for _, elem := range doc {
		if elem.Key == "filter" {
			pairs = append(pairs, orderedPair{key: "filter", value: bsonToInterface(elem.Value)})
		}
	}
	return marshalOrdered(pairs)
}

func reconstructGeneric(commandName, collection string, doc bson.D) string {
	pairs := []orderedPair{
		{key: "operation", value: commandName},
		{key: "collection", value: collection},
	}
	knownFields := map[string]bool{
		"filter": true, "document": true, "documents": true, "update": true,
	}
	for _, elem := range doc {
		if elem.Key == commandName || elem.Key == "$db" ||
			elem.Key == "lsid" || elem.Key == "$clusterTime" ||
			elem.Key == "$readPreference" || elem.Key == "ordered" {
			continue
		}
		if knownFields[elem.Key] {
			pairs = append(pairs, orderedPair{key: elem.Key, value: bsonToInterface(elem.Value)})
		}
	}
	return marshalOrdered(pairs)
}

type orderedPair struct {
	key   string
	value interface{}
}

func marshalOrdered(pairs []orderedPair) string {
	var buf []byte
	buf = append(buf, '{')
	for i, p := range pairs {
		if i > 0 {
			buf = append(buf, ',')
		}
		keyJSON, _ := json.Marshal(p.key)
		valJSON, _ := json.Marshal(p.value)
		buf = append(buf, keyJSON...)
		buf = append(buf, ':')
		buf = append(buf, valJSON...)
	}
	buf = append(buf, '}')
	return string(buf)
}

// orderedDoc preserves BSON key order when marshaled to JSON.
type orderedDoc []orderedPair

func (d orderedDoc) MarshalJSON() ([]byte, error) {
	return []byte(marshalOrdered(d)), nil
}

func bsonToInterface(v interface{}) interface{} {
	switch val := v.(type) {
	case bson.D:
		pairs := make(orderedDoc, 0, len(val))
		for _, elem := range val {
			if elem.Key == "_id" {
				continue
			}
			pairs = append(pairs, orderedPair{key: elem.Key, value: bsonToInterface(elem.Value)})
		}
		return pairs
	case bson.A:
		arr := make([]interface{}, len(val))
		for i, item := range val {
			arr[i] = bsonToInterface(item)
		}
		return arr
	default:
		return v
	}
}

// extractGetMoreCursorID extracts the cursor ID from a getMore command's BSON body.
// The wire command looks like: {getMore: NumberLong(cursorID), collection: "...", ...}
func extractGetMoreCursorID(rawBody []byte) int64 {
	var doc bson.D
	if err := bson.Unmarshal(rawBody, &doc); err != nil {
		return 0
	}
	for _, elem := range doc {
		if elem.Key == "getMore" {
			return bsonNumToInt64(elem.Value)
		}
	}
	return 0
}

// isDriverInternalCommand returns true for commands we don't want to log.
func isDriverInternalCommand(name string) bool {
	switch name {
	case "hello", "isMaster", "ismaster", "saslStart", "saslContinue",
		"ping", "endSessions", "buildInfo", "getFreeMonitoringStatus",
		"getLog", "replSetGetStatus", "serverStatus":
		return true
	}
	return false
}

// shouldStripCompression checks if this is a hello/isMaster response that
// advertises compression capabilities. Returns true if compression should
// be stripped from the response.
func isHelloResponse(msg *mongoMessage, cmdName string) bool {
	return msg.opCode == opMsg && (cmdName == "hello" || cmdName == "isMaster" || cmdName == "ismaster")
}

// stripCompressionFromHello removes the "compression" field from a hello/isMaster
// response so the driver and server don't negotiate compression. This ensures all
// subsequent traffic is plain OP_MSG that the proxy can parse and log.
// Returns modified raw bytes, or the original if stripping fails.
func stripCompressionFromHello(raw []byte) []byte {
	if len(raw) < headerSize+5 {
		return raw
	}

	body := raw[headerSize:]
	flags := body[:4]
	if body[4] != 0 {
		return raw
	}
	bsonStart := headerSize + 4 + 1 // header + flags + kind byte
	bsonDoc := raw[bsonStart:]

	if len(bsonDoc) < 5 {
		return raw
	}
	docLen := int(binary.LittleEndian.Uint32(bsonDoc[0:4]))
	if docLen < 5 || docLen > len(bsonDoc) {
		return raw
	}

	// Scan for the "compression" field and remove it
	pos := 4
	for pos < docLen-1 {
		elemStart := pos
		elemType := bsonDoc[pos]
		pos++

		fieldName, newPos := readCString(bsonDoc, pos, docLen)
		if fieldName == "" {
			break
		}
		pos = newPos

		nextPos := skipBSONValue(elemType, bsonDoc, pos, docLen)
		if nextPos < 0 {
			break
		}

		if fieldName == "compression" {
			// Remove this element from the BSON document
			elemEnd := nextPos
			newDoc := make([]byte, 0, len(bsonDoc)-(elemEnd-elemStart))
			newDoc = append(newDoc, bsonDoc[:elemStart]...)
			newDoc = append(newDoc, bsonDoc[elemEnd:]...)

			// Update BSON document length
			newDocLen := len(newDoc)
			binary.LittleEndian.PutUint32(newDoc[0:4], uint32(newDocLen))

			// Rebuild the message
			result := make([]byte, 0, headerSize+4+1+len(newDoc))
			result = append(result, raw[:headerSize]...) // original header
			result = append(result, flags...)            // flagBits
			result = append(result, 0)                   // kind 0
			result = append(result, newDoc...)

			// Check if original had checksum
			if binary.LittleEndian.Uint32(flags)&flagChecksumPresent != 0 {
				// Append 4 zero bytes for checksum placeholder.
				// The driver will recalculate if needed, or we can skip validation.
				result = append(result, 0, 0, 0, 0)
			}

			// Update message length in header
			binary.LittleEndian.PutUint32(result[0:4], uint32(len(result)))

			return result
		}

		pos = nextPos
	}

	return raw
}
