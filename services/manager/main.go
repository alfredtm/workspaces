// manager: the control plane for workspaces. It signs users in with OIDC,
// serves the React portal plus its JSON API (api.go), creates, pauses and
// deletes workspaces in one namespace (WORKSPACE_NAMESPACE), and receives the
// activity heartbeats the in-pod authproxy sends.
//
// Routes outside the JSON API:
//
//	GET  /auth/login     – redirect to the OIDC issuer (PKCE)
//	GET  /auth/callback  – OIDC callback, set signed session cookie
//	GET  /auth/logout    – clear session cookie
//	POST /api/activity   – activity heartbeat from authproxy sidecars
//	GET  /healthz        – liveness probe
//	GET  /               – the portal (SPA)
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	oidc "github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/retry"
)

// ----------------------------------------------------------------------------
// Config & session
// ----------------------------------------------------------------------------

type config struct {
	listen           string
	publicHost       string // workspace.domain
	workspaceHost    string // {user}.workspace.domain
	cookieDomain     string // .workspace.domain  (covers all subdomains)
	cookieSecure     bool   // Secure flag on every cookie; off only for plain-http localhost dev
	managerPublicURL string // https://workspace.domain
	managerURL       string // in-cluster manager URL handed to workspace pods (heartbeats)
	namespace        string // the one namespace every workspace lives in
	image            string
	postgresImage    string
	storageClass     string // StorageClass for workspace PVCs (WORKSPACE_STORAGE_CLASS); "" = cluster default
	storageSize      resource.Quantity
	inferenceSecret  string // optional Secret with LLM_* provider settings, envFrom'd into pods
	fsGroup          int64  // pod fsGroup so the PVC is writable; 0 = leave it to the platform
	runAsUser        *int64 // pod runAsUser; nil = image default / platform-assigned

	// allowedEmailDomains, when non-empty, restricts login to identities
	// whose email domain is listed (ALLOWED_EMAIL_DOMAINS).
	allowedEmailDomains map[string]bool

	oidcIssuer   string
	clientID     string
	clientSecret string
	callbackURL  string

	// devUser, when set (DEV_USER), makes /auth/login mint a session for that
	// UPN without touching the IdP. Only honored when PUBLIC_HOST is
	// localhost — main() refuses to start otherwise.
	devUser string

	k8s kubernetes.Interface

	// Session cookies are stateless: signed with sessionPriv, verifiable by any
	// replica (and by authproxy sidecars holding the public key).
	sessionPriv   ed25519.PrivateKey
	sessionPub    ed25519.PublicKey
	sessionPubB64 string // base64url raw public key, injected into workspace pods
	csrfKey       []byte

	mu            sync.Mutex
	lastActivity  map[string]time.Time // keyed by ns/workspace; freshest known activity
	lastPersisted map[string]time.Time // last value written to the last-activity annotation
	ownership     map[string]time.Time // positive ownership-check cache; key ns/name/user, value expiry

	activeLimit int // max running workspaces per user

	// Lifecycle knobs (see lifecycle.go). Zero disables each one.
	idleTimeout    time.Duration // IDLE_TIMEOUT: running and idle this long → paused
	startTimeout   time.Duration // START_TIMEOUT: unready pod older than this is stopped
	idleWarnDays   int           // IDLE_WARN_DAYS: paused this long → warning annotation
	idleDeleteDays int           // IDLE_DELETE_DAYS: paused this long → deleted

	// OIDC provider is initialized lazily so an unreachable issuer degrades
	// login instead of crash-looping the whole manager.
	providerMu sync.Mutex
	provider   *oidc.Provider
	oauth2     oauth2.Config
}

type session struct {
	userUPN     string
	displayName string
	expiry      time.Time
	cookieRaw   string // the signed cookie value this session was parsed from
}

func (s *session) username() string {
	prefix := strings.SplitN(s.userUPN, "@", 2)[0]
	return sanitizeName(prefix)
}

