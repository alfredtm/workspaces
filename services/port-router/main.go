// port-router is the backend for the single wildcard HTTPRoute (*.<domain>)
// and carries ALL workspace traffic: the editor and forwarded ports alike.
// Gateway API cannot pick a backend by parsing the hostname, and the
// workspace identity is encoded inside the single leading label (one
// wildcard certificate covers it), so this service parses the host and
// forwards to that workspace's Service. The workspace's authproxy then
// enforces auth and does the localhost hop.
//
// Flow:
//
//	GET https://<user>-<slug>.<domain>/...          (editor)
//	GET https://<port>--<user>-<slug>.<domain>/...  (forwarded port)
//	  → wildcard HTTPRoute → port-router
//	  → ws-<user>-<slug>.<WORKSPACE_NAMESPACE>.svc:80 (Host header preserved)
//	  → authproxy validates mw_session; a <port>-- host is proxied to
//	    127.0.0.1:<port> at "/", anything else goes to the editor
//
// No auth is done here — authproxy owns it. This service is a dumb,
// host-keyed reverse proxy that streams (WebSockets, SSE, long requests) and
// never buffers or times out a response. It only forwards hosts whose first
// label is a valid workspace name fragment, never the portal host
// (PUBLIC_HOST) or RESERVED_HOSTS, and 404s everything else.
//
// Environment:
//
//	WORKSPACE_NAMESPACE  (required) namespace of the workspace Services
//	PUBLIC_HOST          the portal host; never routed (port is ignored)
//	RESERVED_HOSTS       comma list of further hosts that are never routed
//	LISTEN               listen address, default :8080
package main

import (
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// nameFragment matches "<user>-<slug>": the sanitized, hyphen-joined charset
// the manager produces (no leading/trailing hyphen, no "--"), short enough
// that "ws-" + it is a valid object name (≤63).
var nameFragment = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

const maxFragment = 63 - len("ws-")

type router struct {
	namespace string
	reserved  map[string]bool   // lower-cased hosts without port
	transport http.RoundTripper // nil = http.DefaultTransport (tests swap it)
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))

	listen := getenv("LISTEN", ":8080")
	namespace := os.Getenv("WORKSPACE_NAMESPACE")
	if namespace == "" {
		slog.Error("required env var not set", "key", "WORKSPACE_NAMESPACE")
		os.Exit(1)
	}
	rt := newRouter(namespace, os.Getenv("PUBLIC_HOST"), os.Getenv("RESERVED_HOSTS"))
	if len(rt.reserved) == 0 {
		slog.Warn("PUBLIC_HOST is not set: a misrouted portal request would not be refused")
	}
	slog.Info("port-router starting", "listen", listen, "namespace", namespace)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.Handle("/", rt)

	// No ReadTimeout/WriteTimeout: the editor runs over long-lived WebSockets
	// and dev servers stream (HMR, SSE).
	srv := &http.Server{
		Addr:              listen,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("listen", "err", err)
		os.Exit(1)
	}
}

func newRouter(namespace, publicHost, reservedCSV string) *router {
	rt := &router{namespace: namespace, reserved: map[string]bool{}}
	for _, h := range append([]string{publicHost}, strings.Split(reservedCSV, ",")...) {
		if h = normalizeHost(h); h != "" {
			rt.reserved[h] = true
		}
	}
	return rt
}

func (rt *router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	service, ok := rt.serviceForHost(r.Host)
	if !ok {
		http.NotFound(w, r)
		return
	}
	// "<svc>.<ns>.svc" resolves through the pod's DNS search path, so the
	// cluster domain is not hard-coded.
	target := &url.URL{Scheme: "http", Host: service + "." + rt.namespace + ".svc:80"}
	origHost := r.Host
	proxy := &httputil.ReverseProxy{
		Transport: rt.transport,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = origHost // authproxy reads <port> from this
			pr.SetXForwarded()
		},
		// Flush every write immediately: streamed responses (SSE, chunked
		// dev-server output) must not sit in a buffer. Upgraded connections
		// (WebSockets) are spliced through by ReverseProxy on its own.
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			slog.Warn("upstream unreachable", "service", service, "namespace", rt.namespace, "err", err)
			http.Error(w, "workspace not reachable", http.StatusBadGateway)
		},
	}
	proxy.ServeHTTP(w, r)
}

// serviceForHost resolves a workspace host to its Service name:
//
//	"<user>-<slug>.<domain>"         → "ws-<user>-<slug>"  (editor)
//	"<port>--<user>-<slug>.<domain>" → "ws-<user>-<slug>"  (forwarded port)
//
// The leading DNS label is split on "--": one segment is the editor host,
// two segments need a numeric port first. Names never contain "--" (the
// manager collapses hyphen runs), so this is unambiguous. Reserved hosts and
// anything else return ok=false so we don't claim unrelated subdomains.
func (rt *router) serviceForHost(host string) (string, bool) {
	host = normalizeHost(host)
	if host == "" || rt.reserved[host] {
		return "", false
	}
	label := host
	if i := strings.IndexByte(host, '.'); i >= 0 {
		label = host[:i]
	}
	segs := strings.Split(label, "--")
	var name string
	switch len(segs) {
	case 1:
		name = segs[0]
	case 2:
		if !isDigits(segs[0]) {
			return "", false
		}
		name = segs[1]
	default:
		return "", false
	}
	if len(name) > maxFragment || !nameFragment.MatchString(name) {
		return "", false
	}
	return "ws-" + name, true
}

// normalizeHost lower-cases a host and strips its port.
func normalizeHost(host string) string {
	host = strings.ToLower(strings.TrimSpace(host))
	if i := strings.LastIndexByte(host, ':'); i >= 0 && !strings.Contains(host[i:], "]") {
		host = host[:i]
	}
	return strings.TrimSuffix(host, ".")
}

func isDigits(s string) bool {
	if s == "" || len(s) > 5 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
