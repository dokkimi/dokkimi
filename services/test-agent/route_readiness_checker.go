package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// RouteReadinessChecker verifies that kube-proxy has programmed iptables rules
// for each per-service interceptor Service. Pod-level readiness does not guarantee
// the corresponding Service endpoint is routable — kube-proxy updates iptables
// asynchronously after the EndpointSlice changes, and the gap can cause
// ECONNREFUSED on the first cross-pod call.
type RouteReadinessChecker struct {
	clientset *kubernetes.Clientset
	namespace string
}

func NewRouteReadinessChecker(clientset *kubernetes.Clientset, namespace string) *RouteReadinessChecker {
	return &RouteReadinessChecker{clientset: clientset, namespace: namespace}
}

// VerifyInterceptorRoutesReady dials each interceptor Service's ClusterIP:80 over TCP
// with Fibonacci backoff until every target accepts a connection.
// A successful dial proves kube-proxy has a live backend programmed.
// Returns (true, "") on success, (false, reason) on timeout.
func (r *RouteReadinessChecker) VerifyInterceptorRoutesReady(ctx context.Context, maxRetries int, initialDelay time.Duration) (bool, string) {
	targets, err := r.listInterceptorTargets(ctx)
	if err != nil {
		return false, fmt.Sprintf("Failed to list interceptor services: %v", err)
	}
	if len(targets) == 0 {
		return true, ""
	}

	fibonacciMultipliers := []int{1, 1, 2, 3, 5}

	for attempt := 0; attempt < maxRetries; attempt++ {
		unreachable := r.dialAll(ctx, targets)
		if len(unreachable) == 0 {
			if attempt > 0 {
				log.Printf("All interceptor routes reachable (after %d attempts)", attempt+1)
			} else {
				log.Printf("All %d interceptor routes reachable", len(targets))
			}
			return true, ""
		}

		log.Printf("Interceptor routes not yet reachable (attempt %d/%d): %v", attempt+1, maxRetries, unreachable)
		if attempt < maxRetries-1 {
			idx := attempt
			if idx >= len(fibonacciMultipliers) {
				idx = len(fibonacciMultipliers) - 1
			}
			backoff := initialDelay * time.Duration(fibonacciMultipliers[idx])
			time.Sleep(backoff)
		}
	}

	unreachable := r.dialAll(ctx, targets)
	return false, fmt.Sprintf("Interceptor routes never became reachable: %s", strings.Join(unreachable, ", "))
}

type interceptorTarget struct {
	name      string
	clusterIP string
	port      int32
}

func (r *RouteReadinessChecker) listInterceptorTargets(ctx context.Context) ([]interceptorTarget, error) {
	apiCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	services, err := r.clientset.CoreV1().Services(r.namespace).List(apiCtx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	targets := make([]interceptorTarget, 0, len(services.Items))
	for _, svc := range services.Items {
		if !strings.HasSuffix(svc.Name, "-interceptor") {
			continue
		}
		if svc.Spec.ClusterIP == "" || svc.Spec.ClusterIP == "None" {
			continue
		}
		var port int32
		for _, p := range svc.Spec.Ports {
			if p.Port == 80 {
				port = 80
				break
			}
		}
		if port == 0 {
			continue
		}
		targets = append(targets, interceptorTarget{
			name:      svc.Name,
			clusterIP: svc.Spec.ClusterIP,
			port:      port,
		})
	}
	return targets, nil
}

func (r *RouteReadinessChecker) dialAll(ctx context.Context, targets []interceptorTarget) []string {
	unreachable := []string{}
	dialer := net.Dialer{Timeout: 1 * time.Second}
	for _, t := range targets {
		if err := ctx.Err(); err != nil {
			unreachable = append(unreachable, fmt.Sprintf("%s (ctx: %v)", t.name, err))
			continue
		}
		addr := fmt.Sprintf("%s:%d", t.clusterIP, t.port)
		conn, err := dialer.DialContext(ctx, "tcp", addr)
		if err != nil {
			unreachable = append(unreachable, fmt.Sprintf("%s@%s (%v)", t.name, addr, err))
			continue
		}
		conn.Close()
	}
	return unreachable
}
