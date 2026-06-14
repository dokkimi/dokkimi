package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/Graylog2/go-gelf/gelf"
)

const gelfPort = 12201

// GelfReceiver listens for GELF UDP messages from Docker's GELF log driver
// and appends them to the step log buffer. It also forwards console logs
// to Control Tower for storage (dump/inspect).
type GelfReceiver struct {
	reader          *gelf.Reader
	logBuffer       *StepLogBuffer
	controlTowerURL string
	instanceID      string
	httpClient      *http.Client
	// serviceItemIDs maps service definition name → instanceItemId for CT forwarding.
	serviceItemIDs map[string]string
}

// NewGelfReceiver creates and starts a GELF UDP listener on port 12201.
// serviceItemIDs maps service definition names to their instanceItemIds.
func NewGelfReceiver(
	logBuffer *StepLogBuffer,
	controlTowerURL string,
	instanceID string,
	serviceItemIDs map[string]string,
) (*GelfReceiver, error) {
	addr := fmt.Sprintf("0.0.0.0:%d", gelfPort)
	reader, err := gelf.NewReader(addr)
	if err != nil {
		return nil, fmt.Errorf("failed to start GELF listener on %s: %w", addr, err)
	}

	gr := &GelfReceiver{
		reader:          reader,
		logBuffer:       logBuffer,
		controlTowerURL: controlTowerURL,
		instanceID:      instanceID,
		httpClient:      &http.Client{Timeout: 10 * time.Second},
		serviceItemIDs:  serviceItemIDs,
	}

	log.Printf("GELF UDP listener started on %s", reader.Addr())
	return gr, nil
}

// Run reads GELF messages in a loop. Call from a goroutine.
// The goroutine exits when the process shuts down.
func (gr *GelfReceiver) Run() {
	for {
		msg, err := gr.reader.ReadMessage()
		if err != nil {
			if strings.Contains(err.Error(), "use of closed network connection") {
				return
			}
			log.Printf("[GelfReceiver] Read error: %v", err)
			continue
		}

		// Docker GELF tag option sets the _tag extra field to the service
		// definition name (configured in docker-service-group.service.ts).
		serviceName := stringFromExtra(msg.Extra, "_tag")
		if serviceName == "" {
			serviceName = stringFromExtra(msg.Extra, "_container_name")
		}

		source := stringFromExtra(msg.Extra, "_source")
		if source == "" {
			if msg.Level <= 3 {
				source = "stderr"
			} else {
				source = "stdout"
			}
		}

		logLine := msg.Short
		level := parseLogLevel(logLine)

		consoleLog := ConsoleLogMessage{
			Service:   serviceName,
			Source:    source,
			Message:   logLine,
			Timestamp: msg.TimeUnix,
			Level:     level,
		}

		gr.logBuffer.AddConsoleLog(consoleLog)

		go gr.forwardToControlTower(consoleLog)
	}
}

// forwardToControlTower sends the console log to CT's POST /logs/console endpoint.
func (gr *GelfReceiver) forwardToControlTower(consoleLog ConsoleLogMessage) {
	ts := time.Unix(int64(consoleLog.Timestamp), int64((consoleLog.Timestamp-float64(int64(consoleLog.Timestamp)))*1e9))

	payload := map[string]interface{}{
		"log":        consoleLog.Message,
		"stream":     consoleLog.Source,
		"time":       ts.UTC().Format(time.RFC3339Nano),
		"instanceId": gr.instanceID,
	}

	if itemID, ok := gr.serviceItemIDs[consoleLog.Service]; ok {
		payload["instanceItemId"] = itemID
	}

	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[GelfReceiver] Failed to marshal console log for CT: %v", err)
		return
	}

	url := gr.controlTowerURL + "/logs/console"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := gr.httpClient.Do(req)
	if err != nil {
		log.Printf("[GelfReceiver] Failed to forward console log to CT: %v", err)
		return
	}
	resp.Body.Close()
}

// parseLogLevel extracts the log level from a log message prefix.
func parseLogLevel(message string) string {
	if message == "" {
		return "INFO"
	}

	upper := strings.ToUpper(message)

	if strings.Contains(upper, "[ERROR]") || strings.Contains(upper, "ERROR:") {
		return "ERROR"
	}
	if strings.Contains(upper, "[WARN]") || strings.Contains(upper, "WARN:") {
		return "WARN"
	}
	if strings.Contains(upper, "[DEBUG]") || strings.Contains(upper, "DEBUG:") {
		return "DEBUG"
	}
	if strings.Contains(upper, "[INFO]") || strings.Contains(upper, "INFO:") {
		return "INFO"
	}

	return "INFO"
}

func stringFromExtra(extra map[string]interface{}, key string) string {
	if extra == nil {
		return ""
	}
	v, ok := extra[key]
	if !ok {
		return ""
	}
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return s
}
