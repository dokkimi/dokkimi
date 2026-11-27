package main

import (
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/dokkimi/dokkimi/services/broker-proxy/shared"
)

func shortStr(s string) []byte { return append([]byte{byte(len(s))}, s...) }

func methodFrame(channel, methodID uint16, args []byte) *frame {
	p := binary.BigEndian.AppendUint16(nil, classBasic)
	p = binary.BigEndian.AppendUint16(p, methodID)
	return &frame{Type: frameMethod, Channel: channel, Payload: append(p, args...)}
}

func headerFrame(channel uint16, bodySize int) *frame {
	p := binary.BigEndian.AppendUint16(nil, classBasic)
	p = binary.BigEndian.AppendUint16(p, 0) // weight
	p = binary.BigEndian.AppendUint64(p, uint64(bodySize))
	p = binary.BigEndian.AppendUint16(p, 0) // no properties
	return &frame{Type: frameHeader, Channel: channel, Payload: p}
}

func bodyFrame(channel uint16, body string) *frame {
	return &frame{Type: frameBody, Channel: channel, Payload: []byte(body)}
}

// A publish and a delivery on the same channel, with their frames interleaved,
// are each logged whole: they are assembled separately.
func TestPublishAndDeliverOnOneChannel(t *testing.T) {
	var mu sync.Mutex
	var logged []shared.MessageLogMessage
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var m shared.MessageLogMessage
		if json.NewDecoder(r.Body).Decode(&m) == nil {
			mu.Lock()
			logged = append(logged, m)
			mu.Unlock()
		}
	}))
	defer srv.Close()
	logger := shared.NewMessageLogger(srv.URL, time.Second)
	defer logger.Stop()
	c := newAmqpConnection(nil, nil, &shared.Config{}, logger)

	publishArgs := append(append([]byte{0, 0}, shortStr("")...), shortStr("orders")...)
	deliverArgs := append(shortStr("ctag"), make([]byte, 9)...) // delivery tag + redelivered
	deliverArgs = append(append(deliverArgs, shortStr("")...), shortStr("orders")...)
	pub, del := `{"op":"publish"}`, `{"op":"deliver"}`

	for _, f := range []struct {
		f          *frame
		fromClient bool
	}{
		{methodFrame(1, methodPublish, publishArgs), true},
		{methodFrame(1, methodDeliver, deliverArgs), false},
		{headerFrame(1, len(pub)), true},
		{headerFrame(1, len(del)), false},
		{bodyFrame(1, pub[:5]), true},
		{bodyFrame(1, del[:7]), false},
		{bodyFrame(1, pub[5:]), true},
		{bodyFrame(1, del[7:]), false},
	} {
		c.inspectFrame(f.f, f.fromClient)
	}

	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	got := map[string]string{}
	for _, m := range logged {
		b, _ := json.Marshal(m.Body)
		got[m.Operation] = string(b)
	}
	if got["publish"] != pub || got["deliver"] != del {
		t.Errorf("got %v, want publish %s and deliver %s", got, pub, del)
	}
}
