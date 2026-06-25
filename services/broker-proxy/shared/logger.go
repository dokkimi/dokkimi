package shared

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

type MessageLogMessage struct {
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
}

func NewMessageLogger(logEndpointURL string, timeout time.Duration) *MessageLogger {
	logger := &MessageLogger{
		logEndpointURL:  logEndpointURL,
		httpClient:      &http.Client{Timeout: timeout},
		testAgentClient: &http.Client{Timeout: timeout},
		logChan:         make(chan MessageLogMessage, 1000),
		stopChan:        make(chan struct{}),
	}

	go logger.worker()

	return logger
}

func (l *MessageLogger) SetTestAgentURL(url string) {
	l.testAgentURL = url
}

func (l *MessageLogger) Log(message MessageLogMessage) {
	select {
	case l.logChan <- message:
	default:
		log.Printf("[MessageLogger] WARNING: Log channel full, dropping %s message for %s", message.Operation, message.BrokerName)
	}
}

func (l *MessageLogger) worker() {
	for {
		select {
		case message := <-l.logChan:
			l.sendLog(message)
		case <-l.stopChan:
			return
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

	url := l.logEndpointURL + "/logs/message"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("[MessageLogger] Failed to create request to %s: %v", url, err)
		return
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := l.httpClient.Do(req)
	if err != nil {
		log.Printf("[MessageLogger] Failed to send log to %s: %v", url, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("[MessageLogger] CT returned non-success status %d", resp.StatusCode)
	}
}

func (l *MessageLogger) sendToTestAgent(body []byte) {
	url := l.testAgentURL + "/logs/message"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := l.testAgentClient.Do(req)
	if err != nil {
		log.Printf("[MessageLogger] Failed to send log to test-agent: %v", err)
		return
	}
	resp.Body.Close()
}

func (l *MessageLogger) Stop() {
	select {
	case <-l.stopChan:
	default:
		close(l.stopChan)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	for {
		select {
		case message := <-l.logChan:
			l.sendLog(message)
		case <-ctx.Done():
			return
		default:
			return
		}
	}
}
