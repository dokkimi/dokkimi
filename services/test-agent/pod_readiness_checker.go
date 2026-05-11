package main

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// PodReadinessChecker checks pod readiness via Kubernetes API
type PodReadinessChecker struct {
	clientset *kubernetes.Clientset
	namespace string
}

// NewPodReadinessChecker creates a new pod readiness checker
func NewPodReadinessChecker(clientset *kubernetes.Clientset, namespace string) (*PodReadinessChecker, error) {
	return &PodReadinessChecker{
		clientset: clientset,
		namespace: namespace,
	}, nil
}

// VerifyAllPodsReadyWithRetry verifies all pods are ready with retry logic using Fibonacci backoff.
// Returns (true, "") if all pods are ready, or (false, reason) with an explanation of the failure.
// Aborts immediately on fatal errors like image pull failures (no retries).
func (p *PodReadinessChecker) VerifyAllPodsReadyWithRetry(ctx context.Context, instanceId string, maxRetries int, initialDelay time.Duration) (bool, string) {
	// Fibonacci sequence: 1, 1, 2, 3, 5, 8, 13, 21
	fibonacciMultipliers := []int{1, 1, 2, 3, 5, 8, 13, 21}

	for attempt := 0; attempt < maxRetries; attempt++ {
		allReady, notReady, err := p.VerifyAllPodsReady(ctx, instanceId)
		if err != nil {
			log.Printf("Error checking pod readiness (attempt %d/%d): %v", attempt+1, maxRetries, err)
			if attempt < maxRetries-1 {
				fibMultiplier := fibonacciMultipliers[attempt]
				if attempt >= len(fibonacciMultipliers) {
					fibMultiplier = fibonacciMultipliers[len(fibonacciMultipliers)-1]
				}
				backoff := initialDelay * time.Duration(fibMultiplier)
				log.Printf("Retrying in %v...", backoff)
				time.Sleep(backoff)
				continue
			}
			reason := fmt.Sprintf("Failed to verify pod readiness after %d attempts: %v", maxRetries, err)
			log.Printf("%s", reason)
			return false, reason
		}

		if allReady {
			if attempt > 0 {
				log.Printf("All pods verified ready via Kubernetes API (after %d attempts)", attempt+1)
			}
			return true, ""
		}

		// Check for fatal pod conditions (image pull failures) before retrying
		if fatalReason := p.checkForFatalPodErrors(ctx, instanceId); fatalReason != "" {
			log.Printf("Fatal pod error detected, aborting: %s", fatalReason)
			return false, fatalReason
		}

		log.Printf("Not all pods ready (attempt %d/%d). Not ready pods: %v", attempt+1, maxRetries, notReady)
		if attempt < maxRetries-1 {
			fibMultiplier := fibonacciMultipliers[attempt]
			if attempt >= len(fibonacciMultipliers) {
				fibMultiplier = fibonacciMultipliers[len(fibonacciMultipliers)-1]
			}
			backoff := initialDelay * time.Duration(fibMultiplier)
			log.Printf("Retrying in %v...", backoff)
			time.Sleep(backoff)
		}
	}

	return false, "Not all pods became ready after retries"
}

// VerifyAllPodsReady checks if all pods in the namespace with the instance-id label are ready
// Returns: (allReady, list of not-ready pod names, error)
func (p *PodReadinessChecker) VerifyAllPodsReady(ctx context.Context, instanceId string) (bool, []string, error) {
	// Create context with timeout for the API call
	apiCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Get all pods in the namespace with the instance-id label
	labelSelector := fmt.Sprintf("dokkimi.io/instance-id=%s", instanceId)
	pods, err := p.clientset.CoreV1().Pods(p.namespace).List(apiCtx, metav1.ListOptions{
		LabelSelector: labelSelector,
	})
	if err != nil {
		return false, nil, fmt.Errorf("failed to list pods: %w", err)
	}

	if len(pods.Items) == 0 {
		log.Printf("Warning: No pods found with label dokkimi.io/instance-id=%s", instanceId)
		return false, nil, nil
	}

	notReady := []string{}
	for _, pod := range pods.Items {
		// Skip test-agent pod itself
		if strings.HasPrefix(pod.Name, "test-agent") {
			continue
		}

		if !p.isPodReady(&pod) {
			notReady = append(notReady, pod.Name)
		}
	}

	allReady := len(notReady) == 0
	if allReady {
		log.Printf("All %d pods verified ready via Kubernetes API", len(pods.Items))
	} else {
		log.Printf("Found %d pods, %d not ready: %v", len(pods.Items), len(notReady), notReady)
	}

	return allReady, notReady, nil
}

// fatalPodReasons are Kubernetes container waiting reasons that indicate
// an unrecoverable error. These are not transient and should abort immediately.
var fatalPodReasons = map[string]bool{
	"ErrImagePull":     true,
	"ImagePullBackOff": true,
	"InvalidImageName": true,
	"CrashLoopBackOff": true,
}

// checkForFatalPodErrors scans all pods for fatal container errors like image pull failures
// or crash loops. Returns a human-readable reason string if a fatal error is found, or "" if none.
func (p *PodReadinessChecker) checkForFatalPodErrors(ctx context.Context, instanceId string) string {
	apiCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	labelSelector := fmt.Sprintf("dokkimi.io/instance-id=%s", instanceId)
	pods, err := p.clientset.CoreV1().Pods(p.namespace).List(apiCtx, metav1.ListOptions{
		LabelSelector: labelSelector,
	})
	if err != nil {
		return ""
	}

	for _, pod := range pods.Items {
		if strings.HasPrefix(pod.Name, "test-agent") {
			continue
		}
		// Check both init containers and regular containers
		for _, cs := range pod.Status.InitContainerStatuses {
			if reason := checkContainerForFatalError(&cs); reason != "" {
				return fmt.Sprintf("Fatal error for pod %q: container %q image %q — %s",
					pod.Name, cs.Name, cs.Image, reason)
			}
		}
		for _, cs := range pod.Status.ContainerStatuses {
			if reason := checkContainerForFatalError(&cs); reason != "" {
				return fmt.Sprintf("Fatal error for pod %q: container %q image %q — %s",
					pod.Name, cs.Name, cs.Image, reason)
			}
		}
	}

	return ""
}

// checkContainerForFatalError checks a single container status for fatal errors
// (image pull failures, crash loops). Returns the reason + message if found, or "" if fine.
func checkContainerForFatalError(cs *corev1.ContainerStatus) string {
	if cs.State.Waiting == nil {
		return ""
	}
	if !fatalPodReasons[cs.State.Waiting.Reason] {
		return ""
	}
	if cs.State.Waiting.Message != "" {
		return fmt.Sprintf("%s: %s", cs.State.Waiting.Reason, cs.State.Waiting.Message)
	}
	return cs.State.Waiting.Reason
}

// isPodReady checks if a pod is ready to receive traffic
func (p *PodReadinessChecker) isPodReady(pod *corev1.Pod) bool {
	// Pod must be in Running phase
	if pod.Status.Phase != corev1.PodRunning {
		return false
	}

	// All containers must be ready
	if len(pod.Status.ContainerStatuses) == 0 {
		return false
	}

	for _, containerStatus := range pod.Status.ContainerStatuses {
		if !containerStatus.Ready {
			return false
		}
	}

	return true
}
