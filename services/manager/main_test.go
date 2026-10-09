package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

// testNamespace is the workspace namespace every test runs in.
const testNamespace = "workspaces"

func TestIsValidRedirect(t *testing.T) {
	good := []string{"/", "/ws", "/ws/foo?x=y", "/?a=1&x=b#frag", "/a/b/c/", "/?user=a@b", "/%0d%0a"}
	for _, s := range good {
		if !isValidRedirect(s) {
			t.Errorf("isValidRedirect(%q) = false, want true", s)
		}
		if got := safeRedirectPath(s); got != s {
			t.Errorf("safeRedirectPath(%q) = %q, want unchanged", s, got)
		}
	}
	bad := []string{
		"", "ws", "https://evil.example/", "http://evil.example",
		"//evil.example/", `/\evil.example`, "/\\evil.example",
		"javascript:alert(1)", "//", "/\r\n",
		"/\nfoo", "  /ws", "\\/ws", "/ws\\..\\x", "///evil.example",
		"http:/evil.example", "mailto:x@y",
	}
	for _, s := range bad {
		if isValidRedirect(s) {
			t.Errorf("isValidRedirect(%q) = true, want false", s)
		}
		if got := safeRedirectPath(s); got != "/" {
			t.Errorf("safeRedirectPath(%q) = %q, want \"/\"", s, got)
		}
	}
}

func TestIsLocalhost(t *testing.T) {
	for host, want := range map[string]bool{
		"localhost":              true,
		"localhost:8080":         true,
		"127.0.0.1:8080":         true,
		"workspaces.example.com": false,
		"localhost.evil.example": false,
		"":                       false,
	} {
		if got := isLocalhost(host); got != want {
			t.Errorf("isLocalhost(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestLogSafe(t *testing.T) {
	if got := logSafe("alice@example.com"); got != "alice@example.com" {
		t.Errorf("plain value changed: %q", got)
	}
	if got := logSafe("a\r\nlevel=ERROR msg=forged"); got != "alevel=ERROR msg=forged" {
		t.Errorf("CR/LF not stripped: %q", got)
	}
	long := strings.Repeat("é", 300) // multi-byte: truncation must not split a rune
	got := logSafe(long)
	if !strings.HasSuffix(got, "…") || len(got) > logSafeMax+len("…") {
		t.Errorf("not truncated: len=%d", len(got))
	}
	if strings.Count(got, "é") != (len(got)-len("…"))/2 {
		t.Errorf("truncation split a rune: %q", got[:20])
	}
}

func TestValidateSlug(t *testing.T) {
	for _, ok := range []string{"pilot", "a", "team-x", "abc123"} {
		if err := validateSlug(ok); err != nil {
			t.Errorf("validateSlug(%q) = %v, want nil", ok, err)
		}
	}
	for _, bad := range []string{"", "-lead", "trail-", "UP", "a--b", "system", "workspace", strings.Repeat("x", 33)} {
		if err := validateSlug(bad); err == nil {
			t.Errorf("validateSlug(%q) = nil, want error", bad)
		}
	}
}

func TestHostLabelAndURL(t *testing.T) {
	if got := hostLabel("ws-anne-api", "anne"); got != "anne-api" {
		t.Errorf("host label = %q", got)
	}
	c := &config{workspaceHost: "{user}.workspaces.example.com"}
	if got := c.workspaceURL("ws-anne-api", "anne"); got != "https://anne-api.workspaces.example.com" {
		t.Errorf("workspace URL = %q", got)
	}
}

// The bug that motivated exact ownership: user "anne" must not own
// "ws-anne-b-x" belonging to user "anne-b".
func TestGetOwnedDeploymentExact(t *testing.T) {
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "ws-anne-b-x",
			Namespace: testNamespace,
			Labels:    map[string]string{userLabel: "anne-b"},
		},
	}
	conf := &config{
		k8s:       fake.NewSimpleClientset(dep),
		ownership: map[string]time.Time{},
	}
	if _, err := conf.getOwnedDeployment(context.Background(), &session{userUPN: "anne-b@example.com"}, testNamespace, "ws-anne-b-x"); err != nil {
		t.Errorf("owner denied: %v", err)
	}
	if _, err := conf.getOwnedDeployment(context.Background(), &session{userUPN: "anne@example.com"}, testNamespace, "ws-anne-b-x"); !errors.Is(err, errNotOwned) {
		t.Errorf("prefix-collision user allowed, err = %v", err)
	}
}

func TestEmailAllowed(t *testing.T) {
	yes, no := true, false
	open := &config{allowedEmailDomains: domainSet("")}
	if !open.emailAllowed("bob@anywhere.test", nil, "bob") {
		t.Error("no ALLOWED_EMAIL_DOMAINS must allow everyone")
	}
	c := &config{allowedEmailDomains: domainSet(" Example.com, @corp.example ")}
	cases := []struct {
		email    string
		verified *bool
		upn      string
		want     bool
	}{
		{"alice@example.com", &yes, "alice", true},
		{"alice@EXAMPLE.COM", nil, "alice", true},
		{"carol@corp.example", nil, "carol", true},
		{"mallory@evil.test", &yes, "mallory", false},
		{"mallory@example.com.evil.test", nil, "mallory", false},
		{"alice@example.com", &no, "alice", false}, // unverified email
		{"", nil, "dave@example.com", true},        // no email claim: fall back to the UPN
		{"", nil, "dave", false},                   // nothing to check
	}
	for _, tc := range cases {
		if got := c.emailAllowed(tc.email, tc.verified, tc.upn); got != tc.want {
			t.Errorf("emailAllowed(%q, %v, %q) = %v, want %v", tc.email, tc.verified, tc.upn, got, tc.want)
		}
	}
}

func TestDefaultManagerURL(t *testing.T) {
	if got := defaultManagerURL("workspaces-system", "workspaces"); got != "http://manager.workspaces-system.svc.cluster.local:8080" {
		t.Errorf("got %q", got)
	}
	if got := defaultManagerURL("", "workspaces"); got != "http://manager.workspaces.svc.cluster.local:8080" {
		t.Errorf("fallback: got %q", got)
	}
}

func TestEnvFSGroup(t *testing.T) {
	t.Setenv("WORKSPACE_FS_GROUP", "")
	if got := envFSGroup(); got != 0 {
		t.Errorf("empty must disable: %d", got)
	}
	t.Setenv("WORKSPACE_FS_GROUP", "2000")
	if got := envFSGroup(); got != 2000 {
		t.Errorf("2000: %d", got)
	}
	t.Setenv("WORKSPACE_FS_GROUP", "0")
	if got := envFSGroup(); got != 0 {
		t.Errorf("0 must disable: %d", got)
	}
}

func TestPodSecurityContext(t *testing.T) {
	c := &config{fsGroup: 1000}
	sc := c.podSecurityContext()
	if sc.FSGroup == nil || *sc.FSGroup != 1000 || sc.RunAsUser != nil || sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
		t.Errorf("default: %+v", sc)
	}
	uid := int64(1001)
	c = &config{runAsUser: &uid}
	sc = c.podSecurityContext()
	if sc.FSGroup != nil || sc.RunAsUser == nil || *sc.RunAsUser != 1001 {
		t.Errorf("fsGroup 0 / runAsUser set: %+v", sc)
	}
}
