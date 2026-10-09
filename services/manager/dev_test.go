package main

import (
	"context"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// TestDevFakeDeploymentBecomesReady pins the DEV_FAKE control plane's stand-in
// deployment controller: a Deployment created through the fake client is not
// Ready immediately, becomes Ready shortly after, drops back to 0 when scaled
// down and comes back when scaled up again.
func TestDevFakeDeploymentBecomesReady(t *testing.T) {
	const delay = 20 * time.Millisecond
	ns := testNamespace
	k8s := newDevFakeClients(ns, "dev", delay)
	ctx := context.Background()
	deps := k8s.AppsV1().Deployments(ns)

	one, zero := int32(1), int32(0)
	created, err := deps.Create(ctx, &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "ws-dev-t1", Namespace: ns},
		Spec:       appsv1.DeploymentSpec{Replicas: &one},
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.Status.ReadyReplicas != 0 {
		t.Fatalf("fresh deployment ReadyReplicas = %d, want 0 (readiness must be delayed)", created.Status.ReadyReplicas)
	}

	waitReady := func(want int32) *appsv1.Deployment {
		t.Helper()
		deadline := time.Now().Add(50 * delay)
		for {
			dep, err := deps.Get(ctx, "ws-dev-t1", metav1.GetOptions{})
			if err != nil {
				t.Fatalf("get: %v", err)
			}
			if dep.Status.ReadyReplicas == want {
				return dep
			}
			if time.Now().After(deadline) {
				t.Fatalf("ReadyReplicas = %d, want %d after %v", dep.Status.ReadyReplicas, want, 50*delay)
			}
			time.Sleep(delay / 4)
		}
	}

	dep := waitReady(1)
	if dep.Status.AvailableReplicas != 1 || dep.Status.Replicas != 1 {
		t.Errorf("status = %+v, want replicas/available 1", dep.Status)
	}

	// Scale down the way scaleWorkspace does: Get, mutate, Update. The Update
	// payload still carries ReadyReplicas=1; the fake controller must clear it.
	dep.Spec.Replicas = &zero
	if _, err := deps.Update(ctx, dep, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("scale down: %v", err)
	}
	dep = waitReady(0)

	dep.Spec.Replicas = &one
	if _, err := deps.Update(ctx, dep, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("scale up: %v", err)
	}
	waitReady(1)

	// Seeded fixtures keep their state: the running workspace is Ready from
	// the start and the stopped ones stay at 0.
	running, err := deps.Get(ctx, "ws-dev-pomodoro", metav1.GetOptions{})
	if err != nil || running.Status.ReadyReplicas != 1 {
		t.Errorf("seeded running workspace: err=%v ready=%v, want ready 1", err, running.Status.ReadyReplicas)
	}
}

// TestDevFakeStopDuringStartWins: a stop that lands while the fake controller
// is still "starting" the Deployment must not be undone by the pending
// readiness update.
func TestDevFakeStopDuringStartWins(t *testing.T) {
	const delay = 30 * time.Millisecond
	ns := testNamespace
	k8s := newDevFakeClients(ns, "dev", delay)
	ctx := context.Background()
	deps := k8s.AppsV1().Deployments(ns)

	one, zero := int32(1), int32(0)
	dep, err := deps.Create(ctx, &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "ws-dev-t2", Namespace: ns},
		Spec:       appsv1.DeploymentSpec{Replicas: &one},
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	dep.Spec.Replicas = &zero
	if _, err := deps.Update(ctx, dep, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("stop: %v", err)
	}
	time.Sleep(4 * delay)
	got, err := deps.Get(ctx, "ws-dev-t2", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Status.ReadyReplicas != 0 || *got.Spec.Replicas != 0 {
		t.Fatalf("after stop during start: replicas=%d ready=%d, want 0/0", *got.Spec.Replicas, got.Status.ReadyReplicas)
	}
}
