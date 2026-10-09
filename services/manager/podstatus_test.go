package main

import (
	"context"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	k8sfake "k8s.io/client-go/kubernetes/fake"
)

// rawAttachMessage is what a CSI attacher really emits: node, volume ID and
// driver error. None of it may reach a user.
const rawAttachMessage = `AttachVolume.Attach failed for volume "pvc-13ea177a-670b-41a9-ab9a-c3b047efed4e" : timed out waiting for external-attacher of csi.example.com CSI driver to attach volume on node worker-3 (10.42.0.7)`

func stuckPodFixture(unreadyFor time.Duration, waiting string) (*appsv1.Deployment, *corev1.Pod) {
	one := int32(1)
	since := metav1.NewTime(time.Now().Add(-unreadyFor))
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "ws-tara-holter-polar-meadow", Namespace: testNamespace},
		Spec:       appsv1.DeploymentSpec{Replicas: &one},
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:              "ws-tara-holter-polar-meadow-66b8c99cb7-5vbfm",
			Namespace:         testNamespace,
			Labels:            map[string]string{workspaceLabel: dep.Name},
			CreationTimestamp: since,
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodPending,
			Conditions: []corev1.PodCondition{
				{Type: corev1.PodScheduled, Status: corev1.ConditionTrue},
				{Type: corev1.PodReady, Status: corev1.ConditionFalse, LastTransitionTime: since},
			},
			ContainerStatuses: []corev1.ContainerStatus{
				{Name: "workspace", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: waiting}}},
				{Name: "postgres", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: waiting}}},
			},
		},
	}
	return dep, pod
}

func warningEvent(pod *corev1.Pod, reason, message string, age time.Duration) *corev1.Event {
	ts := metav1.NewTime(time.Now().Add(-age))
	return &corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{Name: pod.Name + "." + reason + age.String(), Namespace: pod.Namespace, CreationTimestamp: ts},
		InvolvedObject: corev1.ObjectReference{Kind: "Pod", Name: pod.Name, Namespace: pod.Namespace},
		Type:           corev1.EventTypeWarning,
		Reason:         reason,
		Message:        message,
		FirstTimestamp: ts,
		LastTimestamp:  ts,
	}
}

func statusFor(t *testing.T, objs ...runtime.Object) startStatus {
	t.Helper()
	c := &config{k8s: k8sfake.NewSimpleClientset(objs...)}
	return c.workspaceStatus(context.Background(), testNamespace, "ws-tara-holter-polar-meadow")
}

func TestWorkspaceStatusSurfacesAttachWarning(t *testing.T) {
	dep, pod := stuckPodFixture(13*time.Minute, "ContainerCreating")
	st := statusFor(t, dep, pod,
		warningEvent(pod, "FailedAttachVolume", rawAttachMessage, 30*time.Second),
		warningEvent(pod, "FailedScheduling", "0/7 nodes are available", 12*time.Minute), // stale + scheduled since
	)
	if st.State != "starting" || st.Ready {
		t.Fatalf("state = %q ready=%v, want starting/false", st.State, st.Ready)
	}
	if st.Reason != "FailedAttachVolume" || st.Phase != "storage" {
		t.Errorf("reason/phase = %q/%q", st.Reason, st.Phase)
	}
	if !strings.HasPrefix(st.Message, storageText) || !strings.HasSuffix(st.Message, "(13 min)") {
		t.Errorf("message = %q", st.Message)
	}
	if st.UnreadySeconds < 13*60 || st.UnreadySeconds > 13*60+5 {
		t.Errorf("unreadySeconds = %d", st.UnreadySeconds)
	}
	for _, leak := range []string{"pvc-", "worker-3", "10.42", "csi.example.com", "external-attacher"} {
		if strings.Contains(st.Message, leak) {
			t.Errorf("message leaks %q: %s", leak, st.Message)
		}
	}
}

func TestWorkspaceStatusQuietWhileBooting(t *testing.T) {
	// A fresh pod with only benign probe noise reads as a calm start, with
	// no reason and no minute counter yet.
	dep, pod := stuckPodFixture(40*time.Second, "ContainerCreating")
	st := statusFor(t, dep, pod, warningEvent(pod, "Unhealthy", "startup probe failed", 5*time.Second))
	if st.State != "starting" || st.Reason != "" || st.Message != "Preparing your disk..." {
		t.Errorf("got %+v", st)
	}
}

func TestWorkspaceStatusIgnoresStaleEvents(t *testing.T) {
	dep, pod := stuckPodFixture(3*time.Minute, "ContainerCreating")
	st := statusFor(t, dep, pod, warningEvent(pod, "FailedAttachVolume", rawAttachMessage, 25*time.Minute))
	if st.Reason != "" || st.Message != "Preparing your disk... (3 min)" {
		t.Errorf("got %+v", st)
	}
}

func TestWorkspaceStatusUnknownReasonIsBareWord(t *testing.T) {
	dep, pod := stuckPodFixture(5*time.Minute, "ContainerCreating")
	st := statusFor(t, dep, pod, warningEvent(pod, "SomethingOdd", "node worker-1: boom", time.Minute))
	want := "Still starting — the cluster reported SomethingOdd (5 min)"
	if st.Message != want || st.Reason != "SomethingOdd" {
		t.Errorf("got %+v, want message %q", st, want)
	}
}

func TestWorkspaceStatusWaitingReasonBeatsEvents(t *testing.T) {
	dep, pod := stuckPodFixture(time.Minute, "ImagePullBackOff")
	st := statusFor(t, dep, pod, warningEvent(pod, "FailedAttachVolume", rawAttachMessage, 10*time.Second))
	if st.State != "failed" || st.Reason != "ImagePullBackOff" || st.Phase != "image" || st.Message != imageText {
		t.Errorf("got %+v", st)
	}
}

func TestWorkspaceStatusHappyPathsUnchanged(t *testing.T) {
	dep, _ := stuckPodFixture(0, "")
	dep.Status.ReadyReplicas = 1
	if st := statusFor(t, dep); !st.Ready || st.State != "running" || st.Message != "Ready" || st.UnreadySeconds != 0 {
		t.Errorf("running: %+v", st)
	}
	zero := int32(0)
	dep.Spec.Replicas = &zero
	dep.Status.ReadyReplicas = 0
	if st := statusFor(t, dep); st.State != "stopped" || st.Message != "Workspace is stopped" {
		t.Errorf("stopped: %+v", st)
	}
	if st := statusFor(t); st.State != "not_found" {
		t.Errorf("missing: %+v", st)
	}
	m := startStatus{Phase: "storage", Reason: "FailedMount", UnreadySeconds: 200}.detail(map[string]any{"msg": "x"})
	if m["msg"] != "x" || m["phase"] != "storage" || m["reason"] != "FailedMount" || m["unreadySeconds"] != 200 {
		t.Errorf("detail: %v", m)
	}
}
