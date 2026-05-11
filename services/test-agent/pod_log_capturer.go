package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

const podLogTailLines int64 = 100
const podLogLimitBytes int64 = 1024 * 1024 // 1MB safety cap per container

// PodLogEntry holds captured log data for a single container in a pod.
type PodLogEntry struct {
	ItemName          string
	PodName           string
	ContainerName     string
	Logs              string // current container logs
	PreviousLogs      string // logs from previous container instance (crash loops)
	WaitingReason     string
	TerminationReason string
}

// CapturePodLogs captures container logs and status reasons for all non-ready
// pods belonging to the given instance. Skips pods that can't be mapped back
// to a user-defined item (test-agent, interceptors).
func CapturePodLogs(
	ctx context.Context,
	clientset *kubernetes.Clientset,
	namespace string,
	instanceId string,
	urlMap map[string]URLMapEntry,
	databaseMap map[string]DatabaseInfo,
) []PodLogEntry {
	listCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	labelSelector := fmt.Sprintf("dokkimi.io/instance-id=%s", instanceId)
	pods, err := clientset.CoreV1().Pods(namespace).List(listCtx, metav1.ListOptions{
		LabelSelector: labelSelector,
	})
	if err != nil {
		log.Printf("[PodLogCapturer] Warning: failed to list pods: %v", err)
		return nil
	}

	var entries []PodLogEntry
	for _, pod := range pods.Items {
		appLabel := pod.Labels["app"]
		if appLabel == "" {
			continue
		}

		itemName := resolveItemName(appLabel, urlMap, databaseMap)
		if itemName == "" {
			continue // unmappable pod (test-agent, interceptor, etc.)
		}

		if isPodHealthy(&pod) {
			continue
		}

		// Collect entries for init containers — skip Dokkimi infra containers
		for _, cs := range pod.Status.InitContainerStatuses {
			if isDokkimiSidecar(cs.Name) {
				continue
			}
			if entry := captureContainerEntry(ctx, clientset, namespace, pod.Name, itemName, &cs); entry != nil {
				entries = append(entries, *entry)
			}
		}

		// Collect entries for regular containers — skip Dokkimi sidecars
		for _, cs := range pod.Status.ContainerStatuses {
			if isDokkimiSidecar(cs.Name) {
				continue
			}
			if entry := captureContainerEntry(ctx, clientset, namespace, pod.Name, itemName, &cs); entry != nil {
				entries = append(entries, *entry)
			}
		}
	}

	if len(entries) > 0 {
		log.Printf("[PodLogCapturer] Captured logs for %d container(s) across failing pods", len(entries))
	}
	return entries
}

// FormatPodLogMessage formats a PodLogEntry into the structured message
// format expected by the TestExecutionLogger.
func FormatPodLogMessage(entry PodLogEntry) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[item:%s] [pod:%s] [container:%s]\n", entry.ItemName, entry.PodName, entry.ContainerName)

	if entry.WaitingReason != "" {
		fmt.Fprintf(&b, "Waiting reason: %s\n", entry.WaitingReason)
	}
	if entry.TerminationReason != "" {
		fmt.Fprintf(&b, "Termination reason: %s\n", entry.TerminationReason)
	}

	if entry.PreviousLogs != "" {
		fmt.Fprintf(&b, "\n--- Previous Container Logs (last %d lines) ---\n", podLogTailLines)
		b.WriteString(entry.PreviousLogs)
		if !strings.HasSuffix(entry.PreviousLogs, "\n") {
			b.WriteByte('\n')
		}
	}

	if entry.Logs != "" {
		fmt.Fprintf(&b, "\n--- Current Container Logs (last %d lines) ---\n", podLogTailLines)
		b.WriteString(entry.Logs)
		if !strings.HasSuffix(entry.Logs, "\n") {
			b.WriteByte('\n')
		}
	}

	if entry.PreviousLogs == "" && entry.Logs == "" {
		b.WriteString("\n(no container logs available)\n")
	}

	return b.String()
}

// resolveItemName maps a pod's app label to the user-facing item name
// via the urlMap or databaseMap. Returns "" if unmappable.
func resolveItemName(appLabel string, urlMap map[string]URLMapEntry, databaseMap map[string]DatabaseInfo) string {
	if entry, ok := urlMap[appLabel]; ok {
		if entry.Name != "" {
			return entry.Name
		}
		return appLabel
	}
	if _, ok := databaseMap[appLabel]; ok {
		return appLabel
	}
	return ""
}

