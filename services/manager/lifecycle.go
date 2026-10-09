package main

// Workspace lifecycle beyond auto-pause: the stuck-start guard and the idle
// retention policy. Both run on the auto-pause ticker (every 5 min), both
// are idempotent and safe across manager replicas, and both leave a paper
// trail in annotations so the portal can explain what happened.
//
// Stuck-start guard: a pod that has not become Ready within START_TIMEOUT of
// its creation is scaled to 0 and the Deployment annotated with when and why
// (the same user-safe reason text podStartStatus shows on the card). The
// alternative — leaving it in ContainerCreating retrying a volume attach for
// hours — burns quota, holds the PVC attachment and tells the user nothing.
//
// Retention: a workspace idle for IDLE_WARN_DAYS is annotated
// with a warning the portal renders; idle for IDLE_DELETE_DAYS it is deleted
// with the same path the user's own Delete button uses. Running pods are
// never deleted, whatever the timestamps say.

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// Lifecycle annotations on the workspace Deployment.
const (
	// startFailedAnnotation is the RFC3339 moment the stuck-start guard gave
	// up on the last start; startFailedReasonAnnotation the user-safe why.
	// Both are cleared on the next scale-up.
	startFailedAnnotation       = "workspaces.dev/start-failed"
	startFailedReasonAnnotation = "workspaces.dev/start-failed-reason"
	// idleWarningAnnotation is the RFC3339 moment the retention warning was
	// first set. Cleared as soon as activity moves again.
	idleWarningAnnotation = "workspaces.dev/idle-warning"
)

// startTimeoutReason is the Reason word the status endpoints report for a
// workspace the guard stopped, so the portal can tell it from a plain pause.
const startTimeoutReason = "StartTimeout"

const (
	defaultStartTimeout   = 10 * time.Minute
	defaultIdleWarnDays   = 7
	defaultIdleDeleteDays = 14
)

// startFailedMessage is the card line for a workspace the guard stopped.
func startFailedMessage(reason string) string {
	if reason == "" {
		reason = "the workspace did not become ready in time"
	}
	return "Couldn't start: " + reason + ". Try opening it again."
}

// shouldFailStart decides whether the stuck-start guard should give up on
// pod: the guard is enabled, the pod is not Ready, and it was created at
// least timeout ago. Pods that are Ready, younger than timeout, or already
// terminating are left alone.
func shouldFailStart(pod *corev1.Pod, now time.Time, timeout time.Duration) bool {
	if pod == nil || timeout <= 0 {
		return false
	}
	if pod.DeletionTimestamp != nil {
		return false
	}
	for _, cond := range pod.Status.Conditions {
		if cond.Type == corev1.PodReady && cond.Status == corev1.ConditionTrue {
			return false
		}
	}
	created := pod.CreationTimestamp.Time
	if created.IsZero() {
		return false
	}
	return now.Sub(created) >= timeout
}

// retentionDecision is what the retention policy wants done with an idle
// Deployment on this tick.
type retentionDecision int

const (
	retainNone retentionDecision = iota
	retainWarn
	retainDelete
)

func (d retentionDecision) String() string {
	switch d {
	case retainWarn:
		return "warn"
	case retainDelete:
		return "delete"
	default:
		return "none"
	}
}

// idleSince is the moment a Deployment was last used: the last-activity
// annotation when present and parseable, else its creation time. Zero when
// neither is known (an object with no creation timestamp — only in tests).
func idleSince(dep *appsv1.Deployment) time.Time {
	if v, err := time.Parse(time.RFC3339, dep.Annotations[activityAnnotation]); err == nil {
		return v
	}
	return dep.CreationTimestamp.Time
}

// idleDays is how many whole days dep has gone unused; 0 when unknown.
func idleDays(dep *appsv1.Deployment, now time.Time) int {
	since := idleSince(dep)
	if since.IsZero() || !now.After(since) {
		return 0
	}
	return int(now.Sub(since).Hours() / 24)
}

