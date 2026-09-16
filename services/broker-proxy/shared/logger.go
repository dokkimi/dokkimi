package shared

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

type MessageLogMessage struct {
	LogID          string                 `json:"logId,omitempty"`
	InstanceID     string                 `json:"instanceId"`
	InstanceItemID string                 `json:"instanceItemId,omitempty"`
	BrokerType     string                 `json:"brokerType"`
	BrokerName     string                 `json:"brokerName"`
	Operation      string                 `json:"operation"` // "publish" or "deliver"
	Body           interface{}            `json:"body"`
	ContentType    string                 `json:"contentType,omitempty"`
	Timestamp      string                 `json:"timestamp,omitempty"`
	Metadata       map[string]interface{} `json:"metadata,omitempty"`
}

type MessageLogger struct {
	logEndpointURL  string
	testAgentURL    string
	httpClient      *http.Client
	testAgentClient *http.Client
	logChan         chan MessageLogMessage
	stopChan        chan struct{}
	done            chan struct{}
}

func NewMessageLogger(logEndpointURL string, timeout time.Duration) *MessageLogger {
	logger := &MessageLogger{
		logEndpointURL:  logEndpointURL,
		httpClient:      &http.Client{Timeout: timeout},
		testAgentClient: &http.Client{Timeout: timeout},
		logChan:         make(chan MessageLogMessage, 1000),
		stopChan:        make(chan struct{}),
		done:            make(chan struct{}),
	}

	go logger.worker()

	return logger
}

func (l *MessageLogger) SetTestAgentURL(url string) {
	l.testAgentURL = url
}

func (l *MessageLogger) Log(message MessageLogMessage) {
	message.LogID = newLogID()
	select {
	case l.logChan <- message:
	default:
		log.Printf("[MessageLogger] WARNING: Log channel full, dropping %s message for %s", message.Operation, message.BrokerName)
	}
}

func (l *MessageLogger) worker() {
	defer close(l.done)
	for {
		select {
		case message := <-l.logChan:
			l.sendLog(message)
		case <-l.stopChan:
			for {
				select {
				case message := <-l.logChan:
					l.sendLog(message)
				default:
					return
				}
			}
		}
	}
}

func (l *MessageLogger) sendLog(message MessageLogMessage) {
	body, err := json.Marshal(message)
	if err != nil {
		log.Printf("[MessageLogger] Failed to marshal log message: %v", err)
		return
	}

	if l.testAgentURL != "" {
		go l.sendToTestAgent(body)
	}

	// Retry transient failures — this write is the durable record. Runs on the
	// sequential worker, so retries block the queue; the buffered channel
	// absorbs the stall. A 4xx is deterministic (validation) — never retried.
	url := l.logEndpointURL + "/logs/message"
	for attempt, backoff := 0, 250*time.Millisecond; attempt < 3; attempt, backoff = attempt+1, backoff*4 {
		if attempt > 0 {
			time.Sleep(backoff)
		}
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
		if err != nil {
			log.Printf("[MessageLogger] Failed to create request to %s: %v", url, err)
			return
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := l.httpClient.Do(req)
		if err != nil {
			log.Printf("[MessageLogger] Failed to send log to %s (attempt %d/3): %v", url, attempt+1, err)
			continue
		}
		status := resp.StatusCode
		resp.Body.Close()
		if status >= 200 && status < 300 {
			return
		}
		if status >= 500 || status == http.StatusTooManyRequests {
			log.Printf("[MessageLogger] CT returned status %d (attempt %d/3)", status, attempt+1)
			continue
		}
		log.Printf("[MessageLogger] CT rejected log with status %d — not retrying", status)
		return
	}
}

// sendToTestAgent retries because these logs feed in-flight assertion
// validation — a dropped POST loses the log for the current test window,
// unlike the CT path where the log is also persisted.
func (l *MessageLogger) sendToTestAgent(body []byte) {
	url := l.testAgentURL + "/logs/message"
	for attempt, backoff := 0, 250*time.Millisecond; attempt < 3; attempt, backoff = attempt+1, backoff*4 {
		if attempt > 0 {
			time.Sleep(backoff)
		}
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := l.testAgentClient.Do(req)
		if err != nil {
			log.Printf("[MessageLogger] Failed to send log to test-agent (attempt %d/3): %v", attempt+1, err)
			continue
		}
		status := resp.StatusCode
		resp.Body.Close()
		if status >= 200 && status < 300 {
			return
		}
		if status >= 500 || status == http.StatusTooManyRequests {
			log.Printf("[MessageLogger] Test-agent returned status %d (attempt %d/3)", status, attempt+1)
			continue
		}
		log.Printf("[MessageLogger] Test-agent rejected log with status %d — not retrying", status)
		return
	}
}

// newLogID returns a random 128-bit hex id. The test-agent uses it to
// deduplicate retried log deliveries; empty (on entropy failure) just means
// no dedup for that message.
func newLogID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	return hex.EncodeToString(b)
}

func (l *MessageLogger) Stop() {
	select {
	case <-l.stopChan:
	default:
		close(l.stopChan)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	select {
	case <-l.done:
	case <-ctx.Done():
		log.Printf("[MessageLogger] Stop timed out waiting for worker to drain")
	}
}