type sessionKey struct{}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	publicHost := mustenv("PUBLIC_HOST")
	namespace := mustenv("WORKSPACE_NAMESPACE")
	cfg := &config{
		listen:              getenv("LISTEN", ":8080"),
		publicHost:          publicHost,
		workspaceHost:       mustenv("WORKSPACE_HOST"),
		cookieDomain:        cookieDomain(publicHost),
		cookieSecure:        !isLocalhost(publicHost),
		managerPublicURL:    "https://" + publicHost,
		managerURL:          getenv("MANAGER_URL", defaultManagerURL(os.Getenv("POD_NAMESPACE"), namespace)),
		namespace:           namespace,
		image:               mustenv("WORKSPACE_IMAGE"),
		postgresImage:       getenv("POSTGRES_IMAGE", defaultPostgresImage),
		storageClass:        getenv("WORKSPACE_STORAGE_CLASS", ""),
		inferenceSecret:     getenv("INFERENCE_SECRET", defaultInferenceSecret),
		fsGroup:             envFSGroup(),
		allowedEmailDomains: domainSet(os.Getenv("ALLOWED_EMAIL_DOMAINS")),
		oidcIssuer:          mustenv("OIDC_ISSUER"),
		clientID:            mustenv("OIDC_CLIENT_ID"),
		// Empty for public clients: the auth-code flow then relies on PKCE
		// alone, which we always use.
		clientSecret:   getenv("OIDC_CLIENT_SECRET", ""),
		callbackURL:    mustenv("OIDC_CALLBACK_URL"),
		lastActivity:   make(map[string]time.Time),
		lastPersisted:  make(map[string]time.Time),
		ownership:      make(map[string]time.Time),
		activeLimit:    envInt("ACTIVE_LIMIT", 3),
		idleTimeout:    envDuration("IDLE_TIMEOUT", defaultIdleTimeout),
		startTimeout:   envDuration("START_TIMEOUT", defaultStartTimeout),
		idleWarnDays:   envIntOrZero("IDLE_WARN_DAYS", defaultIdleWarnDays),
		idleDeleteDays: envIntOrZero("IDLE_DELETE_DAYS", defaultIdleDeleteDays),
	}
	size, err := resource.ParseQuantity(getenv("WORKSPACE_STORAGE_SIZE", defaultStorageSize))
	if err != nil {
		slog.Error("WORKSPACE_STORAGE_SIZE is not a valid quantity", "err", err)
		os.Exit(1)
	}
	cfg.storageSize = size
	// Unset or empty: don't pin a UID (the image's or the platform's wins).
	if v := strings.TrimSpace(os.Getenv("WORKSPACE_RUN_AS_USER")); v != "" {
		uid, err := strconv.ParseInt(v, 10, 64)
		if err != nil || uid <= 0 {
			slog.Error("WORKSPACE_RUN_AS_USER must be a positive integer", "value", v)
			os.Exit(1)
		}
		cfg.runAsUser = &uid
	}
	if cfg.idleWarnDays > 0 && cfg.idleDeleteDays > 0 && cfg.idleWarnDays >= cfg.idleDeleteDays {
		slog.Warn("IDLE_WARN_DAYS is not below IDLE_DELETE_DAYS: idle workspaces will be deleted without a warning period",
			"warn_days", cfg.idleWarnDays, "delete_days", cfg.idleDeleteDays)
	}
	// The manager's own hostname label must never be claimable as a slug.
	reservedSlugs[strings.SplitN(publicHost, ".", 2)[0]] = true

	if devUser := os.Getenv("DEV_USER"); devUser != "" {
		if !isLocalhost(publicHost) {
			slog.Error("DEV_USER is only allowed with a localhost PUBLIC_HOST", "public_host", publicHost)
			os.Exit(1)
		}
		cfg.devUser = devUser
		slog.Warn("DEV_USER set: /auth/login bypasses the IdP and signs in as this user", "dev_user", devUser)
	}

	seed, err := base64.StdEncoding.DecodeString(mustenv("SESSION_PRIVATE_KEY"))
	if err != nil || len(seed) != ed25519.SeedSize {
		slog.Error("SESSION_PRIVATE_KEY must be base64 of a 32-byte seed", "err", err, "len", len(seed))
		os.Exit(1)
	}
	cfg.sessionPriv = ed25519.NewKeyFromSeed(seed)
	cfg.sessionPub = cfg.sessionPriv.Public().(ed25519.PublicKey)
	cfg.sessionPubB64 = base64.RawURLEncoding.EncodeToString(cfg.sessionPub)
	cfg.csrfKey, err = base64.StdEncoding.DecodeString(mustenv("CSRF_KEY"))
	if err != nil || len(cfg.csrfKey) < 16 {
		slog.Error("CSRF_KEY must be base64 of at least 16 bytes", "err", err)
		os.Exit(1)
	}

	if os.Getenv("DEV_FAKE") != "" {
		// Same gate as DEV_USER: a fake control plane must never serve a
		// non-localhost host.
		if !isLocalhost(publicHost) {
			slog.Error("DEV_FAKE is only allowed with a localhost PUBLIC_HOST", "public_host", publicHost)
			os.Exit(1)
		}
		seedUser := (&session{userUPN: getenv("DEV_USER", "dev@localhost")}).username()
		cfg.k8s = devFakeClients(cfg.namespace, seedUser)
		slog.Warn("DEV_FAKE set: using an in-memory fake Kubernetes client, no cluster is touched", "seed_user", seedUser)
	} else {
		k8sCfg, err := buildK8sConfig()
		if err != nil {
			slog.Error("k8s config", "err", err)
			os.Exit(1)
		}
		cfg.k8s, err = kubernetes.NewForConfig(k8sCfg)
		if err != nil {
			slog.Error("k8s client", "err", err)
			os.Exit(1)
		}
	}

	// OIDC discovery is lazy: a dead IdP must not crash-loop the manager,
	// which also keeps serving activity heartbeats and auto-pause.
	if _, _, err := cfg.getProvider(context.Background()); err != nil {
		slog.Warn("oidc provider unavailable at startup, will retry", "err", err)
		go cfg.oidcRetryLoop()
	}

	go cfg.autoPauseLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("GET /auth/login", cfg.loginHandler)
	mux.HandleFunc("GET /auth/callback", cfg.callbackHandler)
	mux.HandleFunc("GET /auth/logout", cfg.logoutHandler)
	// activity heartbeat from authproxy sidecars — authenticated by the user's own session cookie
	mux.HandleFunc("POST /api/activity", cfg.activityHandler)
	cfg.registerAPIRoutes(mux)
	mux.HandleFunc("GET /", cfg.requireAuth(cfg.spaHandler))

	slog.Info("manager starting",
		"listen", cfg.listen,
		"public_host", cfg.publicHost,
		"cookie_domain", cfg.cookieDomain,
		"namespace", cfg.namespace,
	)
	srv := &http.Server{
		Addr:              cfg.listen,
		Handler:           cfg.securityHeaders(mux),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("listen", "err", err)
		os.Exit(1)
	}
}

// Defaults for the optional settings.
const (
	defaultStorageSize     = "10Gi"
	defaultInferenceSecret = "workspace-inference"
	defaultFSGroup         = 1000
	defaultIdleTimeout     = 30 * time.Minute
	// Red Hat's sclorg postgres: runs under an arbitrary non-root UID, so it
	// works on OpenShift's restricted SCC as well as on vanilla Kubernetes.
	// The major version is pinned by the repo name, so the rolling tag only
	// ever moves minor/patch releases — safe for the data dir on the PVC.
	defaultPostgresImage = "quay.io/sclorg/postgresql-16-c9s:latest"
)

// envFSGroup reads WORKSPACE_FS_GROUP: unset → defaultFSGroup; set but empty
// (or "0") → 0, meaning "leave fsGroup to the platform" (OpenShift SCCs
// assign it and reject values outside the namespace's range).
func envFSGroup() int64 {
	v, ok := os.LookupEnv("WORKSPACE_FS_GROUP")
	if !ok {
		return defaultFSGroup
	}
	if strings.TrimSpace(v) == "" {
		return 0
	}
	return int64(envIntOrZero("WORKSPACE_FS_GROUP", defaultFSGroup))
}

// defaultManagerURL is the in-cluster URL workspace pods use to reach the
// manager: its Service in the manager's own namespace (downward-API
// POD_NAMESPACE), falling back to the workspace namespace.
func defaultManagerURL(podNamespace, workspaceNamespace string) string {
	ns := podNamespace
	if ns == "" {
		ns = workspaceNamespace
	}
	return "http://manager." + ns + ".svc.cluster.local:8080"
}

// ----------------------------------------------------------------------------
// Security middleware
// ----------------------------------------------------------------------------

func (c *config) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "geolocation=(), camera=(), microphone=()")
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; "+
				"style-src 'self' 'unsafe-inline'; "+
				"font-src 'self' data:; "+
				"script-src 'self'; img-src 'self' data:; "+
				// explicit wss for the status page's socket probe — some
				// browsers don't extend 'self' to upgraded schemes
				"connect-src 'self' wss://"+c.publicHost+"; "+
				"frame-src 'self'")
		next.ServeHTTP(w, r)
	})
}