// retentionAction applies the idle policy to one Deployment. warnDays and
// deleteDays of 0 disable that step. A running Deployment (replicas > 0) is
// never touched: its activity is auto-pause's business, and deleting
// something that is up would be unforgivable.
func retentionAction(dep *appsv1.Deployment, now time.Time, warnDays, deleteDays int) retentionDecision {
	if dep.Spec.Replicas != nil && *dep.Spec.Replicas > 0 {
		return retainNone
	}
	since := idleSince(dep)
	if since.IsZero() {
		return retainNone
	}
	idle := now.Sub(since)
	if deleteDays > 0 && idle >= time.Duration(deleteDays)*24*time.Hour {
		return retainDelete
	}
	if warnDays > 0 && idle >= time.Duration(warnDays)*24*time.Hour {
		return retainWarn
	}
	return retainNone
}

// sweepLifecycle is one tick of the stuck-start guard and the retention
// policy over every managed Deployment in the workspace namespace.
func (c *config) sweepLifecycle() {
	if c.startTimeout <= 0 && c.idleWarnDays <= 0 && c.idleDeleteDays <= 0 {
		return
	}
	ctx := context.Background()
	deps, err := c.k8s.AppsV1().Deployments(c.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: managedSelector,
	})
	if err != nil {
		slog.Warn("lifecycle: list deployments", "err", err)
		return
	}
	now := time.Now()
	for i := range deps.Items {
		dep := &deps.Items[i]
		if dep.Spec.Replicas != nil && *dep.Spec.Replicas > 0 {
			if dep.Status.ReadyReplicas == 0 {
				c.guardStuckStart(ctx, dep, now)
			}
			continue
		}
		c.applyRetention(ctx, dep, now)
	}
}

// guardStuckStart checks one scaled-up, unready Deployment against
// START_TIMEOUT and stops it when its pod has been failing to start for
// too long.
func (c *config) guardStuckStart(ctx context.Context, dep *appsv1.Deployment, now time.Time) {
	if c.startTimeout <= 0 {
		return
	}
	pods, err := c.k8s.CoreV1().Pods(dep.Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: workspaceLabel + "=" + dep.Name,
	})
	if err != nil || len(pods.Items) == 0 {
		return // no pod yet: the ReplicaSet controller has not caught up
	}
	pod := newestPod(pods.Items)
	if !shouldFailStart(pod, now, c.startTimeout) {
		return
	}
	reason := c.podStartStatus(ctx, dep.Namespace, pod).Message
	patch := fmt.Sprintf(`{"spec":{"replicas":0},"metadata":{"annotations":{%q:%q,%q:%q}}}`,
		startFailedAnnotation, now.UTC().Format(time.RFC3339),
		startFailedReasonAnnotation, reason)
	if _, err := c.k8s.AppsV1().Deployments(dep.Namespace).Patch(ctx, dep.Name,
		types.MergePatchType, []byte(patch), metav1.PatchOptions{}); err != nil {
		slog.Warn("lifecycle: stop stuck start", "namespace", dep.Namespace, "name", dep.Name, "err", err)
		return
	}
	slog.Info("stopped workspace that failed to start",
		"namespace", dep.Namespace, "name", dep.Name, "reason", reason,
		"pod_age_min", int(now.Sub(pod.CreationTimestamp.Time).Minutes()))
}

