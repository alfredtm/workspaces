package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
)

// startStatus is what the workspace status endpoint reports while a pod
// comes up. State/Ready/Message are the basic fields; Phase/Reason/
// UnreadySeconds let the portal style a slow or troubled start without
// parsing the message.
type startStatus struct {
	// State: not_found | stopped | running | starting | failed.
	State string
	Ready bool
	// Message is the human stage line ("Preparing your disk…"). User-safe:
	// only mapped text or a bare Kubernetes reason word — never node names,
	// IPs or raw event messages.
	Message string
	// Phase is a coarse stage while unready: pending | scheduling | storage |
	// image | network | container | crash | booting. "" once ready/stopped.
	Phase string
	// Reason is the Kubernetes reason word behind Message (FailedAttachVolume,
	// ImagePullBackOff, …); "" while the pod is simply booting.
	Reason string
	// UnreadySeconds is how long the pod has been unready; 0 until a pod exists.
	UnreadySeconds int
}

// detail appends the UI-styleable start fields to a status response map, so
// each handler keeps its own keys (message vs msg) untouched.
func (s startStatus) detail(m map[string]any) map[string]any {
	m["phase"] = s.Phase
	m["reason"] = s.Reason
	m["unreadySeconds"] = s.UnreadySeconds
	return m
}

// startReason is the user-safe rendering of a Kubernetes reason word.
type startReason struct {
	phase string
	text  string
	// failed marks reasons the pod won't recover from on its own; the status
	// endpoint reports state "failed" for them (the loading page stops
	// promising a redirect).
	failed bool
}

const (
	storageText = "Storage is taking longer than usual to attach — still trying"
	imageText   = "The image is still downloading"
	crashText   = "The app keeps restarting"
	roomText    = "Waiting for room on the cluster"
	networkText = "Setting up networking is taking longer than usual"
)

// startReasons maps container waiting reasons and Warning event reasons to
// what a user should read. Anything not listed is rendered generically
// ("Still starting — the cluster reported <Reason>").
var startReasons = map[string]startReason{
	// Storage: CSI attach/mount stalls (a slow or stuck volume attach is a
	// common way to sit in ContainerCreating for 10+ min).
	"FailedAttachVolume": {phase: "storage", text: storageText},
	"FailedMount":        {phase: "storage", text: storageText},
	"FailedMapVolume":    {phase: "storage", text: storageText},
	// Image pulls.
	"ErrImagePull":     {phase: "image", text: imageText, failed: true},
	"ImagePullBackOff": {phase: "image", text: imageText, failed: true},
	// Crash loops: "BackOff" is the kubelet's event reason for the same thing.
	"CrashLoopBackOff": {phase: "crash", text: crashText, failed: true},
	"BackOff":          {phase: "crash", text: crashText},
	// Scheduling.
	"FailedScheduling": {phase: "scheduling", text: roomText},
	"Unschedulable":    {phase: "scheduling", text: roomText},
	// Pod sandbox / CNI.
	"FailedCreatePodSandBox": {phase: "network", text: networkText},
	"NetworkNotReady":        {phase: "network", text: networkText},
	// Container creation (missing secret/configmap, bad spec).
	"CreateContainerConfigError": {phase: "container", text: "The container could not be configured", failed: true},
	"CreateContainerError":       {phase: "container", text: "The container could not be created", failed: true},
}

// benignReasons are Warning events every healthy boot emits (startup probes
// failing while the editor loads); surfacing them would paint normal starts
// as problems.
var benignReasons = map[string]bool{
	"Unhealthy":     true,
	"ProbeWarning":  true,
	"FailedKillPod": true,
}

// eventFreshness bounds how old a Warning event may be and still describe
// the current start. Attach retries back off to several minutes apart, so
// this has to be generous; stale events from an earlier stage are filtered
// structurally (a FailedScheduling event is ignored once the pod is
// scheduled, storage/image events once containers are past Waiting).
const eventFreshness = 10 * time.Minute

