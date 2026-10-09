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

func TestShouldFailStart(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	pod := func(age time.Duration, ready bool, terminating bool) *corev1.Pod {
		p := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{CreationTimestamp: metav1.NewTime(now.Add(-age))}}
		status := corev1.ConditionFalse
		if ready {
			status = corev1.ConditionTrue
		}
		p.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: status}}
		if terminating {
			ts := metav1.NewTime(now)
			p.DeletionTimestamp = &ts
		}
		return p
	}
	cases := []struct {
		name    string
		pod     *corev1.Pod
		timeout time.Duration
		want    bool
	}{
		{"nil pod", nil, 10 * time.Minute, false},
		{"disabled (timeout 0)", pod(time.Hour, false, false), 0, false},
		{"fresh unready pod", pod(3*time.Minute, false, false), 10 * time.Minute, false},
		{"just under the timeout", pod(10*time.Minute-time.Second, false, false), 10 * time.Minute, false},
		{"exactly at the timeout", pod(10*time.Minute, false, false), 10 * time.Minute, true},
		{"stuck for hours", pod(3*time.Hour, false, false), 10 * time.Minute, true},
		{"old but ready", pod(3*time.Hour, true, false), 10 * time.Minute, false},
		{"old, unready, terminating", pod(3*time.Hour, false, true), 10 * time.Minute, false},
		{"no creation timestamp", &corev1.Pod{}, 10 * time.Minute, false},
		{"no Ready condition at all (Pending)", &corev1.Pod{ObjectMeta: metav1.ObjectMeta{CreationTimestamp: metav1.NewTime(now.Add(-time.Hour))}}, 10 * time.Minute, true},
	}
	for _, tc := range cases {
		if got := shouldFailStart(tc.pod, now, tc.timeout); got != tc.want {
			t.Errorf("%s: shouldFailStart = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestRetentionAction(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	day := 24 * time.Hour
	dep := func(replicas int32, lastActivity time.Time, created time.Time) *appsv1.Deployment {
		d := &appsv1.Deployment{
			ObjectMeta: metav1.ObjectMeta{Annotations: map[string]string{}},
			Spec:       appsv1.DeploymentSpec{Replicas: &replicas},
		}
		if !lastActivity.IsZero() {
			d.Annotations[activityAnnotation] = lastActivity.UTC().Format(time.RFC3339)
		}
		if !created.IsZero() {
			d.CreationTimestamp = metav1.NewTime(created)
		}
		return d
	}
	cases := []struct {
		name       string
		dep        *appsv1.Deployment
		warn, del  int
		want       retentionDecision
		wantIdleDs int
	}{
		{"fresh", dep(0, now.Add(-time.Hour), now.Add(-30*day)), 7, 14, retainNone, 0},
		{"idle 6d", dep(0, now.Add(-6*day), time.Time{}), 7, 14, retainNone, 6},
		{"idle exactly 7d", dep(0, now.Add(-7*day), time.Time{}), 7, 14, retainWarn, 7},
		{"idle 13d", dep(0, now.Add(-13*day-time.Hour), time.Time{}), 7, 14, retainWarn, 13},
		{"idle exactly 14d", dep(0, now.Add(-14*day), time.Time{}), 7, 14, retainDelete, 14},
		{"idle 40d", dep(0, now.Add(-40*day), time.Time{}), 7, 14, retainDelete, 40},
		{"running, idle 40d: never touched", dep(1, now.Add(-40*day), time.Time{}), 7, 14, retainNone, 40},
		{"no annotation: falls back to creation, 8d", dep(0, time.Time{}, now.Add(-8*day)), 7, 14, retainWarn, 8},
		{"no annotation: falls back to creation, 20d", dep(0, time.Time{}, now.Add(-20*day)), 7, 14, retainDelete, 20},
		{"no annotation, no creation timestamp", dep(0, time.Time{}, time.Time{}), 7, 14, retainNone, 0},
		{"garbage annotation falls back to creation", func() *appsv1.Deployment {
			d := dep(0, time.Time{}, now.Add(-9*day))
			d.Annotations[activityAnnotation] = "yesterday-ish"
			return d
		}(), 7, 14, retainWarn, 9},
		{"warn disabled, delete on", dep(0, now.Add(-10*day), time.Time{}), 0, 14, retainNone, 10},
		{"warn disabled, delete on, past delete", dep(0, now.Add(-15*day), time.Time{}), 0, 14, retainDelete, 15},
		{"delete disabled, warn on", dep(0, now.Add(-100*day), time.Time{}), 7, 0, retainWarn, 100},
		{"both disabled", dep(0, now.Add(-100*day), time.Time{}), 0, 0, retainNone, 100},
		{"nil replicas counts as paused", &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{
			Annotations: map[string]string{activityAnnotation: now.Add(-20 * day).Format(time.RFC3339)},
		}}, 7, 14, retainDelete, 20},
	}
	for _, tc := range cases {
		if got := retentionAction(tc.dep, now, tc.warn, tc.del); got != tc.want {
			t.Errorf("%s: retentionAction = %s, want %s", tc.name, got, tc.want)
		}
		if got := idleDays(tc.dep, now); got != tc.wantIdleDs {
			t.Errorf("%s: idleDays = %d, want %d", tc.name, got, tc.wantIdleDs)
		}
	}
}

// lifecycleDep is a paused or running managed Deployment in the workspace
// namespace.
func lifecycleDep(name string, replicas int32, lastActivity time.Time) *appsv1.Deployment {
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:              name,
			Namespace:         testNamespace,
			Labels:            workspaceLabels("tara-holter", name),
			CreationTimestamp: metav1.NewTime(time.Now().Add(-60 * 24 * time.Hour)),
			Annotations: map[string]string{
				activityAnnotation: lastActivity.UTC().Format(time.RFC3339),
				ownerUPNAnnotation: "tara.holter@example.com",
			},
		},
		Spec: appsv1.DeploymentSpec{Replicas: &replicas},
	}
}