func (c *config) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess := c.getSession(r)
		if sess == nil {
			http.Redirect(w, r,
				"/auth/login?redirect_to="+r.URL.RequestURI(),
				http.StatusFound)
			return
		}
		ctx := context.WithValue(r.Context(), sessionKey{}, sess)
		next(w, r.WithContext(ctx))
	}
}

// csrfFor derives a stateless CSRF token from the session cookie value, so any
// replica can verify tokens minted by any other.
func (c *config) csrfFor(rawCookie string) string {
	mac := hmac.New(sha256.New, c.csrfKey)
	mac.Write([]byte(rawCookie))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// ----------------------------------------------------------------------------
// OIDC provider (lazy)
// ----------------------------------------------------------------------------

// getProvider returns the cached OIDC provider, performing discovery on first
// use. Errors are returned (not fatal) so login degrades to 503 while the
// issuer is unreachable.
func (c *config) getProvider(ctx context.Context) (*oidc.Provider, *oauth2.Config, error) {
	c.providerMu.Lock()
	defer c.providerMu.Unlock()
	if c.provider != nil {
		o2 := c.oauth2
		return c.provider, &o2, nil
	}
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	provider, err := oidc.NewProvider(dctx, c.oidcIssuer)
	if err != nil {
		return nil, nil, err
	}
	c.provider = provider
	c.oauth2 = oauth2.Config{
		ClientID:     c.clientID,
		ClientSecret: c.clientSecret,
		RedirectURL:  c.callbackURL,
		Endpoint:     provider.Endpoint(),
		Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
	}
	slog.Info("oidc provider initialized", "issuer", c.oidcIssuer)
	o2 := c.oauth2
	return c.provider, &o2, nil
}

func (c *config) oidcRetryLoop() {
	for range time.Tick(30 * time.Second) {
		if _, _, err := c.getProvider(context.Background()); err == nil {
			return
		}
	}
}

// ----------------------------------------------------------------------------
// Auth handlers
// ----------------------------------------------------------------------------

func (c *config) loginHandler(w http.ResponseWriter, r *http.Request) {
	if c.devUser != "" {
		// Local-dev bypass (see DEV_USER in main): mint a session directly.
		// cookieSecure is false here because this only ever runs on
		// plain-http localhost (main refuses any other PUBLIC_HOST).
		cookieVal := c.signSession(c.devUser, getenv("DEV_NAME", "Dev User"), time.Now().Add(8*time.Hour))
		slog.Warn("dev login", "identity", c.devUser, "derived_username", (&session{userUPN: c.devUser}).username())
		http.SetCookie(w, &http.Cookie{
			Name:     "mw_session",
			Value:    cookieVal,
			Path:     "/",
			Domain:   c.cookieDomain,
			MaxAge:   int((8 * time.Hour).Seconds()),
			HttpOnly: true,
			Secure:   c.cookieSecure,
			SameSite: http.SameSiteLaxMode,
		})
		// Same-site paths only — no open redirect, even in dev mode.
		http.Redirect(w, r, safeRedirectPath(r.URL.Query().Get("redirect_to")), http.StatusFound)
		return
	}

	_, oauthCfg, err := c.getProvider(r.Context())
	if err != nil {
		slog.Error("oidc provider unavailable", "err", err)
		http.Error(w, "authentication temporarily unavailable", http.StatusServiceUnavailable)
		return
	}
	state := randomToken(16)
	// PKCE: generate verifier, derive challenge
	verifier := randomToken(32)
	h := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(h[:])

	http.SetCookie(w, c.shortCookie("oauth_state", state, 300))
	http.SetCookie(w, c.shortCookie("pkce_verifier", verifier, 300))

	if redirectAfter := safeRedirectPath(r.URL.Query().Get("redirect_to")); redirectAfter != "/" {
		http.SetCookie(w, c.shortCookie("redirect_to", redirectAfter, 300))
	}

	authURL := oauthCfg.AuthCodeURL(state,
		oauth2.SetAuthURLParam("code_challenge", challenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"),
	)
	http.Redirect(w, r, authURL, http.StatusFound)
}

func (c *config) callbackHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	provider, oauthCfg, err := c.getProvider(ctx)
	if err != nil {
		slog.Error("oidc provider unavailable", "err", err)
		http.Error(w, "authentication temporarily unavailable", http.StatusServiceUnavailable)
		return
	}

	stateCookie, err := r.Cookie("oauth_state")
	if err != nil || r.URL.Query().Get("state") != stateCookie.Value {
		http.Error(w, "invalid state", http.StatusBadRequest)
		return
	}
	c.clearCookie(w, "oauth_state")

	verifierCookie, err := r.Cookie("pkce_verifier")
	if err != nil {
		http.Error(w, "missing PKCE verifier", http.StatusBadRequest)
		return
	}
	c.clearCookie(w, "pkce_verifier")

	token, err := oauthCfg.Exchange(ctx, r.URL.Query().Get("code"),
		oauth2.SetAuthURLParam("code_verifier", verifierCookie.Value),
	)
	if err != nil {
		slog.Error("oauth2 exchange", "err", err)
		http.Error(w, "authentication failed", http.StatusInternalServerError)
		return
	}

	rawID, ok := token.Extra("id_token").(string)
	if !ok {
		http.Error(w, "missing id_token", http.StatusInternalServerError)
		return
	}
	verifier := provider.Verifier(&oidc.Config{ClientID: c.clientID})
	idToken, err := verifier.Verify(ctx, rawID)
	if err != nil {
		slog.Error("id_token verify", "err", err)
		http.Error(w, "token verification failed", http.StatusInternalServerError)
		return
	}

	var claims struct {
		Email         string `json:"email"`
		EmailVerified *bool  `json:"email_verified"`
		Preferred     string `json:"preferred_username"`
		Name          string `json:"name"`
	}
	if err := idToken.Claims(&claims); err != nil {
		slog.Error("parse id_token claims", "err", err)
		http.Error(w, "could not parse identity claims", http.StatusInternalServerError)
		return
	}
	upn := first(claims.Preferred, claims.Email)
	if upn == "" {
		http.Error(w, "could not determine user identity", http.StatusInternalServerError)
		return
	}
	if !c.emailAllowed(claims.Email, claims.EmailVerified, upn) {
		slog.Warn("login refused: email domain not allowed", "identity", logSafe(upn), "email", logSafe(claims.Email))
		http.Error(w, "this account is not allowed to use this service", http.StatusForbidden)
		return
	}

	cookieVal := c.signSession(upn, claims.Name, time.Now().Add(8*time.Hour))
	// The derived username is baked into workspace names, so log it on every
	// login: any drift after an IdP change is visible here.
	slog.Info("login",
		"identity", upn,
		"preferred_username", claims.Preferred,
		"email", claims.Email,
		"derived_username", (&session{userUPN: upn}).username(),
	)

	http.SetCookie(w, &http.Cookie{
		Name:     "mw_session",
		Value:    cookieVal,
		Path:     "/",
		Domain:   c.cookieDomain,
		MaxAge:   int((8 * time.Hour).Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})

	redirectTo := "/"
	if rc, err := r.Cookie("redirect_to"); err == nil && rc.Value != "" {
		redirectTo = safeRedirectPath(rc.Value)
		c.clearCookie(w, "redirect_to")
	}
	http.Redirect(w, r, redirectTo, http.StatusFound)
}

// emailAllowed applies ALLOWED_EMAIL_DOMAINS. With no domains configured
// every authenticated user is allowed. Otherwise the email claim (or, when
// the IdP sends none, the user identifier) must end in a listed domain, and
// an email the IdP explicitly marks unverified is refused.
func (c *config) emailAllowed(email string, verified *bool, upn string) bool {
	if len(c.allowedEmailDomains) == 0 {
		return true
	}
	addr := email
	if addr == "" {
		addr = upn
	} else if verified != nil && !*verified {
		return false
	}
	i := strings.LastIndex(addr, "@")
	if i < 0 {
		return false
	}
	return c.allowedEmailDomains[strings.ToLower(addr[i+1:])]
}

// domainSet parses a comma list of email domains ("example.com, @corp.io").
func domainSet(s string) map[string]bool {
	out := map[string]bool{}
	for _, v := range strings.Split(s, ",") {
		v = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(v), "@"))
		if v != "" {
			out[v] = true
		}
	}
	return out
}