// applyRetention warns, un-warns or deletes one paused Deployment according
// to how long it has been idle.
func (c *config) applyRetention(ctx context.Context, dep *appsv1.Deployment, now time.Time) {
	warned := dep.Annotations[idleWarningAnnotation] != ""
	switch retentionAction(dep, now, c.idleWarnDays, c.idleDeleteDays) {
	case retainDelete:
		user := first(dep.Annotations[ownerUPNAnnotation], dep.Labels[userLabel])
		slog.Info("deleting idle workspace",
			"namespace", dep.Namespace, "name", dep.Name, "user", user,
			"idle_days", idleDays(dep, now))
		if err := c.deleteWorkspace(ctx, dep.Namespace, dep.Name, user); err != nil {
			slog.Warn("lifecycle: delete idle workspace", "namespace", dep.Namespace, "name", dep.Name, "err", err)
		}
	case retainWarn:
		if warned {
			return
		}
		c.patchAnnotation(ctx, dep, idleWarningAnnotation, now.UTC().Format(time.RFC3339))
		slog.Info("idle workspace warned", "namespace", dep.Namespace, "name", dep.Name, "idle_days", idleDays(dep, now))
	default:
		if warned {
			// Used again since the warning: drop it so the card goes quiet.
			c.patchAnnotation(ctx, dep, idleWarningAnnotation, "")
		}
	}
}

// patchAnnotation sets (or, with an empty value, removes) one annotation on
// a Deployment with a merge patch. Best effort: failures are logged and the
// next tick retries.
func (c *config) patchAnnotation(ctx context.Context, dep *appsv1.Deployment, key, value string) {
	val := "null"
	if value != "" {
		val = strconv.Quote(value)
	}
	patch := fmt.Sprintf(`{"metadata":{"annotations":{%q:%s}}}`, key, val)
	if _, err := c.k8s.AppsV1().Deployments(dep.Namespace).Patch(ctx, dep.Name,
		types.MergePatchType, []byte(patch), metav1.PatchOptions{}); err != nil {
		slog.Warn("lifecycle: patch annotation", "namespace", dep.Namespace, "name", dep.Name, "key", key, "err", err)
	}
}

// clearLifecycleAnnotations drops the start-failed and idle-warning marks
// from an in-memory Deployment; callers that scale up do this right before
// their Update so the card flips from "Couldn't start" / "Unused for N days"
// the moment the user acts, not on the next tick.
func clearLifecycleAnnotations(dep *appsv1.Deployment) {
	delete(dep.Annotations, startFailedAnnotation)
	delete(dep.Annotations, startFailedReasonAnnotation)
	delete(dep.Annotations, idleWarningAnnotation)
}

// lifecycleOut is the retention/start-failure view of a Deployment the list
// endpoints embed, so the portal can render a warning or a failed start
// without an extra request per card.
type lifecycleOut struct {
	// StartFailed is the card line when the stuck-start guard stopped the
	// last start; "" otherwise.
	StartFailed string `json:"startFailed"`
	// IdleDays is whole days since last activity (0 when unknown).
	IdleDays int `json:"idleDays"`
	// IdleWarning is true once the retention warning has been set.
	IdleWarning bool `json:"idleWarning"`
	// DeleteAfterDays is the configured IDLE_DELETE_DAYS; 0 = never.
	DeleteAfterDays int `json:"deleteAfterDays"`
}

func (c *config) lifecycleFields(dep *appsv1.Deployment, now time.Time) lifecycleOut {
	out := lifecycleOut{
		IdleDays:        idleDays(dep, now),
		IdleWarning:     dep.Annotations[idleWarningAnnotation] != "",
		DeleteAfterDays: c.idleDeleteDays,
	}
	if dep.Annotations[startFailedAnnotation] != "" {
		out.StartFailed = startFailedMessage(dep.Annotations[startFailedReasonAnnotation])
	}
	return out
}

// envDuration reads a Go duration ("10m", "1h30m"); "0" is a valid value
// (callers treat it as "disabled"). Unparseable values fall back with a
// warning.
func envDuration(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		if n, aerr := strconv.Atoi(v); aerr == nil && n == 0 {
			return 0
		}
		slog.Warn("ignoring invalid duration env var", "key", key, "value", v)
		return fallback
	}
	if d < 0 {
		slog.Warn("ignoring negative duration env var", "key", key, "value", v)
		return fallback
	}
	return d
}

// envIntOrZero is envInt that also accepts 0 (meaning "disabled").
func envIntOrZero(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		slog.Warn("ignoring invalid integer env var", "key", key, "value", v)
		return fallback
	}
	return n
}