func lifecycleConfig(objs ...runtime.Object) *config {
	return &config{
		k8s:            k8sfake.NewSimpleClientset(objs...),
		namespace:      testNamespace,
		lastActivity:   map[string]time.Time{},
		lastPersisted:  map[string]time.Time{},
		ownership:      map[string]time.Time{},
		startTimeout:   10 * time.Minute,
		idleWarnDays:   7,
		idleDeleteDays: 14,
	}
}

func TestSweepLifecycleStopsStuckStart(t *testing.T) {
	stuckDep, stuckPod := stuckPodFixture(25*time.Minute, "ContainerCreating")
	stuckDep.Labels = workspaceLabels("tara-holter", stuckDep.Name)
	freshDep, freshPod := stuckPodFixture(2*time.Minute, "ContainerCreating")
	freshDep.Name, freshPod.Name = "ws-tara-holter-fresh", "ws-tara-holter-fresh-abc"
	freshPod.Labels[workspaceLabel] = freshDep.Name
	freshDep.Labels = workspaceLabels("tara-holter", freshDep.Name)

	c := lifecycleConfig(stuckDep, stuckPod, freshDep, freshPod,
		warningEvent(stuckPod, "FailedAttachVolume", rawAttachMessage, 30*time.Second))
	c.sweepLifecycle()
	ctx := context.Background()

	got, err := c.k8s.AppsV1().Deployments(testNamespace).Get(ctx, stuckDep.Name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Spec.Replicas == nil || *got.Spec.Replicas != 0 {
		t.Errorf("stuck deployment not scaled to 0: %v", got.Spec.Replicas)
	}
	if _, err := time.Parse(time.RFC3339, got.Annotations[startFailedAnnotation]); err != nil {
		t.Errorf("start-failed annotation = %q, want RFC3339", got.Annotations[startFailedAnnotation])
	}
	if got.Annotations[startFailedReasonAnnotation] != storageText {
		t.Errorf("start-failed-reason = %q, want %q", got.Annotations[startFailedReasonAnnotation], storageText)
	}
	// The status endpoint now explains it instead of saying "stopped".
	st := c.workspaceStatus(ctx, testNamespace, stuckDep.Name)
	if st.State != "failed" || st.Reason != startTimeoutReason || !strings.HasPrefix(st.Message, "Couldn't start: "+storageText) {
		t.Errorf("status after guard = %+v", st)
	}
	if !strings.HasSuffix(st.Message, "Try opening it again.") {
		t.Errorf("message lacks the call to action: %q", st.Message)
	}

	fresh, err := c.k8s.AppsV1().Deployments(testNamespace).Get(ctx, freshDep.Name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if *fresh.Spec.Replicas != 1 || fresh.Annotations[startFailedAnnotation] != "" {
		t.Errorf("fresh deployment should be untouched: replicas=%d ann=%v", *fresh.Spec.Replicas, fresh.Annotations)
	}

	// Starting it again clears the mark.
	if err := c.scaleWorkspace(ctx, testNamespace, stuckDep.Name, 1); err != nil {
		t.Fatal(err)
	}
	got, _ = c.k8s.AppsV1().Deployments(testNamespace).Get(ctx, stuckDep.Name, metav1.GetOptions{})
	if got.Annotations[startFailedAnnotation] != "" || got.Annotations[startFailedReasonAnnotation] != "" {
		t.Errorf("scale-up did not clear start-failed annotations: %v", got.Annotations)
	}
}

func TestSweepLifecycleGuardDisabled(t *testing.T) {
	dep, pod := stuckPodFixture(3*time.Hour, "ContainerCreating")
	dep.Labels = workspaceLabels("tara-holter", dep.Name)
	c := lifecycleConfig(dep, pod)
	c.startTimeout = 0
	c.sweepLifecycle()
	got, _ := c.k8s.AppsV1().Deployments(testNamespace).Get(context.Background(), dep.Name, metav1.GetOptions{})
	if *got.Spec.Replicas != 1 || got.Annotations[startFailedAnnotation] != "" {
		t.Errorf("START_TIMEOUT=0 must disable the guard: %v", got)
	}
}

func TestSweepLifecycleRetention(t *testing.T) {
	now := time.Now()
	day := 24 * time.Hour
	active := lifecycleDep("ws-tara-holter-active", 0, now.Add(-2*day))
	warnMe := lifecycleDep("ws-tara-holter-warn", 0, now.Add(-8*day))
	deleteMe := lifecycleDep("ws-tara-holter-gone", 0, now.Add(-15*day))
	runningOld := lifecycleDep("ws-tara-holter-running", 1, now.Add(-30*day))
	runningOld.Status.ReadyReplicas = 1
	// Not ours: no managed-by label, so retention must leave it alone.
	foreignOld := lifecycleDep("someone-elses-app", 0, now.Add(-30*day))
	foreignOld.Labels = map[string]string{"app": "other"}
	unwarn := lifecycleDep("ws-tara-holter-back", 0, now.Add(-time.Hour))
	unwarn.Annotations[idleWarningAnnotation] = now.Add(-day).UTC().Format(time.RFC3339)
	alreadyWarned := lifecycleDep("ws-tara-holter-warned", 0, now.Add(-9*day))
	firstWarning := now.Add(-2 * day).UTC().Format(time.RFC3339)
	alreadyWarned.Annotations[idleWarningAnnotation] = firstWarning

	c := lifecycleConfig(active, warnMe, deleteMe, runningOld, foreignOld, unwarn, alreadyWarned,
		&corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: deleteMe.Name, Namespace: testNamespace}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: deleteMe.Name, Namespace: testNamespace}},
	)
	c.sweepLifecycle()
	ctx := context.Background()
	get := func(name string) (*appsv1.Deployment, error) {
		return c.k8s.AppsV1().Deployments(testNamespace).Get(ctx, name, metav1.GetOptions{})
	}

	if d, err := get(active.Name); err != nil || d.Annotations[idleWarningAnnotation] != "" {
		t.Errorf("active: err=%v ann=%v", err, d.Annotations)
	}
	if d, err := get(warnMe.Name); err != nil {
		t.Errorf("warned deployment must survive: %v", err)
	} else if _, perr := time.Parse(time.RFC3339, d.Annotations[idleWarningAnnotation]); perr != nil {
		t.Errorf("idle-warning = %q, want RFC3339", d.Annotations[idleWarningAnnotation])
	} else if f := c.lifecycleFields(d, now); !f.IdleWarning || f.IdleDays != 8 || f.DeleteAfterDays != 14 {
		t.Errorf("lifecycleFields = %+v", f)
	}
	if d, err := get(alreadyWarned.Name); err != nil || d.Annotations[idleWarningAnnotation] != firstWarning {
		t.Errorf("existing warning timestamp must be kept: err=%v ann=%v", err, d.Annotations)
	}
	if _, err := get(deleteMe.Name); !isNotFound(err) {
		t.Errorf("15d idle workspace should be deleted, got err=%v", err)
	}
	if _, err := c.k8s.CoreV1().PersistentVolumeClaims(testNamespace).Get(ctx, deleteMe.Name, metav1.GetOptions{}); !isNotFound(err) {
		t.Errorf("PVC should go with the workspace, got err=%v", err)
	}
	if _, err := c.k8s.CoreV1().Services(testNamespace).Get(ctx, deleteMe.Name, metav1.GetOptions{}); !isNotFound(err) {
		t.Errorf("Service should go with the workspace, got err=%v", err)
	}
	if d, err := get(runningOld.Name); err != nil || *d.Spec.Replicas != 1 || d.Annotations[idleWarningAnnotation] != "" {
		t.Errorf("running deployment must never be warned or deleted: err=%v dep=%v", err, d)
	}
	if _, err := get(foreignOld.Name); err != nil {
		t.Errorf("unmanaged deployments are out of scope: %v", err)
	}
	if d, err := get(unwarn.Name); err != nil || d.Annotations[idleWarningAnnotation] != "" {
		t.Errorf("warning must clear once activity moves: err=%v ann=%v", err, d.Annotations)
	}
}

