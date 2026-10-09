package main

import (
	"context"
	"testing"

	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func testCreateConfig(t *testing.T) *config {
	t.Helper()
	return &config{
		k8s:              devFakeClients(testNamespace, "dev"),
		namespace:        testNamespace,
		image:            "registry.example/workspace:1",
		postgresImage:    "registry.example/postgres:16",
		workspaceHost:    "{user}.workspaces.example.com",
		managerURL:       "http://manager.workspaces-system.svc.cluster.local:8080",
		managerPublicURL: "https://workspaces.example.com",
		sessionPubB64:    "pubkey",
		inferenceSecret:  "my-llm-settings",
		storageSize:      resource.MustParse("20Gi"),
		fsGroup:          1000,
	}
}

// createWorkspace builds PVC + Deployment + Service in the configured
// namespace, wires the optional inference Secret, and stamps the env the
// in-pod authproxy and agent read.
func TestCreateWorkspace(t *testing.T) {
	c := testCreateConfig(t)
	sess := &session{userUPN: "alice@example.com"}
	ctx := context.Background()

	if err := c.createWorkspace(ctx, sess, createOpts{slug: "api", explicitName: true, postgres: true}); err != nil {
		t.Fatalf("createWorkspace: %v", err)
	}
	dep, err := c.k8s.AppsV1().Deployments(testNamespace).Get(ctx, "ws-alice-api", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("deployment not created: %v", err)
	}
	if dep.Labels[userLabel] != "alice" || dep.Labels[managedByLabel] != "workspaces" || dep.Labels[workspaceLabel] != "ws-alice-api" {
		t.Errorf("labels = %v", dep.Labels)
	}
	if dep.Annotations[postgresAnnotation] != "true" || dep.Annotations[ownerUPNAnnotation] != "alice@example.com" {
		t.Errorf("annotations = %v", dep.Annotations)
	}
	spec := dep.Spec.Template.Spec
	if len(spec.Containers) != 2 || spec.Containers[1].Image != "registry.example/postgres:16" {
		t.Fatalf("containers = %+v", spec.Containers)
	}
	if spec.SecurityContext == nil || spec.SecurityContext.FSGroup == nil || *spec.SecurityContext.FSGroup != 1000 {
		t.Errorf("pod securityContext = %+v", spec.SecurityContext)
	}

	ws := spec.Containers[0]
	env := map[string]string{}
	for _, e := range ws.Env {
		env[e.Name] = e.Value
	}
	for k, want := range map[string]string{
		"WORKSPACE_NAME":       "ws-alice-api",
		"WORKSPACE_OWNER":      "alice",
		"WORKSPACE_HOST_LABEL": "alice-api",
		"MANAGER_URL":          "http://manager.workspaces-system.svc.cluster.local:8080",
		"MANAGER_PUBLIC_URL":   "https://workspaces.example.com",
		"VSCODE_PROXY_URI":     "https://alice-api.workspaces.example.com/proxy/{{port}}/",
		"SESSION_PUBLIC_KEY":   "pubkey",
	} {
		if env[k] != want {
			t.Errorf("env %s = %q, want %q", k, env[k], want)
		}
	}
	for _, gone := range []string{"WORKSPACE_UI", "WORKSPACE_MODE"} {
		if _, ok := env[gone]; ok {
			t.Errorf("env %s must not be set", gone)
		}
	}
	if ws.StartupProbe == nil || ws.StartupProbe.HTTPGet.Path != "/_workspace/healthz" {
		t.Errorf("startup probe = %+v", ws.StartupProbe)
	}

	var names []string
	for _, ef := range ws.EnvFrom {
		if ef.SecretRef == nil {
			continue
		}
		if ef.SecretRef.Optional == nil || !*ef.SecretRef.Optional {
			t.Errorf("secretRef %s must be optional", ef.SecretRef.Name)
		}
		names = append(names, ef.SecretRef.Name)
	}
	if len(names) != 1 || names[0] != "my-llm-settings" {
		t.Errorf("envFrom secretRefs = %v, want [my-llm-settings]", names)
	}
	if len(spec.Containers[1].EnvFrom) != 0 {
		t.Error("the postgres sidecar must not get the inference Secret")
	}

	pvc, err := c.k8s.CoreV1().PersistentVolumeClaims(testNamespace).Get(ctx, "ws-alice-api", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("pvc not created: %v", err)
	}
	if got := pvc.Spec.Resources.Requests.Storage(); got.String() != "20Gi" {
		t.Errorf("pvc size = %s, want 20Gi", got)
	}
	if _, err := c.k8s.CoreV1().Services(testNamespace).Get(ctx, "ws-alice-api", metav1.GetOptions{}); err != nil {
		t.Errorf("service not created: %v", err)
	}

	// The same explicit name twice is an error, not a silent rename.
	if err := c.createWorkspace(ctx, sess, createOpts{slug: "api", explicitName: true}); err == nil {
		t.Error("duplicate explicit name must fail")
	}
}

// The port host "<port>--<user>-<slug>" has to fit one DNS label.
func TestCreateWorkspaceNameTooLong(t *testing.T) {
	c := testCreateConfig(t)
	sess := &session{userUPN: "a-rather-long-user-name-here-xyz@example.com"}
	err := c.createWorkspace(context.Background(), sess, createOpts{slug: "a-fairly-long-slug-too-abcdefgh", explicitName: true})
	if err != errNameTooLong {
		t.Errorf("err = %v, want errNameTooLong", err)
	}
}
