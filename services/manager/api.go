// JSON API consumed by the React portal (ui/portal), plus the embedded
// portal itself. Mutations require the X-CSRF-Token header (an HMAC of the
// session cookie, handed out by GET /api/v1/me).
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

//go:embed all:uidist
var uiFS embed.FS

// ----------------------------------------------------------------------------
// Plumbing
// ----------------------------------------------------------------------------

// requireAuthAPI is requireAuth for JSON callers: 401 instead of a login
// redirect, so fetch() can bounce the browser itself.
func (c *config) requireAuthAPI(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess := c.getSession(r)
		if sess == nil {
			writeJSONError(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		ctx := context.WithValue(r.Context(), sessionKey{}, sess)
		next(w, r.WithContext(ctx))
	}
}

// verifyCSRFHeader checks the X-CSRF-Token header (SPA mutations).
func (c *config) verifyCSRFHeader(r *http.Request, sess *session) bool {
	return hmac.Equal([]byte(r.Header.Get("X-CSRF-Token")), []byte(c.csrfFor(sess.cookieRaw)))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// writeOwnershipError maps getOwnedDeployment failures onto a JSON response.
// Ownership mismatches read as 404 so workspace existence doesn't leak.
func writeOwnershipError(w http.ResponseWriter, err error) {
	if errors.Is(err, errNotOwned) || apierrors.IsNotFound(err) {
		writeJSONError(w, http.StatusNotFound, "workspace not found")
		return
	}
	writeJSONError(w, http.StatusInternalServerError, "could not load workspace")
}

// ----------------------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------------------

func (c *config) meHandler(w http.ResponseWriter, r *http.Request) {
	sess := r.Context().Value(sessionKey{}).(*session)
	writeJSON(w, http.StatusOK, map[string]any{
		"upn":         sess.userUPN,
		"displayName": sess.displayName,
		"username":    sess.username(),
		"csrfToken":   c.csrfFor(sess.cookieRaw),
		"activeLimit": c.activeLimit,
	})
}

func (c *config) listWorkspacesHandler(w http.ResponseWriter, r *http.Request) {
	sess := r.Context().Value(sessionKey{}).(*session)
	deps, err := c.k8s.AppsV1().Deployments(c.namespace).List(r.Context(), metav1.ListOptions{
		LabelSelector: userLabel + "=" + sess.username(),
	})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "could not list workspaces")
		return
	}
	type wsOut struct {
		Name     string `json:"name"`
		Slug     string `json:"slug"`
		Repo     string `json:"repo"`
		URL      string `json:"url"`
		Replicas int32  `json:"replicas"`
		Ready    bool   `json:"ready"`
		// startFailed / idleDays / idleWarning / deleteAfterDays: the card
		// renders a failed start and the retention warning from these.
		lifecycleOut
	}
	out := []wsOut{}
	now := time.Now()
	for i := range deps.Items {
		dep := &deps.Items[i]
		replicas := int32(0)
		if dep.Spec.Replicas != nil {
			replicas = *dep.Spec.Replicas
		}
		out = append(out, wsOut{
			Name:         dep.Name,
			Slug:         workspaceSlug(dep.Name, sess.username()),
			Repo:         dep.Annotations[repoAnnotation],
			URL:          c.workspaceURL(dep.Name, sess.username()),
			Replicas:     replicas,
			Ready:        dep.Status.ReadyReplicas > 0,
			lifecycleOut: c.lifecycleFields(dep, now),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (c *config) createWorkspaceAPIHandler(w http.ResponseWriter, r *http.Request) {
	sess := r.Context().Value(sessionKey{}).(*session)
	if !c.verifyCSRFHeader(r, sess) {
		writeJSONError(w, http.StatusForbidden, "invalid CSRF token")
		return
	}
	var body struct {
		RepoURL string `json:"repoUrl"`
		Name    string `json:"name"`
		// Postgres defaults to true when omitted: users can't predict whether
		// they'll need a database, and the choice can't be changed later.
		Postgres *bool `json:"postgres"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "bad request")
		return
	}
	ctx := r.Context()
	opts := createOpts{
		repoURL:      strings.TrimSpace(body.RepoURL),
		postgres:     body.Postgres == nil || *body.Postgres,
		explicitName: strings.TrimSpace(body.Name) != "",
	}
	if opts.repoURL != "" {
		if err := validateRepoURL(opts.repoURL); err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	switch {
	case opts.explicitName:
		name := strings.TrimSpace(body.Name)
		if err := validateSlug(name); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid workspace name: "+err.Error())
			return
		}
		opts.slug = name
	case opts.repoURL != "":
		opts.slug = slugFromRepo(opts.repoURL)
		if reservedSlugs[opts.slug] {
			writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("derived name %q is reserved — set a name explicitly", opts.slug))
			return
		}
	default:
		writeJSONError(w, http.StatusBadRequest, "a repository URL or a name is required")
		return
	}
	active, err := c.countActiveWorkspaces(ctx, c.namespace, sess.username())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "could not check workspace limit")
		return
	}
	if active >= c.activeLimit {
		writeJSONError(w, http.StatusConflict, fmt.Sprintf("active workspace limit (%d) reached — pause a workspace first", c.activeLimit))
		return
	}
	if err := c.createWorkspace(ctx, sess, opts); err != nil {
		if errors.Is(err, errNameTooLong) {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		slog.Error("create workspace", "err", err, "user", logSafe(sess.userUPN), "slug", logSafe(opts.slug))
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"name": opts.slug})
}

// scaleWorkspaceAPIHandler backs both start (replicas=1, with limit check)
// and stop (replicas=0).
func (c *config) scaleWorkspaceAPIHandler(replicas int32) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess := r.Context().Value(sessionKey{}).(*session)
		if !c.verifyCSRFHeader(r, sess) {
			writeJSONError(w, http.StatusForbidden, "invalid CSRF token")
			return
		}
		ctx := r.Context()
		wsName := r.PathValue("name")
		dep, err := c.getOwnedDeployment(ctx, sess, c.namespace, wsName)
		if err != nil {
			writeOwnershipError(w, err)
			return
		}
		if replicas > 0 && (dep.Spec.Replicas == nil || *dep.Spec.Replicas == 0) {
			active, err := c.countActiveWorkspaces(ctx, c.namespace, sess.username())
			if err != nil {
				writeJSONError(w, http.StatusInternalServerError, "could not check workspace limit")
				return
			}
			if active >= c.activeLimit {
				writeJSONError(w, http.StatusConflict, fmt.Sprintf("active workspace limit (%d) reached — pause a workspace first", c.activeLimit))
				return
			}
		}
		if err := c.scaleWorkspace(ctx, c.namespace, wsName, replicas); err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func (c *config) deleteWorkspaceAPIHandler(w http.ResponseWriter, r *http.Request) {
	sess := r.Context().Value(sessionKey{}).(*session)
	if !c.verifyCSRFHeader(r, sess) {
		writeJSONError(w, http.StatusForbidden, "invalid CSRF token")
		return
	}
	ctx := r.Context()
	wsName := r.PathValue("name")
	if _, err := c.getOwnedDeployment(ctx, sess, c.namespace, wsName); err != nil {
		writeOwnershipError(w, err)
		return
	}
	if err := c.deleteWorkspace(ctx, c.namespace, wsName, sess.userUPN); err != nil {
		slog.Error("delete workspace", "err", err, "name", logSafe(wsName), "user", logSafe(sess.userUPN))
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (c *config) workspaceStatusAPIHandler(w http.ResponseWriter, r *http.Request) {
	sess := r.Context().Value(sessionKey{}).(*session)
	ctx := r.Context()
	wsName := r.PathValue("name")
	if _, err := c.getOwnedDeployment(ctx, sess, c.namespace, wsName); err != nil {
		writeOwnershipError(w, err)
		return
	}
	st := c.workspaceStatus(ctx, c.namespace, wsName)
	redirect := ""
	if st.Ready {
		redirect = c.workspaceURL(wsName, sess.username())
	}
	// phase/reason/unreadySeconds ride along (startStatus.detail) so the
	// portal can style a slow or troubled start.
	writeJSON(w, http.StatusOK, st.detail(map[string]any{
		"state": st.State, "ready": st.Ready, "message": st.Message, "redirect": redirect,
	}))
}

// validateRepoURL is the https-URL check for the optional repoUrl.
func validateRepoURL(repoURL string) error {
	u, err := url.Parse(repoURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || strings.Trim(u.Path, "/") == "" {
		return errors.New("repo URL must be an https URL like https://github.com/org/repo")
	}
	return nil
}

// ----------------------------------------------------------------------------
// SPA static serving
// ----------------------------------------------------------------------------

// spaHandler serves the embedded React portal: exact asset paths from the
// build, everything else falls back to index.html (client-side routing).
func (c *config) spaHandler(w http.ResponseWriter, r *http.Request) {
	sub, err := fs.Sub(uiFS, "uidist")
	if err != nil {
		http.Error(w, "ui not built", http.StatusInternalServerError)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path != "" {
		if f, err := sub.Open(path); err == nil {
			_ = f.Close()
			// Hashed assets can cache forever; index.html must not.
			if strings.HasPrefix(path, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			http.ServeFileFS(w, r, sub, path)
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFileFS(w, r, sub, "index.html")
}

// ----------------------------------------------------------------------------
// Platform status (feeds the portal status page)
// ----------------------------------------------------------------------------

// platformStatusHandler reports fleet-level health so users can distinguish
// "the platform is having a moment" from "my workspace is broken".
func (c *config) platformStatusHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	k8sOK := true

	running, starting, stuck := 0, 0, 0
	deps, err := c.k8s.AppsV1().Deployments(c.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: managedSelector,
	})
	if err != nil {
		k8sOK = false
	} else {
		for _, dep := range deps.Items {
			if dep.Spec.Replicas == nil || *dep.Spec.Replicas == 0 {
				continue
			}
			if dep.Status.ReadyReplicas > 0 {
				running++
			} else {
				starting++
			}
		}
	}
	// A pod pending/not-ready for >5 min means provisioning is degraded
	// (image pull, volume attach, scheduling).
	pods, err := c.k8s.CoreV1().Pods(c.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: managedSelector,
	})
	if err == nil {
		for _, p := range pods.Items {
			ready := false
			for _, cond := range p.Status.Conditions {
				if cond.Type == corev1.PodReady && cond.Status == corev1.ConditionTrue {
					ready = true
				}
			}
			if !ready && time.Since(p.CreationTimestamp.Time) > 5*time.Minute && p.DeletionTimestamp == nil {
				stuck++
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"clusterOk":   k8sOK,
		"running":     running,
		"starting":    starting,
		"stuck":       stuck,
		"generatedAt": time.Now().UTC().Format(time.RFC3339),
	})
}

// wsProbeHandler is a minimal RFC 6455 endpoint for the status page: the
// browser opens a real WebSocket over the same edge path the editor uses, so
// edge-level socket disruption is measured from the user's own vantage
// point. We complete the handshake, hold the connection up to 15s, and let
// the client close.
func (c *config) wsProbeHandler(w http.ResponseWriter, r *http.Request) {
	if c.getSession(r) == nil {
		writeJSONError(w, http.StatusUnauthorized, "not authenticated")
		return
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || key == "" {
		writeJSONError(w, http.StatusBadRequest, "websocket upgrade required")
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "hijack unsupported")
		return
	}
	conn, buf, err := hj.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	h := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	accept := base64.StdEncoding.EncodeToString(h[:])
	_, _ = buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n")
	_ = buf.Flush()
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	_, _ = io.Copy(io.Discard, conn) // hold until client closes or deadline
}

// registerAPIRoutes wires the JSON API routes onto the mux.
func (c *config) registerAPIRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/me", c.requireAuthAPI(c.meHandler))
	mux.HandleFunc("GET /api/v1/workspaces", c.requireAuthAPI(c.listWorkspacesHandler))
	mux.HandleFunc("POST /api/v1/workspaces", c.requireAuthAPI(c.createWorkspaceAPIHandler))
	mux.HandleFunc("POST /api/v1/workspaces/{name}/start", c.requireAuthAPI(c.scaleWorkspaceAPIHandler(1)))
	mux.HandleFunc("POST /api/v1/workspaces/{name}/stop", c.requireAuthAPI(c.scaleWorkspaceAPIHandler(0)))
	mux.HandleFunc("DELETE /api/v1/workspaces/{name}", c.requireAuthAPI(c.deleteWorkspaceAPIHandler))
	mux.HandleFunc("GET /api/v1/workspaces/{name}/status", c.requireAuthAPI(c.workspaceStatusAPIHandler))
	mux.HandleFunc("GET /api/v1/status", c.requireAuthAPI(c.platformStatusHandler))
	mux.HandleFunc("GET /api/v1/ws-probe", c.wsProbeHandler)
}