func (c *config) logoutHandler(w http.ResponseWriter, r *http.Request) {
	// Sessions are stateless signed cookies: logout just clears the cookie.
	// The token stays technically valid until its 8h expiry (documented).
	http.SetCookie(w, &http.Cookie{
		Name:     "mw_session",
		Value:    "",
		Path:     "/",
		Domain:   c.cookieDomain,
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
	})
	http.Redirect(w, r, "/", http.StatusFound)
}

// activityHandler receives heartbeats from authproxy sidecars. It is
// authenticated with the user's own session cookie (forwarded by authproxy),
// so a user can only report activity for workspaces they own.
func (c *config) activityHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Workspace  string    `json:"workspace"`
		LastActive time.Time `json:"lastActive"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil || body.Workspace == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	sess := c.getSession(r)
	if sess == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !c.checkOwnership(r.Context(), sess, c.namespace, body.Workspace) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	ts := body.LastActive
	if ts.IsZero() {
		ts = time.Now()
	}
	c.recordActivity(r.Context(), c.namespace, body.Workspace, ts)
	w.WriteHeader(http.StatusNoContent)
}

// recordActivity updates the in-memory activity timestamp and, throttled to
// once per ~2 minutes, persists it as an annotation on the workspace
// Deployment so activity survives manager restarts and is shared across
// replicas.
func (c *config) recordActivity(ctx context.Context, ns, wsName string, ts time.Time) {
	if now := time.Now(); ts.After(now) {
		ts = now // don't trust client clocks
	}
	key := ns + "/" + wsName
	c.mu.Lock()
	if ts.Before(c.lastActivity[key]) {
		c.mu.Unlock()
		return
	}
	c.lastActivity[key] = ts
	persist := ts.Sub(c.lastPersisted[key]) > 2*time.Minute
	if persist {
		c.lastPersisted[key] = ts
	}
	c.mu.Unlock()
	if !persist {
		return
	}
	patch := fmt.Sprintf(`{"metadata":{"annotations":{%q:%q}}}`,
		activityAnnotation, ts.UTC().Format(time.RFC3339))
	if _, err := c.k8s.AppsV1().Deployments(ns).Patch(ctx, wsName,
		types.MergePatchType, []byte(patch), metav1.PatchOptions{}); err != nil {
		slog.Warn("persist activity annotation", "workspace", logSafe(key), "err", err)
	}
}

// ----------------------------------------------------------------------------
// Ownership
// ----------------------------------------------------------------------------

var errNotOwned = errors.New("workspace not owned by user")

// getOwnedDeployment fetches the workspace Deployment and verifies the
// session user owns it via the user label. The label is an exact match —
// name-prefix parsing would let user "anne" claim everything under
// "ws-anne-b-*" belonging to user "anne-b". Kubernetes errors (including
// NotFound) pass through untouched; ownership mismatch is errNotOwned.
func (c *config) getOwnedDeployment(ctx context.Context, sess *session, ns, wsName string) (*appsv1.Deployment, error) {
	dep, err := c.k8s.AppsV1().Deployments(ns).Get(ctx, wsName, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	if dep.Labels[userLabel] != sess.username() {
		return nil, errNotOwned
	}
	return dep, nil
}

// checkOwnership is getOwnedDeployment behind a short positive cache, for the
// hot path (activity heartbeats) that doesn't need the object itself.
func (c *config) checkOwnership(ctx context.Context, sess *session, ns, wsName string) bool {
	key := ns + "/" + wsName + "/" + sess.username()
	now := time.Now()
	c.mu.Lock()
	exp, ok := c.ownership[key]
	c.mu.Unlock()
	if ok && now.Before(exp) {
		return true
	}
	if _, err := c.getOwnedDeployment(ctx, sess, ns, wsName); err != nil {
		return false
	}
	c.mu.Lock()
	c.ownership[key] = now.Add(5 * time.Minute)
	c.mu.Unlock()
	return true
}

// ----------------------------------------------------------------------------
// Kubernetes workspace management
// ----------------------------------------------------------------------------

// Labels on every workspace object.
const (
	managedByLabel   = "app.kubernetes.io/managed-by"
	managedByValue   = "workspaces"
	userLabel        = "workspaces.dev/user"
	workspaceLabel   = "workspaces.dev/workspace"
	managedSelector  = managedByLabel + "=" + managedByValue
	workspaceSpecVer = "1"
)

// Annotation keys on the workspace Deployment.
const (
	activityAnnotation = "workspaces.dev/last-activity"
	repoAnnotation     = "workspaces.dev/repo"
	postgresAnnotation = "workspaces.dev/postgres"
	specAnnotation     = "workspaces.dev/spec-version"
	ownerUPNAnnotation = "workspaces.dev/owner-upn"
)

// createOpts describes a workspace to create. slug is the name suffix; when
// explicitName is false (slug derived from repoURL) name collisions get a
// numeric suffix instead of an error.
type createOpts struct {
	slug         string
	repoURL      string
	explicitName bool
	postgres     bool
}

var errNameTooLong = errors.New("workspace hostname would exceed the DNS label limit — pick a shorter name")

func (c *config) createWorkspace(ctx context.Context, sess *session, opts createOpts) error {
	username := sess.username()
	ns := c.namespace

	// Deployment names are DNS labels (≤63 chars); "ws-<user>-" eats the rest.
	maxSlug := 63 - len("ws-"+username+"-")
	if len(opts.slug) > maxSlug {
		opts.slug = strings.TrimRight(opts.slug[:maxSlug], "-")
	}
	// The port-forward hostname "<port>--<user>-<slug>" must also fit a
	// 63-char DNS label; reserve 7 for "65535--".
	if len(username)+1+len(opts.slug) > 56 {
		return errNameTooLong
	}

	wsName := "ws-" + username + "-" + opts.slug
	if _, err := c.k8s.AppsV1().Deployments(ns).Get(ctx, wsName, metav1.GetOptions{}); err == nil {
		if opts.explicitName {
			return fmt.Errorf("workspace %q already exists", opts.slug)
		}
		// Derived from a repo name: pick the next free numeric suffix.
		found := false
		for i := 2; i <= 9; i++ {
			candidate := fmt.Sprintf("%s-%d", opts.slug, i)
			if len(candidate) > maxSlug || len(username)+1+len(candidate) > 56 {
				break
			}
			if _, err := c.k8s.AppsV1().Deployments(ns).Get(ctx, "ws-"+username+"-"+candidate, metav1.GetOptions{}); err != nil {
				opts.slug, wsName, found = candidate, "ws-"+username+"-"+candidate, true
				break
			}
		}
		if !found {
			return fmt.Errorf("workspace %q already exists — pick a name yourself", opts.slug)
		}
	}

	annotations := map[string]string{
		specAnnotation: workspaceSpecVer,
		// The full identity (not just the sanitized username) for audit logs
		// and the retention policy's delete log line.
		ownerUPNAnnotation: sess.userUPN,
	}
	if opts.repoURL != "" {
		annotations[repoAnnotation] = opts.repoURL
	}
	if opts.postgres {
		annotations[postgresAnnotation] = "true"
	}

	wsLabels := workspaceLabels(username, wsName)

	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      wsName,
			Namespace: ns,
			Labels:    wsLabels,
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceStorage: c.workspaceStorageSize(),
				},
			},
		},
	}
	if c.storageClass != "" {
		pvc.Spec.StorageClassName = &c.storageClass
	}
	if _, err := c.k8s.CoreV1().PersistentVolumeClaims(ns).Create(ctx, pvc, metav1.CreateOptions{}); err != nil {
		if !isAlreadyExists(err) {
			return fmt.Errorf("create pvc: %w", err)
		}
	}

	replicas := int32(1)
	env := []corev1.EnvVar{
		{Name: "WORKSPACE_NAME", Value: wsName},
		{Name: "WORKSPACE_OWNER", Value: username},
		{Name: "WORKSPACE_HOST_LABEL", Value: hostLabel(wsName, username)},
		{Name: "HOME", Value: "/home/dev"},
		{Name: "MANAGER_URL", Value: c.managerURL},
		{Name: "MANAGER_PUBLIC_URL", Value: c.managerPublicURL},
		{Name: "VSCODE_PROXY_URI", Value: c.workspaceURL(wsName, username) + "/proxy/{{port}}/"},
		// Lets authproxy verify session cookies locally, keeping the manager
		// off the hot path of workspace traffic. Public key — not sensitive.
		{Name: "SESSION_PUBLIC_KEY", Value: c.sessionPubB64},
		// No ANTHROPIC_API_KEY: users sign in with their own Claude account
		// inside the editor. An injected key would outrank the user's own
		// login in Claude Code and silently move all usage to API billing.
	}
	if opts.repoURL != "" {
		env = append(env, corev1.EnvVar{Name: "WORKSPACE_REPO", Value: opts.repoURL})
	}
	healthz := corev1.ProbeHandler{
		HTTPGet: &corev1.HTTPGetAction{Path: "/_workspace/healthz", Port: intstr.FromInt(8080)},
	}
	containers := []corev1.Container{
		{
			Name:  "workspace",
			Image: c.image,
			// authproxy listens on :8080 and proxies to the editor on 127.0.0.1:13337
			Ports: []corev1.ContainerPort{{ContainerPort: 8080, Name: "http"}},
			Env:   env,
			// LLM provider settings (LLM_* keys) come from an operator-managed
			// Secret. The manager never reads it (no Secret RBAC needed): the
			// kubelet resolves it at pod start. Optional — without the Secret
			// the pod runs, just without preconfigured models.
			EnvFrom: []corev1.EnvFromSource{{
				SecretRef: &corev1.SecretEnvSource{
					LocalObjectReference: corev1.LocalObjectReference{Name: c.inferenceSecret},
					Optional:             boolPtr(true),
				},
			}},
			VolumeMounts: []corev1.VolumeMount{
				{Name: "data", MountPath: "/home/dev"},
			},
			SecurityContext: &corev1.SecurityContext{
				RunAsNonRoot:             boolPtr(true),
				AllowPrivilegeEscalation: boolPtr(false),
				Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
				SeccompProfile: &corev1.SeccompProfile{
					Type: corev1.SeccompProfileTypeRuntimeDefault,
				},
			},
			Resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("250m"),
					corev1.ResourceMemory: resource.MustParse("512Mi"),
				},
				Limits: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("2"),
					corev1.ResourceMemory: resource.MustParse("4Gi"),
				},
			},
			// /_workspace/healthz only passes once the editor listens on
			// 13337, so Ready actually means "editor is serving" (and a dead
			// authproxy fails liveness instead of leaving a zombie pod).
			StartupProbe: &corev1.Probe{
				ProbeHandler: healthz, PeriodSeconds: 2, FailureThreshold: 150,
			},
			ReadinessProbe: &corev1.Probe{
				ProbeHandler: healthz, PeriodSeconds: 5, FailureThreshold: 2,
			},
			LivenessProbe: &corev1.Probe{
				ProbeHandler: healthz, PeriodSeconds: 15, FailureThreshold: 3,
			},
		},
	}
	if opts.postgres {
		containers = append(containers, c.postgresContainer())
	}
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:        wsName,
			Namespace:   ns,
			Labels:      wsLabels,
			Annotations: annotations,
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: wsLabels},
			Strategy: appsv1.DeploymentStrategy{Type: appsv1.RecreateDeploymentStrategyType},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: wsLabels},
				Spec: corev1.PodSpec{
					SecurityContext: c.podSecurityContext(),
					// Workspaces never talk to the Kubernetes API; don't hand
					// arbitrary user code an authenticated (if unprivileged) token.
					AutomountServiceAccountToken: boolPtr(false),
					// No Kubernetes service links: with them, every Service in the
					// namespace (= every other user's workspace) is injected into
					// the pod as WS_<USER>_<SLUG>_SERVICE_HOST/PORT env vars — no
					// secrets, but a list of who is working on what, and lots of
					// noise.
					EnableServiceLinks: boolPtr(false),
					Containers:         containers,
					Volumes: []corev1.Volume{
						{
							Name: "data",
							VolumeSource: corev1.VolumeSource{
								PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
									ClaimName: wsName,
								},
							},
						},
					},
				},
			},
		},
	}
	if _, err := c.k8s.AppsV1().Deployments(ns).Create(ctx, dep, metav1.CreateOptions{}); err != nil {
		if !isAlreadyExists(err) {
			return fmt.Errorf("create deployment: %w", err)
		}
	}

	// The Service is what port-router forwards to: both the editor host
	// (<user>-<slug>.<domain>) and port hosts (<port>--<user>-<slug>.<domain>)
	// resolve to ws-<user>-<slug> in this namespace.
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      wsName,
			Namespace: ns,
			Labels:    wsLabels,
		},
		Spec: corev1.ServiceSpec{
			Selector: wsLabels,
			Ports: []corev1.ServicePort{
				{Port: 80, TargetPort: intstr.FromInt(8080), Protocol: corev1.ProtocolTCP, Name: "http"},
			},
		},
	}
	if _, err := c.k8s.CoreV1().Services(ns).Create(ctx, svc, metav1.CreateOptions{}); err != nil {
		if !isAlreadyExists(err) {
			return fmt.Errorf("create service: %w", err)
		}
	}

	slog.Info("workspace created", "namespace", logSafe(ns), "name", logSafe(wsName), "user", logSafe(sess.userUPN), "slug", logSafe(opts.slug), "repo", logSafe(opts.repoURL), "postgres", opts.postgres)
	return nil
}

// workspaceStorageSize is the PVC request; the zero value (tests that build
// a config by hand) falls back to the default.
func (c *config) workspaceStorageSize() resource.Quantity {
	if c.storageSize.IsZero() {
		return resource.MustParse(defaultStorageSize)
	}
	return c.storageSize
}

// podSecurityContext makes workspace pods work on any cluster: fsGroup makes
// the PVC writable for the image's user, runAsUser is only pinned when the
// operator asks for it, so platforms that assign UIDs themselves (OpenShift
// SCCs) keep doing so.
func (c *config) podSecurityContext() *corev1.PodSecurityContext {
	sc := &corev1.PodSecurityContext{
		RunAsNonRoot: boolPtr(true),
		RunAsUser:    c.runAsUser,
	}
	if c.fsGroup > 0 {
		fsGroup := c.fsGroup
		sc.FSGroup = &fsGroup
		policy := corev1.FSGroupChangeOnRootMismatch
		sc.FSGroupChangePolicy = &policy
	}
	return sc
}

// postgresContainer is the database sidecar; it stores its data on the
// workspace PVC under subPath postgres-data.
func (c *config) postgresContainer() corev1.Container {
	image := c.postgresImage
	if image == "" {
		image = defaultPostgresImage
	}
	return corev1.Container{
		Name:  "postgres",
		Image: image,
		Env: []corev1.EnvVar{
			{Name: "POSTGRESQL_USER", Value: "dev"},
			{Name: "POSTGRESQL_PASSWORD", Value: "dev"},
			{Name: "POSTGRESQL_DATABASE", Value: "dev"},
		},
		VolumeMounts: []corev1.VolumeMount{
			// sclorg keeps server data under /var/lib/pgsql/data/userdata.
			{Name: "data", MountPath: "/var/lib/pgsql/data", SubPath: "postgres-data"},
		},
		SecurityContext: &corev1.SecurityContext{
			RunAsNonRoot:             boolPtr(true),
			AllowPrivilegeEscalation: boolPtr(false),
			Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
			SeccompProfile: &corev1.SeccompProfile{
				Type: corev1.SeccompProfileTypeRuntimeDefault,
			},
		},
		Resources: corev1.ResourceRequirements{
			Requests: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("100m"),
				corev1.ResourceMemory: resource.MustParse("256Mi"),
			},
			Limits: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("1"),
				corev1.ResourceMemory: resource.MustParse("1Gi"),
			},
		},
	}
}

func (c *config) deleteWorkspace(ctx context.Context, ns, wsName, userUPN string) error {
	del := metav1.DeleteOptions{}
	var errs []string
	if err := c.k8s.AppsV1().Deployments(ns).Delete(ctx, wsName, del); err != nil && !isNotFound(err) {
		errs = append(errs, "deployment: "+err.Error())
	}
	if err := c.k8s.CoreV1().Services(ns).Delete(ctx, wsName, del); err != nil && !isNotFound(err) {
		errs = append(errs, "service: "+err.Error())
	}
	// Every PVC labelled as this workspace's; the name-based delete stays as
	// a fallback for a PVC that lost its labels.
	byWorkspace := metav1.ListOptions{LabelSelector: workspaceLabel + "=" + wsName}
	if pvcs, err := c.k8s.CoreV1().PersistentVolumeClaims(ns).List(ctx, byWorkspace); err != nil {
		errs = append(errs, "list pvcs: "+err.Error())
	} else {
		for _, pvc := range pvcs.Items {
			if err := c.k8s.CoreV1().PersistentVolumeClaims(ns).Delete(ctx, pvc.Name, del); err != nil && !isNotFound(err) {
				errs = append(errs, "pvc "+pvc.Name+": "+err.Error())
			}
		}
	}
	if err := c.k8s.CoreV1().PersistentVolumeClaims(ns).Delete(ctx, wsName, del); err != nil && !isNotFound(err) {
		errs = append(errs, "pvc: "+err.Error())
	}
	if len(errs) > 0 {
		return fmt.Errorf("delete workspace: %s", strings.Join(errs, "; "))
	}
	key := ns + "/" + wsName
	c.mu.Lock()
	delete(c.lastActivity, key)
	delete(c.lastPersisted, key)
	for k := range c.ownership {
		if strings.HasPrefix(k, key+"/") {
			delete(c.ownership, k)
		}
	}
	c.mu.Unlock()
	slog.Info("workspace deleted", "namespace", ns, "name", wsName, "user", userUPN)
	return nil
}

func (c *config) scaleWorkspace(ctx context.Context, ns, wsName string, replicas int32) error {
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		dep, err := c.k8s.AppsV1().Deployments(ns).Get(ctx, wsName, metav1.GetOptions{})
		if err != nil {
			return fmt.Errorf("get deployment: %w", err)
		}
		dep.Spec.Replicas = &replicas
		if replicas > 0 {
			// Resuming resets the idle timer — otherwise a stale activity
			// timestamp re-pauses the workspace on the next tick.
			if dep.Annotations == nil {
				dep.Annotations = map[string]string{}
			}
			dep.Annotations[activityAnnotation] = time.Now().UTC().Format(time.RFC3339)
			// A fresh start is a fresh chance: forget the last failed start
			// and any idle warning (lifecycle.go).
			clearLifecycleAnnotations(dep)
		}
		_, err = c.k8s.AppsV1().Deployments(ns).Update(ctx, dep, metav1.UpdateOptions{})
		return err
	})
	if err == nil && replicas > 0 {
		now := time.Now()
		key := ns + "/" + wsName
		c.mu.Lock()
		c.lastActivity[key] = now
		c.lastPersisted[key] = now
		c.mu.Unlock()
	}
	return err
}

// workspaceURL returns the public URL for a workspace.
func (c *config) workspaceURL(wsName, username string) string {
	return "https://" + strings.ReplaceAll(c.workspaceHost, "{user}", hostLabel(wsName, username))
}

// hostLabel is the single DNS label a workspace lives under: "<user>-<slug>"
// (or "<user>" for a name without a slug). port-router maps it back to the
// Service ws-<label>.
func hostLabel(wsName, username string) string {
	if slug := workspaceSlug(wsName, username); slug != "" {
		return username + "-" + slug
	}
	return username
}

// workspaceSlug extracts the slug from a workspace name; "" when the name
// is not ws-<user>-<slug>.
func workspaceSlug(wsName, username string) string {
	prefix := "ws-" + username + "-"
	if strings.HasPrefix(wsName, prefix) {
		return wsName[len(prefix):]
	}
	return ""
}

// countActiveWorkspaces returns the number of running (replicas > 0)
// workspaces for a user.
func (c *config) countActiveWorkspaces(ctx context.Context, ns, username string) (int, error) {
	deps, err := c.k8s.AppsV1().Deployments(ns).List(ctx, metav1.ListOptions{
		LabelSelector: userLabel + "=" + username,
	})
	if err != nil {
		return 0, err
	}
	n := 0
	for _, dep := range deps.Items {
		if dep.Spec.Replicas != nil && *dep.Spec.Replicas > 0 {
			n++
		}
	}
	return n, nil
}

// autoPauseLoop checks every 5 minutes and scales down workspaces idle for
// longer than IDLE_TIMEOUT. Durable truth is the last-activity annotation, so
// manager restarts don't lose activity state and multiple replicas can run
// this loop concurrently (scale-to-0 is idempotent, patches are last-writer-
// wins on a monotonic timestamp). The same tick runs the stuck-start guard
// and the idle retention policy (lifecycle.go).
func (c *config) autoPauseLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		c.pauseIdleWorkspaces()
		c.sweepLifecycle()
	}
}

func (c *config) pauseIdleWorkspaces() {
	if c.idleTimeout <= 0 {
		return
	}
	ctx := context.Background()
	deps, err := c.k8s.AppsV1().Deployments(c.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: managedSelector,
	})
	if err != nil {
		slog.Warn("auto-pause: list deployments", "err", err)
		return
	}
	now := time.Now()
	c.mu.Lock()
	activity := make(map[string]time.Time, len(c.lastActivity))
	for k, v := range c.lastActivity {
		activity[k] = v
	}
	// Prune state for workspaces that no longer exist.
	names := make(map[string]bool, len(deps.Items))
	for _, dep := range deps.Items {
		names[dep.Namespace+"/"+dep.Name] = true
	}
	for k := range c.lastActivity {
		if !names[k] {
			delete(c.lastActivity, k)
			delete(c.lastPersisted, k)
		}
	}
	c.mu.Unlock()

	for _, dep := range deps.Items {
		if dep.Spec.Replicas == nil || *dep.Spec.Replicas == 0 {
			continue
		}
		if dep.Status.ReadyReplicas == 0 {
			continue // still starting, don't interrupt
		}
		// Freshest of: persisted annotation, this replica's in-memory view.
		key := dep.Namespace + "/" + dep.Name
		last := activity[key]
		if v, err := time.Parse(time.RFC3339, dep.Annotations[activityAnnotation]); err == nil && v.After(last) {
			last = v
		}
		if last.IsZero() {
			// Never-seen workspace (fresh manager): grant a full grace period
			// instead of pausing on the first tick.
			c.recordActivity(ctx, dep.Namespace, dep.Name, now)
			continue
		}
		if now.Sub(last) > c.idleTimeout {
			slog.Info("auto-pausing idle workspace", "namespace", dep.Namespace, "name", dep.Name, "idle_min", int(now.Sub(last).Minutes()))
			if err := c.scaleWorkspace(ctx, dep.Namespace, dep.Name, 0); err != nil {
				slog.Warn("auto-pause: scale failed", "name", key, "err", err)
			}
		}
	}
}

// ----------------------------------------------------------------------------
// Session management
// ----------------------------------------------------------------------------

// Cookie format: "v1.<b64url(payload JSON)>.<b64url(ed25519 sig over "v1.<payload>")>".
// Stateless: any manager replica (and any authproxy holding the public key)
// can verify a cookie minted by any other.

type sessionPayload struct {
	UPN  string `json:"upn"`
	Name string `json:"name"`
	Exp  int64  `json:"exp"`
}

func (c *config) signSession(upn, displayName string, expiry time.Time) string {
	payload, _ := json.Marshal(sessionPayload{UPN: upn, Name: displayName, Exp: expiry.Unix()})
	signed := "v1." + base64.RawURLEncoding.EncodeToString(payload)
	sig := ed25519.Sign(c.sessionPriv, []byte(signed))
	return signed + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func (c *config) parseSession(cookieVal string) (*session, error) {
	parts := strings.Split(cookieVal, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return nil, errors.New("malformed session cookie")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, errors.New("malformed signature")
	}
	if !ed25519.Verify(c.sessionPub, []byte(parts[0]+"."+parts[1]), sig) {
		return nil, errors.New("invalid signature")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errors.New("malformed payload")
	}
	var p sessionPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, errors.New("malformed payload")
	}
	if p.UPN == "" || time.Now().Unix() >= p.Exp {
		return nil, errors.New("expired session")
	}
	return &session{
		userUPN:     p.UPN,
		displayName: p.Name,
		expiry:      time.Unix(p.Exp, 0),
		cookieRaw:   cookieVal,
	}, nil
}

func (c *config) getSession(r *http.Request) *session {
	sc, err := r.Cookie("mw_session")
	if err != nil || sc.Value == "" {
		return nil
	}
	sess, err := c.parseSession(sc.Value)
	if err != nil {
		return nil
	}
	return sess
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

// workspaceLabels returns the label set stamped on every object of a
// workspace (and used as the Deployment/Service selector).
func workspaceLabels(username, wsName string) map[string]string {
	return map[string]string{
		managedByLabel: managedByValue,
		userLabel:      username,
		workspaceLabel: wsName,
	}
}

var (
	nonNameChar = regexp.MustCompile(`[^a-z0-9-]+`)
	hyphenRuns  = regexp.MustCompile(`-{2,}`)
)

func sanitizeName(s string) string {
	s = strings.ToLower(s)
	s = nonNameChar.ReplaceAllString(s, "-")
	// "--" is the segment separator in port-forward hostnames
	// (<port>--<user>-<slug>.<domain>), so names must never contain it.
	s = hyphenRuns.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 32 {
		s = strings.TrimRight(s[:32], "-")
	}
	if s == "" {
		s = "workspace"
	}
	return s
}

// reservedSlugs are names that must never become a workspace slug: they
// collide with infrastructure hostnames. The manager's own hostname label is
// added at startup.
var reservedSlugs = map[string]bool{
	"system": true, "default": true, "admin": true, "api": true,
	"auth": true, "www": true, "proxy": true, "workspace": true,
	"manager": true,
}

var dnsLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)

// validateSlug enforces DNS-1123 shape and the reserved list for explicit
// workspace names (rejected, not coerced).
func validateSlug(s string) error {
	if s == "" || len(s) > 32 {
		return errors.New("must be 1-32 characters")
	}
	if !dnsLabel.MatchString(s) {
		return errors.New("must be lowercase letters, digits and single hyphens")
	}
	if strings.Contains(s, "--") {
		return errors.New("must not contain --")
	}
	if reservedSlugs[s] {
		return fmt.Errorf("%q is reserved", s)
	}
	return nil
}

// slugFromRepo derives a workspace slug from a repo URL:
// https://github.com/example/My_Repo.git → "my-repo".
func slugFromRepo(repoURL string) string {
	u, err := url.Parse(repoURL)
	if err != nil {
		return sanitizeName(repoURL)
	}
	base := path.Base(strings.TrimSuffix(strings.TrimRight(u.Path, "/"), ".git"))
	return sanitizeName(base)
}

// cookieDomain strips the first DNS label so .foo.example.com covers all subdomains.
func cookieDomain(publicHost string) string {
	// strip port if present
	host := publicHost
	if i := strings.LastIndex(host, ":"); i > 0 && i > strings.LastIndex(host, "]") {
		host = host[:i]
	}
	if i := strings.Index(host, "."); i >= 0 {
		return host[i:] // e.g. .workspaces.example.com
	}
	return host
}

func (c *config) shortCookie(name, value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   c.cookieSecure,
		SameSite: http.SameSiteLaxMode,
	}
}

func isAlreadyExists(err error) bool {
	return apierrors.IsAlreadyExists(err)
}

func isNotFound(err error) bool {
	return apierrors.IsNotFound(err)
}

func boolPtr(b bool) *bool { return &b }

func randomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// clearCookie expires a shortCookie with the same attributes it was set with.
func (c *config) clearCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, c.shortCookie(name, "", -1))
}

// isLocalhost reports whether PUBLIC_HOST is a plain-http local address; the
// dev-only modes (DEV_USER, DEV_FAKE) and non-Secure cookies are gated on it.
func isLocalhost(publicHost string) bool {
	host := strings.SplitN(publicHost, ":", 2)[0]
	return host == "localhost" || host == "127.0.0.1"
}

// isValidRedirect reports whether s is a same-origin path we may send the
// browser to after login: a single leading "/" (not "//" or "/\", which
// browsers read as scheme-relative) and no scheme, host or userinfo.
func isValidRedirect(s string) bool {
	if !strings.HasPrefix(s, "/") || strings.HasPrefix(s, "//") || strings.HasPrefix(s, `/\`) {
		return false
	}
	if strings.ContainsAny(s, "\\\r\n") { // url.Parse does not treat "\" as a separator; browsers do
		return false
	}
	u, err := url.Parse(s)
	return err == nil && u.Scheme == "" && u.Host == "" && u.User == nil
}

// safeRedirectPath returns s when isValidRedirect accepts it, else "/".
func safeRedirectPath(s string) string {
	if isValidRedirect(s) {
		return s
	}
	return "/"
}

// logSafeMax caps user-controlled strings in log attributes.
const logSafeMax = 200

// logSafe makes a user-controlled string (username, slug, hostname, URL…)
// safe to log: it is truncated and CR/LF are stripped so a crafted value
// cannot forge log records. The JSON handler escapes them anyway; this keeps
// the guarantee independent of the handler.
func logSafe(s string) string {
	if len(s) > logSafeMax {
		cut := logSafeMax
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut] + "…"
	}
	s = strings.ReplaceAll(s, "\r", "")
	return strings.ReplaceAll(s, "\n", "")
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
		slog.Warn("ignoring invalid integer env var", "key", key, "value", v)
	}
	return fallback
}

func mustenv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		slog.Error("required env var not set", "key", key)
		os.Exit(1)
	}
	return v
}

func first(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func buildK8sConfig() (*rest.Config, error) {
	if kc := os.Getenv("KUBECONFIG"); kc != "" {
		return clientcmd.BuildConfigFromFlags("", kc)
	}
	if cfg, err := rest.InClusterConfig(); err == nil {
		return cfg, nil
	}
	home, _ := os.UserHomeDir()
	return clientcmd.BuildConfigFromFlags("", home+"/.kube/config")
}