// unreadyMentionAfter is when the message starts carrying "(N min)".
const unreadyMentionAfter = 2 * time.Minute

// workspaceStatus reports where a workspace pod is in its life cycle. Cheap
// on the happy paths (one Deployment GET); only an unready pod costs a Pods
// list and one Events list with a field selector.
func (c *config) workspaceStatus(ctx context.Context, ns, wsName string) startStatus {
	dep, err := c.k8s.AppsV1().Deployments(ns).Get(ctx, wsName, metav1.GetOptions{})
	if err != nil {
		return startStatus{State: "not_found", Message: "Workspace not found"}
	}
	if dep.Spec.Replicas != nil && *dep.Spec.Replicas == 0 {
		if dep.Annotations[startFailedAnnotation] != "" {
			// The stuck-start guard stopped it (lifecycle.go): say why, and
			// that the way out is simply to start it again.
			return startStatus{
				State:   "failed",
				Message: startFailedMessage(dep.Annotations[startFailedReasonAnnotation]),
				Reason:  startTimeoutReason,
			}
		}
		return startStatus{State: "stopped", Message: "Workspace is stopped"}
	}
	if dep.Status.ReadyReplicas > 0 {
		return startStatus{State: "running", Ready: true, Message: "Ready"}
	}
	// Not ready: look at the pod to distinguish "booting" from "stuck" or
	// "broken", so the card doesn't show "Starting…" forever.
	pods, err := c.k8s.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{
		LabelSelector: workspaceLabel + "=" + wsName,
	})
	if err != nil || len(pods.Items) == 0 {
		return startStatus{State: "starting", Message: "Starting workspace...", Phase: "pending"}
	}
	pod := newestPod(pods.Items)
	st := c.podStartStatus(ctx, ns, pod)
	unready := podUnreadyFor(pod, time.Now())
	st.UnreadySeconds = int(unready.Seconds())
	if unready > unreadyMentionAfter {
		st.Message += fmt.Sprintf(" (%d min)", int(unready.Minutes()))
	}
	return st
}

// podStartStatus classifies an unready pod. Order matters: current truth
// from the pod's own status first (scheduling condition, container waiting
// reasons), then a running editor container ("Almost there"), and only then
// the most recent Warning event — which is the sole signal while the pod
// sits in ContainerCreating waiting for its volume.
func (c *config) podStartStatus(ctx context.Context, ns string, pod *corev1.Pod) startStatus {
	scheduled := false
	for _, cond := range pod.Status.Conditions {
		if cond.Type != corev1.PodScheduled {
			continue
		}
		if cond.Status == corev1.ConditionTrue {
			scheduled = true
		} else if cond.Reason == corev1.PodReasonUnschedulable {
			r := startReasons["Unschedulable"]
			return startStatus{State: "failed", Message: r.text, Phase: r.phase, Reason: cond.Reason}
		}
	}
	statuses := append(append([]corev1.ContainerStatus{}, pod.Status.InitContainerStatuses...), pod.Status.ContainerStatuses...)
	anyWaiting := len(statuses) == 0
	workspaceRunning := false
	for _, cs := range statuses {
		if wait := cs.State.Waiting; wait != nil {
			anyWaiting = true
			if r, ok := startReasons[wait.Reason]; ok {
				state := "starting"
				if r.failed {
					state = "failed"
				}
				return startStatus{State: state, Message: r.text, Phase: r.phase, Reason: wait.Reason}
			}
		}
		if cs.Name == "workspace" && cs.State.Running != nil {
			workspaceRunning = true
		}
	}
	if workspaceRunning {
		return startStatus{State: "starting", Message: "Almost there — starting up...", Phase: "booting"}
	}
	if anyWaiting {
		if ev, ok := c.latestPodWarning(ctx, ns, pod, scheduled); ok {
			if r, known := startReasons[ev]; known {
				return startStatus{State: "starting", Message: r.text, Phase: r.phase, Reason: ev}
			}
			return startStatus{State: "starting", Message: "Still starting — the cluster reported " + ev, Phase: "pending", Reason: ev}
		}
	}
	// Pod exists but the container hasn't started: this window is dominated
	// by the ~20s CSI volume attach (plus a fast prepulled image pull).
	return startStatus{State: "starting", Message: "Preparing your disk...", Phase: "storage"}
}

