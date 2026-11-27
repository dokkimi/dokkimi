package main

import (
	"sync"
	"time"
)

// cursorAccumulator collects the batches of a find or aggregate whose cursor
// spans getMore round-trips. It is logged once, when the cursor ends.
type cursorAccumulator struct {
	query     string
	startTime time.Time
	data      []map[string]interface{}
}

// cursorRegistry holds the cursors still open. It is shared by the proxy's
// connections: drivers pool connections and may continue a cursor on another
// one than the one that opened it. Before, each connection had its own, so
// such a find was never logged and its getMores were logged on their own.
type cursorRegistry struct {
	mu   sync.Mutex
	open map[int64]*cursorAccumulator
}

func newCursorRegistry() *cursorRegistry {
	return &cursorRegistry{open: make(map[int64]*cursorAccumulator)}
}

func (r *cursorRegistry) start(id int64, acc *cursorAccumulator) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.open[id] = acc
}

// next adds a getMore's batch to its cursor. It returns the cursor, and
// whether it ended (nextID 0); nil when the cursor isn't known.
func (r *cursorRegistry) next(id int64, batch []map[string]interface{}, nextID int64) (*cursorAccumulator, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	acc, found := r.open[id]
	if !found {
		return nil, false
	}
	acc.data = append(acc.data, batch...)
	delete(r.open, id)
	if nextID == 0 {
		return acc, true
	}
	r.open[nextID] = acc
	return acc, false
}

// take removes these cursors (killCursors) and returns the known ones.
func (r *cursorRegistry) take(ids []int64) []*cursorAccumulator {
	r.mu.Lock()
	defer r.mu.Unlock()
	var taken []*cursorAccumulator
	for _, id := range ids {
		if acc, found := r.open[id]; found {
			taken = append(taken, acc)
			delete(r.open, id)
		}
	}
	return taken
}

// takeAll removes and returns every open cursor (shutdown).
func (r *cursorRegistry) takeAll() []*cursorAccumulator {
	r.mu.Lock()
	defer r.mu.Unlock()
	taken := make([]*cursorAccumulator, 0, len(r.open))
	for id, acc := range r.open {
		taken = append(taken, acc)
		delete(r.open, id)
	}
	return taken
}
