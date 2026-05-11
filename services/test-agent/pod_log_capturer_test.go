package main

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
)

func TestResolveItemName(t *testing.T) {
	urlMap := map[string]URLMapEntry{
		"api-server": {Name: "api-server", InstanceItemID: "id-1"},
		"no-name":    {Name: "", InstanceItemID: "id-2"},
	}
	dbMap := map[string]DatabaseInfo{
		"postgres": {InstanceItemID: "id-3"},
	}

	tests := []struct {
		appLabel string
		want     string
	}{
		{"api-server", "api-server"},
		{"no-name", "no-name"}, // falls back to appLabel when Name is empty
		{"postgres", "postgres"},
		{"unknown", ""},
		{"", ""},
	}

	for _, tt := range tests {
		got := resolveItemName(tt.appLabel, urlMap, dbMap)
		if got != tt.want {
			t.Errorf("resolveItemName(%q) = %q, want %q", tt.appLabel, got, tt.want)
		}
	}
}

func TestExtractWaitingReason(t *testing.T) {
	tests := []struct {
		name string
		cs   corev1.ContainerStatus
		want string
	}{
		{
			name: "no waiting state",
			cs:   corev1.ContainerStatus{},
			want: "",
		},
		{
			name: "reason only",
			cs: corev1.ContainerStatus{
				State: corev1.ContainerState{
					Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"},
				},
			},
			want: "CrashLoopBackOff",
		},
		{
			name: "reason with message",
			cs: corev1.ContainerStatus{
				State: corev1.ContainerState{
					Waiting: &corev1.ContainerStateWaiting{
						Reason:  "ErrImagePull",
						Message: "manifest unknown",
					},
				},
			},
			want: "ErrImagePull: manifest unknown",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractWaitingReason(&tt.cs)
			if got != tt.want {
				t.Errorf("extractWaitingReason() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestExtractTerminationReason(t *testing.T) {
	tests := []struct {
		name string
		cs   corev1.ContainerStatus
		want string
	}{
		{
			name: "no termination",
			cs:   corev1.ContainerStatus{},
			want: "",
		},
		{
			name: "current terminated state",
			cs: corev1.ContainerStatus{
				State: corev1.ContainerState{
					Terminated: &corev1.ContainerStateTerminated{
						Reason:   "OOMKilled",
						ExitCode: 137,
					},
				},
			},
			want: "OOMKilled — exit code 137",
		},
		{
			name: "last terminated state (crash loop)",
			cs: corev1.ContainerStatus{
				LastTerminationState: corev1.ContainerState{
					Terminated: &corev1.ContainerStateTerminated{
						Reason:   "Error",
						ExitCode: 1,
					},
				},
			},
			want: "Error — exit code 1",
		},
		{
			name: "current takes precedence over last",
			cs: corev1.ContainerStatus{
				State: corev1.ContainerState{
					Terminated: &corev1.ContainerStateTerminated{
						Reason:   "OOMKilled",
						ExitCode: 137,
					},
				},
				LastTerminationState: corev1.ContainerState{
					Terminated: &corev1.ContainerStateTerminated{
						Reason:   "Error",
						ExitCode: 1,
					},
				},
			},
			want: "OOMKilled — exit code 137",
		},
		{
			name: "exit code 0 is excluded",
			cs: corev1.ContainerStatus{
				State: corev1.ContainerState{
					Terminated: &corev1.ContainerStateTerminated{
						Reason:   "Completed",
						ExitCode: 0,
					},
				},
			},
			want: "Completed",
		},
		{
			name: "message only",
			cs: corev1.ContainerStatus{
				State: corev1.ContainerState{
					Terminated: &corev1.ContainerStateTerminated{
						ExitCode: 0,
						Message:  "some detail",
					},
				},
			},
			want: "some detail",
		},
		{
			name: "all empty with exit code 0",
			cs: corev1.ContainerStatus{
				State: corev1.ContainerState{
					Terminated: &corev1.ContainerStateTerminated{
						ExitCode: 0,
					},
				},
			},
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractTerminationReason(&tt.cs)
			if got != tt.want {
				t.Errorf("extractTerminationReason() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestFormatPodLogMessage(t *testing.T) {
	entry := PodLogEntry{
		ItemName:          "api-server",
		PodName:           "api-server-abc123",
		ContainerName:     "api-server",
		WaitingReason:     "CrashLoopBackOff",
		TerminationReason: "Error — exit code 1",
		PreviousLogs:      "previous output\n",
		Logs:              "current output\n",
	}

	result := FormatPodLogMessage(entry)

	// Check header
	if !contains(result, "[item:api-server]") {
		t.Error("missing item tag")
	}
	if !contains(result, "[pod:api-server-abc123]") {
		t.Error("missing pod tag")
	}
	if !contains(result, "[container:api-server]") {
		t.Error("missing container tag")
	}
	if !contains(result, "Waiting reason: CrashLoopBackOff") {
		t.Error("missing waiting reason")
	}
	if !contains(result, "Termination reason: Error — exit code 1") {
		t.Error("missing termination reason")
	}
	if !contains(result, "Previous Container Logs") {
		t.Error("missing previous logs section")
	}
	if !contains(result, "Current Container Logs") {
		t.Error("missing current logs section")
	}
}

func TestFormatPodLogMessage_NoLogs(t *testing.T) {
	entry := PodLogEntry{
		ItemName:      "broken",
		PodName:       "broken-xyz",
		ContainerName: "broken",
		WaitingReason: "ErrImagePull",
	}

	result := FormatPodLogMessage(entry)

	if !contains(result, "(no container logs available)") {
		t.Error("missing 'no container logs' message")
	}
}

func TestIsDokkimiSidecar(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"interceptor", true},
		{"interceptor-proxy", true},
		{"fluent-bit", true},
		{"ca-bundle", true},
		{"api-server", false},
		{"my-service", false},
	}

	for _, tt := range tests {
		got := isDokkimiSidecar(tt.name)
		if got != tt.want {
			t.Errorf("isDokkimiSidecar(%q) = %v, want %v", tt.name, got, tt.want)
		}
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && searchString(s, substr)
}

func searchString(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