func TestSweepLifecycleRetentionDisabled(t *testing.T) {
	now := time.Now()
	old := lifecycleDep("ws-tara-holter-ancient", 0, now.Add(-400*24*time.Hour))
	c := lifecycleConfig(old)
	c.idleWarnDays, c.idleDeleteDays = 0, 0
	c.sweepLifecycle()
	d, err := c.k8s.AppsV1().Deployments(testNamespace).Get(context.Background(), old.Name, metav1.GetOptions{})
	if err != nil || d.Annotations[idleWarningAnnotation] != "" {
		t.Errorf("0/0 must disable retention: err=%v ann=%v", err, d.Annotations)
	}
	if f := c.lifecycleFields(d, now); f.DeleteAfterDays != 0 || f.IdleWarning || f.IdleDays != 400 {
		t.Errorf("lifecycleFields = %+v", f)
	}
}

func TestStartFailedMessage(t *testing.T) {
	if got := startFailedMessage(storageText); got != "Couldn't start: "+storageText+". Try opening it again." {
		t.Errorf("got %q", got)
	}
	if got := startFailedMessage(""); !strings.HasPrefix(got, "Couldn't start: ") || !strings.HasSuffix(got, "Try opening it again.") {
		t.Errorf("empty reason: %q", got)
	}
}