// captureContainerEntry captures logs and status for a single container.
// Returns nil if the container is healthy and has no useful data to report.
func captureContainerEntry(
	ctx context.Context,
	clientset *kubernetes.Clientset,
	namespace string,
	podName string,
	itemName string,
	cs *corev1.ContainerStatus,
) *PodLogEntry {
	waitingReason := extractWaitingReason(cs)
	terminationReason := extractTerminationReason(cs)

	// Capture current logs
	currentLogs := fetchContainerLogs(ctx, clientset, namespace, podName, cs.Name, false)

	// Capture previous logs if container has restarted (crash loops)
	var previousLogs string
	if cs.RestartCount > 0 {
		previousLogs = fetchContainerLogs(ctx, clientset, namespace, podName, cs.Name, true)
	}

	// Skip containers with nothing useful to report
	if waitingReason == "" && terminationReason == "" && currentLogs == "" && previousLogs == "" {
		return nil
	}

	return &PodLogEntry{
		ItemName:          itemName,
		PodName:           podName,
		ContainerName:     cs.Name,
		Logs:              currentLogs,
		PreviousLogs:      previousLogs,
		WaitingReason:     waitingReason,
		TerminationReason: terminationReason,
	}
}

// fetchContainerLogs fetches the last N lines of logs for a container.
// If previous is true, fetches logs from the previous container instance.
// Returns "" on any error.
func fetchContainerLogs(
	ctx context.Context,
	clientset *kubernetes.Clientset,
	namespace string,
	podName string,
	containerName string,
	previous bool,
) string {
	logCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	tailLines := podLogTailLines
	limitBytes := podLogLimitBytes
	opts := &corev1.PodLogOptions{
		Container:  containerName,
		TailLines:  &tailLines,
		LimitBytes: &limitBytes,
		Previous:   previous,
	}

	req := clientset.CoreV1().Pods(namespace).GetLogs(podName, opts)
	stream, err := req.Stream(logCtx)
	if err != nil {
		if previous {
			// Previous logs often unavailable (first run, no restarts) — don't warn
			return ""
		}
		log.Printf("[PodLogCapturer] Warning: failed to get logs for %s/%s: %v", podName, containerName, err)
		return ""
	}
	defer stream.Close()

	data, err := io.ReadAll(stream)
	if err != nil {
		log.Printf("[PodLogCapturer] Warning: failed to read logs for %s/%s: %v", podName, containerName, err)
		return ""
	}

	return string(data)
}

// extractWaitingReason returns a human-readable waiting reason from container status, or "".
func extractWaitingReason(cs *corev1.ContainerStatus) string {
	if cs.State.Waiting == nil {
		return ""
	}
	reason := cs.State.Waiting.Reason
	if cs.State.Waiting.Message != "" {
		reason += ": " + cs.State.Waiting.Message
	}
	return reason
}

// extractTerminationReason returns a human-readable termination reason from container status, or "".
// Checks both current state and last state.
func extractTerminationReason(cs *corev1.ContainerStatus) string {
	// Check current terminated state first
	if t := cs.State.Terminated; t != nil {
		return formatTermination(t)
	}
	// Fall back to last terminated state (container restarted)
	if t := cs.LastTerminationState.Terminated; t != nil {
		return formatTermination(t)
	}
	return ""
}

func formatTermination(t *corev1.ContainerStateTerminated) string {
	parts := []string{}
	if t.Reason != "" {
		parts = append(parts, t.Reason)
	}
	if t.ExitCode != 0 {
		parts = append(parts, fmt.Sprintf("exit code %d", t.ExitCode))
	}
	if t.Message != "" {
		parts = append(parts, t.Message)
	}
	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, " — ")
}

// isPodHealthy returns true if the pod is running with all containers ready.
func isPodHealthy(pod *corev1.Pod) bool {
	if pod.Status.Phase != corev1.PodRunning {
		return false
	}
	for _, cs := range pod.Status.ContainerStatuses {
		if !cs.Ready {
			return false
		}
	}
	return true
}

// isDokkimiSidecar returns true for Dokkimi infrastructure container names
// (interceptor, fluent-bit, ca-bundle) whose logs aren't useful to users.
func isDokkimiSidecar(containerName string) bool {
	return strings.HasPrefix(containerName, "interceptor") ||
		containerName == "fluent-bit" ||
		containerName == "ca-bundle"
}
