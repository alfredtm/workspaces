// authproxy sits in front of the editor inside each workspace pod. It
// validates the mw_session cookie before proxying traffic, giving
// per-workspace access control.
//
// Session validation is local: cookies are Ed25519-signed by the manager and
// verified here with its public key (SESSION_PUBLIC_KEY), so the manager
// stays off the hot path. The session's user must equal WORKSPACE_OWNER.
//
// Activity: every byte proxied in either direction (including WebSocket
// frames after the 101 upgrade) refreshes an activity timestamp, which is
// reported to the manager every minute so auto-pause never fires on a
// workspace with a live editor connection.
//
// Routing:
//
//	/_workspace/healthz → 200 once the HEALTHZ_TARGET upstream listens (probe)
//	<port>--… host      → localhost:{port} at "/" (host-based port forward)
//	/proxy/{port}/...   → localhost:{port} inside the pod (path-based port forward)
//	everything else     → the editor on 127.0.0.1:13337
//
// The editor binds to 127.0.0.1:13337 and is unreachable directly.
package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
)

// devBanner is injected into HTML responses from /proxy/{port}/ so it is
// obvious the URL is a personal dev workspace and not a production deployment.
// Only when the app is opened on its own (a browser tab): inside the editor's
// Preview (Sec-Fetch-Dest: iframe) the editor itself says where you are.
// The × hides it for the rest of the page's life (it is back on the next load —
// that is the point). CSS-only on purpose: a checkbox + label + one <style>
// rule works under app CSPs that forbid inline scripts, and needs nothing the
// inline-styled banner did not already need. Colours: a loud pink → purple
// gradient that no real app is likely to use, so it can't be mistaken for
// part of the page.
const devBanner = `<input type="checkbox" id="ws-devbanner-x" style="display:none" aria-hidden="true">` +
	`<div id="ws-devbanner" role="status" style="position:fixed;top:0;left:0;right:0;z-index:999999;background:linear-gradient(90deg,#ec4899,#a855f7);color:#fff;font:500 13px/2.25rem system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:.01em;text-align:center;padding:0 2.5rem;box-shadow:0 2px 12px rgba(0,0,0,.25)">` +
	`<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#fff;margin-right:8px;vertical-align:1px;opacity:.9"></span>Dev workspace · only accessible to you · not a deployment` +
	`<label for="ws-devbanner-x" title="Hide until the next reload" aria-label="Hide banner" style="position:absolute;right:0;top:0;width:2.5rem;height:2.25rem;cursor:pointer;font-size:18px;line-height:2.25rem;opacity:.85">×</label></div>` +
	`<style>#ws-devbanner-x:checked~#ws-devbanner{display:none}</style>`

// ----------------------------------------------------------------------------
// Activity tracking
// ----------------------------------------------------------------------------

// activityTracker records the last moment any proxied byte moved. WebSocket
// traffic after the HTTP upgrade flows through trackedConn, so a user typing
// in an already-open editor tab still counts as active.
type activityTracker struct {
	last atomic.Int64 // unix nanos; 0 = never
}

func (t *activityTracker) touch() { t.last.Store(time.Now().UnixNano()) }

func (t *activityTracker) lastActive() time.Time {
	n := t.last.Load()
	if n == 0 {
		return time.Time{}
	}
	return time.Unix(0, n)
}

type trackedConn struct {
	net.Conn
	t *activityTracker
}

func (c *trackedConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.t.touch()
	}
	return n, err
}

func (c *trackedConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	if n > 0 {
		c.t.touch()
	}
	return n, err
}

// ----------------------------------------------------------------------------
// Session verification
// ----------------------------------------------------------------------------

// verifier authenticates requests against the manager's session public key.
type verifier struct {
	pub   ed25519.PublicKey
	owner string // WORKSPACE_OWNER: the sanitized username that owns this workspace

	// last cookie value that passed validation; used to authenticate
	// activity heartbeats as the workspace's user.
	lastGoodCookie atomic.Value // string
}

func (v *verifier) authenticate(r *http.Request) bool {
	var raw string
	for _, c := range r.Cookies() {
		if c.Name == "mw_session" {
			raw = c.Value
			break
		}
	}
	if raw == "" || !v.verifyLocal(raw) {
		return false
	}
	v.lastGoodCookie.Store(raw)
	return true
}