func TestLifecycleEnvHelpers(t *testing.T) {
	t.Setenv("LC_TEST_DUR", "0")
	if got := envDuration("LC_TEST_DUR", time.Minute); got != 0 {
		t.Errorf("\"0\" should disable: %v", got)
	}
	t.Setenv("LC_TEST_DUR", "15m")
	if got := envDuration("LC_TEST_DUR", time.Minute); got != 15*time.Minute {
		t.Errorf("15m: %v", got)
	}
	t.Setenv("LC_TEST_DUR", "soon")
	if got := envDuration("LC_TEST_DUR", time.Minute); got != time.Minute {
		t.Errorf("garbage should fall back: %v", got)
	}
	t.Setenv("LC_TEST_DUR", "")
	if got := envDuration("LC_TEST_DUR", time.Minute); got != time.Minute {
		t.Errorf("unset should fall back: %v", got)
	}
	t.Setenv("LC_TEST_INT", "0")
	if got := envIntOrZero("LC_TEST_INT", 7); got != 0 {
		t.Errorf("\"0\" should be 0: %d", got)
	}
	t.Setenv("LC_TEST_INT", "-3")
	if got := envIntOrZero("LC_TEST_INT", 7); got != 7 {
		t.Errorf("negative should fall back: %d", got)
	}
	t.Setenv("LC_TEST_INT", "21")
	if got := envIntOrZero("LC_TEST_INT", 7); got != 21 {
		t.Errorf("21: %d", got)
	}
}