// latestPodWarning returns the reason word of the freshest Warning event on
// the pod, or false when there is none worth showing. Only the reason word
// leaves this function: event messages carry node names, volume IDs and
// driver errors that users must not see.
func (c *config) latestPodWarning(ctx context.Context, ns string, pod *corev1.Pod, scheduled bool) (string, bool) {
	sel := fields.Set{
		"involvedObject.name": pod.Name,
		"involvedObject.kind": "Pod",
		"type":                corev1.EventTypeWarning,
	}.AsSelector().String()
	evs, err := c.k8s.CoreV1().Events(ns).List(ctx, metav1.ListOptions{FieldSelector: sel})
	if err != nil || len(evs.Items) == 0 {
		return "", false
	}
	items := evs.Items
	sort.Slice(items, func(i, j int) bool { return eventTime(items[i]).After(eventTime(items[j])) })
	cutoff := time.Now().Add(-eventFreshness)
	for _, e := range items {
		// Re-apply the selector client-side: fake clientsets ignore field
		// selectors, and the check is free.
		if e.Type != corev1.EventTypeWarning || e.InvolvedObject.Name != pod.Name {
			continue
		}
		if e.InvolvedObject.Kind != "" && e.InvolvedObject.Kind != "Pod" {
			continue
		}
		if eventTime(e).Before(cutoff) {
			// Sorted newest-first: nothing fresher follows.
			return "", false
		}
		reason := safeReason(e.Reason)
		if reason == "" || benignReasons[reason] {
			continue
		}
		if r, known := startReasons[reason]; known && r.phase == "scheduling" && scheduled {
			continue // scheduled since; that event describes an earlier stage
		}
		return reason, true
	}
	return "", false
}

// eventTime is the most recent moment an event describes, across the
// legacy and series-style timestamp fields.
func eventTime(e corev1.Event) time.Time {
	t := e.CreationTimestamp.Time
	for _, c := range []time.Time{e.LastTimestamp.Time, e.EventTime.Time, e.FirstTimestamp.Time} {
		if c.After(t) {
			t = c
		}
	}
	if e.Series != nil && e.Series.LastObservedTime.After(t) {
		t = e.Series.LastObservedTime.Time
	}
	return t
}

// safeReason keeps only the bare reason word: letters and digits, capped.
func safeReason(r string) string {
	var b strings.Builder
	for _, ch := range r {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') {
			b.WriteRune(ch)
		}
		if b.Len() >= 40 {
			break
		}
	}
	return b.String()
}

// podUnreadyFor is how long the pod has been unready: since its Ready
// condition last flipped to False when known, else since creation.
func podUnreadyFor(pod *corev1.Pod, now time.Time) time.Duration {
	since := pod.CreationTimestamp.Time
	for _, cond := range pod.Status.Conditions {
		if cond.Type == corev1.PodReady && cond.Status != corev1.ConditionTrue && !cond.LastTransitionTime.IsZero() {
			since = cond.LastTransitionTime.Time
		}
	}
	if since.IsZero() {
		return 0
	}
	d := now.Sub(since)
	if d < 0 {
		return 0
	}
	return d
}

// newestPod picks the pod a rollout is actually waiting on when an old
// replica is still terminating next to the new one.
func newestPod(pods []corev1.Pod) *corev1.Pod {
	best := &pods[0]
	for i := range pods[1:] {
		p := &pods[i+1]
		if p.CreationTimestamp.After(best.CreationTimestamp.Time) {
			best = p
		}
	}
	return best
}