// verifyLocal checks the Ed25519-signed session cookie and that its user owns
// this workspace. Mirrors the manager's parseSession + ownership check.
func (v *verifier) verifyLocal(cookieVal string) bool {
	parts := strings.Split(cookieVal, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(v.pub, []byte(parts[0]+"."+parts[1]), sig) {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var p struct {
		UPN string `json:"upn"`
		Exp int64  `json:"exp"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || p.UPN == "" || time.Now().Unix() >= p.Exp {
		return false
	}
	// Exact match — name-prefix parsing would let user "anne" claim "ws-anne-b-*".
	return v.owner != "" && sanitizeName(strings.SplitN(p.UPN, "@", 2)[0]) == v.owner
}

var nonNameChar = regexp.MustCompile(`[^a-z0-9-]+`)
var hyphenRuns = regexp.MustCompile(`-{2,}`)

// sanitizeName mirrors the manager's username derivation — keep in sync.
func sanitizeName(s string) string {
	s = strings.ToLower(s)
	s = nonNameChar.ReplaceAllString(s, "-")
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

// ----------------------------------------------------------------------------
// Heartbeat
// ----------------------------------------------------------------------------

// heartbeatLoop reports the freshest activity timestamp to the manager so the
// auto-pause loop sees WebSocket-only sessions as active. Authenticated with
// the user's own session cookie — users can only keep their own workspaces
// awake.
func heartbeatLoop(managerURL, wsName string, tracker *activityTracker, v *verifier, interval time.Duration) {
	client := &http.Client{Timeout: 5 * time.Second}
	endpoint := managerURL + "/api/activity"
	var lastReported time.Time
	for range time.Tick(interval) {
		last := tracker.lastActive()
		if last.IsZero() || !last.After(lastReported) {
			continue
		}
		cookie, _ := v.lastGoodCookie.Load().(string)
		if cookie == "" {
			continue
		}
		body, _ := json.Marshal(map[string]string{
			"workspace":  wsName,
			"lastActive": last.UTC().Format(time.RFC3339),
		})
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "mw_session", Value: cookie})
		resp, err := client.Do(req)
		if err != nil {
			slog.Warn("activity heartbeat failed", "err", err)
			continue
		}
		resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
			// Session expired — wait for the next interactive request to
			// refresh the stored cookie.
			v.lastGoodCookie.Store("")
		case resp.StatusCode >= 300:
			slog.Warn("activity heartbeat rejected", "status", resp.StatusCode)
		default:
			lastReported = last
		}
	}
}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------

func main() {
	managerURL := mustenv("MANAGER_URL")
	managerPublicURL := mustenv("MANAGER_PUBLIC_URL")
	wsName := mustenv("WORKSPACE_NAME")
	owner := mustenv("WORKSPACE_OWNER")
	listen := getenv("LISTEN", ":8080")
	pub, err := base64.RawURLEncoding.DecodeString(mustenv("SESSION_PUBLIC_KEY"))
	if err != nil || len(pub) != ed25519.PublicKeySize {
		slog.Error("SESSION_PUBLIC_KEY must be the base64url raw Ed25519 public key", "err", err)
		os.Exit(1)
	}

	tracker := &activityTracker{}
	// All upstream conns (editor + port proxies) go through this transport so
	// hijacked WebSocket streams keep touching the tracker.
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			return &trackedConn{Conn: conn, t: tracker}, nil
		},
	}

	// The editor (Theia) listens on 127.0.0.1:13337. Readiness probe target
	// is the editor; HEALTHZ_TARGET overrides it.
	const editorAddr = "127.0.0.1:13337"
	healthzTarget := getenv("HEALTHZ_TARGET", editorAddr)
	upstream, _ := url.Parse("http://" + editorAddr)
	editorProxy := &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(upstream)
			r.Out.Host = upstream.Host
		},
	}

	v := &verifier{pub: ed25519.PublicKey(pub), owner: owner}

	loginURL := managerPublicURL + "/auth/login"

	go heartbeatLoop(managerURL, wsName, tracker, v, 60*time.Second)

	slog.Info("authproxy starting", "listen", listen, "workspace", wsName)

	srv := &http.Server{
		Addr:              listen,
		ReadHeaderTimeout: 10 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Probe endpoint: healthy only once the upstream at
			// HEALTHZ_TARGET is listening, so pod readiness means
			// "the workload is serving".
			if r.URL.Path == "/_workspace/healthz" {
				conn, err := net.DialTimeout("tcp", healthzTarget, 500*time.Millisecond)
				if err != nil {
					http.Error(w, "upstream not ready", http.StatusServiceUnavailable)
					return
				}
				conn.Close()
				_, _ = io.WriteString(w, "ok\n")
				return
			}

			if !v.authenticate(r) {
				target := loginURL + "?redirect_to=" + url.QueryEscape("https://"+r.Host+r.RequestURI)
				http.Redirect(w, r, target, http.StatusFound)
				return
			}
			tracker.touch()

			// Subdomain port-forward: host "<port>--<user>-<slug>.<domain>" serves
			// the dev server at "/" so SPA assets resolve. The port-router in
			// front of us preserves the original Host header for this.
			if port, ok := hostPort(r.Host); ok {
				handleHostPort(w, r, port, transport)
				return
			}

			if strings.HasPrefix(r.URL.Path, "/proxy/") {
				handlePortProxy(w, r, transport)
				return
			}
			editorProxy.ServeHTTP(w, r)
		}),
	}

	if err := srv.ListenAndServe(); err != nil {
		slog.Error("listen", "err", err)
		os.Exit(1)
	}
}

// handlePortProxy proxies /proxy/{port}/rest → http://127.0.0.1:{port}/rest.
// It injects a dev-warning banner into HTML responses.
func handlePortProxy(w http.ResponseWriter, r *http.Request, transport http.RoundTripper) {
	path := strings.TrimPrefix(r.URL.Path, "/proxy/")
	slash := strings.IndexByte(path, '/')
	var port, rest string
	if slash < 0 {
		port = path
		rest = "/"
	} else {
		port = path[:slash]
		rest = path[slash:]
	}
	if !isDigits(port) {
		http.NotFound(w, r)
		return
	}

	target, _ := url.Parse("http://127.0.0.1:" + port)
	proxy := &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = target.Host
			pr.Out.URL.Path = rest
			pr.Out.Header.Del("Accept-Encoding")
		},
		ModifyResponse: injectDevBanner,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			slog.Warn("port proxy error", "port", logSafe(port), "err", err)
			http.Error(w, fmt.Sprintf("nothing is listening on port %s", port), http.StatusBadGateway)
		},
	}
	proxy.ServeHTTP(w, r)
}

// logSafe makes a request-derived string safe to log: it is truncated and
// CR/LF are stripped so a crafted value cannot forge log records.
func logSafe(s string) string {
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	s = strings.ReplaceAll(s, "\r", "")
	return strings.ReplaceAll(s, "\n", "")
}

// hostPort returns the port encoded in a port-forward host
// ("<port>--<user>-<slug>.<domain>"): the leading DNS label split on "--" has a
// numeric first segment. Returns ok=false for the normal editor host.
func hostPort(host string) (string, bool) {
	if i := strings.LastIndexByte(host, ':'); i >= 0 && !strings.Contains(host[i:], "]") {
		host = host[:i] // strip :port
	}
	label := host
	if i := strings.IndexByte(host, '.'); i >= 0 {
		label = host[:i]
	}
	seg, _, found := strings.Cut(label, "--")
	if !found || !isDigits(seg) {
		return "", false
	}
	return seg, true
}

// handleHostPort proxies the request to http://127.0.0.1:<port> with the path
// left untouched (served at "/"), so SPA/Vite asset URLs resolve and HMR
// WebSockets upgrade cleanly.
func handleHostPort(w http.ResponseWriter, r *http.Request, port string, transport http.RoundTripper) {
	target, _ := url.Parse("http://127.0.0.1:" + port)
	proxy := &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target) // keeps the incoming path
			pr.Out.Host = target.Host
			pr.Out.Header.Del("Accept-Encoding") // so injectDevBanner can edit HTML
		},
		ModifyResponse: injectDevBanner,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			slog.Warn("host port proxy error", "port", port, "err", err)
			http.Error(w, fmt.Sprintf("nothing is listening on port %s", port), http.StatusBadGateway)
		},
	}
	proxy.ServeHTTP(w, r)
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// noBannerHeader lets a platform-owned upstream opt out of the dev banner
// (something the editor itself serves through a port URL is not a deployment
// preview). It is the sanctioned way for platform pieces to sit behind a port
// URL. Never forwarded to browsers.
const noBannerHeader = "X-Workspace-Banner"

// injectDevBanner is the ModifyResponse hook for the user's own apps (path- and
// host-based port proxies; never the editor). Besides the banner it disables
// caching: dev servers often send cacheable responses, and users then saw
// Claude's changes only after a hard refresh (Ctrl+Shift+R).
func injectDevBanner(resp *http.Response) error {
	resp.Header.Set("Cache-Control", "no-store")
	resp.Header.Del("Expires")
	resp.Header.Del("ETag")
	resp.Header.Del("Last-Modified")
	if strings.EqualFold(resp.Header.Get(noBannerHeader), "off") {
		resp.Header.Del(noBannerHeader)
		return nil
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "text/html") {
		return nil
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		return err
	}
	inFrame := resp.Request != nil && resp.Request.Header.Get("Sec-Fetch-Dest") == "iframe"
	var out []byte
	if inFrame {
		// the editor's Preview: no banner (the editor frames it), the editor's scrollbar instead
		out = withPreviewScrollbar(body)
	} else {
		out = bytes.Replace(body, []byte("</body>"), []byte(devBanner+"</body>"), 1)
		if bytes.Equal(out, body) {
			out = append(body, []byte(devBanner)...)
		}
	}
	resp.Body = io.NopCloser(bytes.NewReader(out))
	resp.ContentLength = -1
	resp.Header.Del("Content-Length")
	return nil
}

// previewScrollbar gives an app page shown in the editor's Preview (a frame: the
// browser sends Sec-Fetch-Dest: iframe) the thin, neutral scrollbar of the editor
// instead of the browser's thick light-grey rail. :where() has zero specificity
// and it goes first in <head>, so any scrollbar styling the app does itself still
// wins; the same app opened in its own tab is untouched. Same style as the shell
// agent's /preview/ route (services/shell/agent.js PREVIEW_SCROLLBAR_STYLE).
const previewScrollbar = `<style id="workspace-preview-scrollbar">:where(html){scrollbar-width:thin;scrollbar-color:rgba(128,128,128,.15) transparent}` +
	`:where(html:hover){scrollbar-color:rgba(128,128,128,.28) transparent}` +
	`:where(html) ::-webkit-scrollbar{width:8px;height:8px}:where(html) ::-webkit-scrollbar-track{background:transparent}` +
	`:where(html) ::-webkit-scrollbar-thumb{background:rgba(128,128,128,.15);border-radius:8px}` +
	`:where(html:hover) ::-webkit-scrollbar-thumb{background:rgba(128,128,128,.28)}</style>` +
	// A dark page usually paints its background on body or a wrapper and declares
	// no color-scheme, so the browser draws a white scrollbar track. Light body
	// text = a dark page → declare dark and give the track the colour behind the
	// page's right edge. Own color-scheme and light pages are left alone. Same
	// snippet as services/shell/agent.js PREVIEW_SCROLLBAR_STYLE.
	`<script id="workspace-preview-scheme">(function(){function f(){try{var d=document.documentElement,b=document.body;` +
	`if(!b||getComputedStyle(d).colorScheme!=='normal')return;var c=getComputedStyle(b).color.match(/[\d.]+/g);` +
	`if(!c||(0.2126*c[0]+0.7152*c[1]+0.0722*c[2])/255<=0.6)return;d.style.colorScheme='dark';` +
	`var e=document.elementFromPoint(innerWidth-24,innerHeight/2),bg='';for(;e&&!bg;e=e.parentElement){var s=getComputedStyle(e);` +
	`if(!/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(s.backgroundColor))bg=s.backgroundColor;else{var g=s.backgroundImage.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i);if(g)bg=g[0]}}` +
	`d.style.scrollbarColor='rgba(128,128,128,.28) '+(bg||'#0b0f1e')}catch(x){}}` +
	`document.readyState==='loading'?document.addEventListener('DOMContentLoaded',f):f();` +
	// The editor then sends its own colours (track = Preview header, thumb = the
	// chat's scrollbar); only from the embedding window, only plain colours.
	// The message key (workspacePreviewScrollbar) is shared with the editor's
	// Preview and the agent's copy of this snippet — keep them in sync.
	`var C=/^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\))$/i;addEventListener('message',function(m){var v=m.data&&m.data.workspacePreviewScrollbar;` +
	`if(m.source!==parent||!v||!C.test(v.thumb)||!C.test(v.track))return;var d=document.documentElement;` +
	`if(getComputedStyle(d).colorScheme==='normal'||d.style.colorScheme)d.style.colorScheme=v.dark?'dark':'light';` +
	`d.style.scrollbarColor=v.thumb+' '+v.track})})()</script>`

var headTag = regexp.MustCompile(`(?i)<head[^>]*>`)

func withPreviewScrollbar(html []byte) []byte {
	loc := headTag.FindIndex(html)
	if loc == nil {
		return append([]byte(previewScrollbar), html...)
	}
	out := make([]byte, 0, len(html)+len(previewScrollbar))
	out = append(out, html[:loc[1]]...)
	out = append(out, previewScrollbar...)
	return append(out, html[loc[1]:]...)
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
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
