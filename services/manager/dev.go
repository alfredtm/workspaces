package main

// Local-dev fake mode (DEV_FAKE, see main): the manager runs against an
// in-memory fake Kubernetes client seeded with a couple of workspaces in the
// configured namespace, so the portal is fully usable on localhost without a
// cluster or kubeconfig. Mutations only ever touch the fake.

import (
	"log/slog"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	k8sfake "k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

// devFakeReadyDelay is how long the fake "controller" takes to bring a
// Deployment to Ready after it is created or scaled up — long enough for the
// portal's "Starting…" state to be visible, short enough not to be annoying.
const devFakeReadyDelay = 1500 * time.Millisecond

func devFakeClients(namespace, username string) kubernetes.Interface {
	return newDevFakeClients(namespace, username, devFakeReadyDelay)
}

// newDevFakeClients is devFakeClients with the readiness delay exposed so
// tests don't have to wait the human-scale default.
func newDevFakeClients(namespace, username string, readyDelay time.Duration) kubernetes.Interface {
	deployment := func(wsName string, replicas, ready int32) *appsv1.Deployment {
		return &appsv1.Deployment{
			ObjectMeta: metav1.ObjectMeta{
				Name:      wsName,
				Namespace: namespace,
				Labels:    workspaceLabels(username, wsName),
				Annotations: map[string]string{
					activityAnnotation: time.Now().UTC().Format(time.RFC3339),
				},
			},
			Spec: appsv1.DeploymentSpec{
				Replicas: &replicas,
				Selector: &metav1.LabelSelector{MatchLabels: workspaceLabels(username, wsName)},
				Template: corev1.PodTemplateSpec{
					ObjectMeta: metav1.ObjectMeta{Labels: workspaceLabels(username, wsName)},
				},
			},
			Status: appsv1.DeploymentStatus{ReadyReplicas: ready},
		}
	}

	running := "ws-" + username + "-demo"
	paused := "ws-" + username + "-paused"

	k8s := k8sfake.NewSimpleClientset(
		deployment(running, 1, 1),
		deployment(paused, 0, 0),
		&corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name:      running + "-6c9f7d4b8-x2m4q",
				Namespace: namespace,
				Labels:    workspaceLabels(username, running),
			},
			Status: corev1.PodStatus{
				Phase:             corev1.PodRunning,
				ContainerStatuses: []corev1.ContainerStatus{{Name: "workspace", Ready: true}},
			},
		},
	)

	devFakeDeploymentController(k8s, readyDelay)
	return k8s
}

// devFakeDeploymentController stands in for the real deployment controller:
// the fake clientset stores whatever status it is handed and never touches
// it, so anything created at runtime would sit at ReadyReplicas=0 forever
// and the portal could never reach "running".
//
// A reactor on create/update of Deployments (main resource only, not
// subresources) schedules a goroutine that, after readyDelay, sets
// status.readyReplicas to 1 when spec.replicas > 0 and to 0 when the
// Deployment was scaled down. The write goes through the tracker directly so
// it does not re-trigger the reactor. Before writing, the goroutine re-reads
// the object and bails if the spec no longer asks for the state it was
// scheduled to settle — a stop that lands during the start delay wins.
func devFakeDeploymentController(k8s *k8sfake.Clientset, readyDelay time.Duration) {
	tracker := k8s.Tracker()
	gvr := appsv1.SchemeGroupVersion.WithResource("deployments")

	settle := func(ns, name string, want int32) {
		time.Sleep(readyDelay)
		obj, err := tracker.Get(gvr, ns, name)
		if err != nil {
			return // deleted meanwhile, or the create itself failed
		}
		dep, ok := obj.(*appsv1.Deployment)
		if !ok {
			return
		}
		if devFakeWantReady(dep) != want || dep.Status.ReadyReplicas == want {
			return
		}
		dep.Status.Replicas = want
		dep.Status.ReadyReplicas = want
		dep.Status.AvailableReplicas = want
		dep.Status.UpdatedReplicas = want
		if err := tracker.Update(gvr, dep, ns); err != nil {
			slog.Warn("dev fake: settle deployment status", "deployment", ns+"/"+name, "err", err)
		}
	}

	reactor := func(action k8stesting.Action) (bool, runtime.Object, error) {
		if action.GetSubresource() != "" {
			return false, nil, nil
		}
		// Create and Update actions both carry the object the same way.
		withObj, ok := action.(interface{ GetObject() runtime.Object })
		if !ok {
			return false, nil, nil
		}
		dep, ok := withObj.GetObject().(*appsv1.Deployment)
		if !ok {
			return false, nil, nil
		}
		go settle(action.GetNamespace(), dep.Name, devFakeWantReady(dep))
		// Not handled: the default ObjectReaction still performs the write.
		return false, nil, nil
	}
	k8s.PrependReactor("create", "deployments", reactor)
	k8s.PrependReactor("update", "deployments", reactor)
}

// devFakeWantReady is the ReadyReplicas the fake controller converges to for
// a Deployment spec: 1 when it asks for pods (nil means the default of 1),
// 0 when scaled down.
func devFakeWantReady(dep *appsv1.Deployment) int32 {
	if dep.Spec.Replicas != nil && *dep.Spec.Replicas == 0 {
		return 0
	}
	return 1
}
