package main

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestServiceForHost(t *testing.T) {
	rt := newRouter("workspaces", "workspaces.example.com:443", "status.example.com, ")
	cases := []struct {
		host, service string
		ok            bool
	}{
		// editor hosts
		{"anne-api.example.com", "ws-anne-api", true},
		{"anne-api.example.com:443", "ws-anne-api", true},
		{"Anne-API.Example.com", "ws-anne-api", true},
		// port hosts
		{"5173--anne-api.example.com", "ws-anne-api", true},
		{"3000--anne-api.example.com:443", "ws-anne-api", true},
		// refused
		{"workspaces.example.com", "", false},      // the portal (PUBLIC_HOST)
		{"WORKSPACES.example.com:8443", "", false}, // the portal, any case/port
		{"status.example.com", "", false},          // RESERVED_HOSTS
		{"anne-api--pilot.example.com", "", false}, // second segment without a port
		{"5173--a--b.example.com", "", false},      // too many segments
		{"5173--UPPER_x.example.com", "", false},
		{"-anne.example.com", "", false},
		{"anne-.example.com", "", false},
		{"99999999--anne-api.example.com", "", false}, // not a port
		{"5173--.example.com", "", false},
		{"", "", false},
		{strings.Repeat("a", 61) + ".example.com", "", false}, // ws-<61> > 63
	}
	for _, tc := range cases {
		svc, ok := rt.serviceForHost(tc.host)
		if svc != tc.service || ok != tc.ok {
			t.Errorf("serviceForHost(%q) = (%q, %v), want (%q, %v)", tc.host, svc, ok, tc.service, tc.ok)
		}
	}
}

func TestPublicHostIs404(t *testing.T) {
	rt := newRouter("workspaces", "workspaces.example.com", "")
	req := httptest.NewRequest("GET", "http://workspaces.example.com/api/v1/me", nil)
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("portal host: status %d, want 404", rec.Code)
	}
}

// The proxy must preserve the Host header, pass WebSocket upgrades through
// and flush streamed bodies as they are written. Every workspace Service
// "resolves" to a local test upstream through a swapped transport.
func TestProxyStreamsAndUpgrades(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") == "websocket" {
			conn, buf, err := w.(http.Hijacker).Hijack()
			if err != nil {
				return
			}
			defer conn.Close()
			_, _ = buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
			_ = buf.Flush()
			line, _ := buf.ReadString('\n')
			_, _ = conn.Write([]byte("echo:" + line))
			return
		}
		if r.Host != "5173--anne-api.example.com" {
			http.Error(w, "host not preserved: "+r.Host, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		time.Sleep(300 * time.Millisecond)
		_, _ = io.WriteString(w, "data: second\n\n")
	}))
	defer upstream.Close()

	rt := newRouter("workspaces", "workspaces.example.com", "")
	upAddr := strings.TrimPrefix(upstream.URL, "http://")
	var (
		mu     sync.Mutex
		dialed []string
	)
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			mu.Lock()
			dialed = append(dialed, addr)
			mu.Unlock()
			return (&net.Dialer{}).DialContext(ctx, network, upAddr)
		},
	}
	defer tr.CloseIdleConnections()
	rt.transport = tr
	front := httptest.NewServer(rt)
	defer front.Close()

	// Streaming: the first event must arrive well before the second is written.
	req, _ := http.NewRequest("GET", front.URL+"/events", nil)
	req.Host = "5173--anne-api.example.com"
	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(resp.Body)
	first, _ := br.ReadString('\n')
	if first != "data: first\n" || time.Since(start) > 250*time.Millisecond {
		t.Errorf("first event %q after %v: response was buffered", first, time.Since(start))
	}
	resp.Body.Close()

	// WebSocket upgrade through the proxy.
	conn, err := net.Dial("tcp", strings.TrimPrefix(front.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _ = io.WriteString(conn, "GET /ws HTTP/1.1\r\nHost: anne-api.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n")
	cr := bufio.NewReader(conn)
	status, _ := cr.ReadString('\n')
	if !strings.Contains(status, "101") {
		t.Fatalf("upgrade status %q", status)
	}
	mu.Lock()
	if len(dialed) == 0 {
		t.Error("nothing was dialed")
	}
	for _, addr := range dialed {
		if addr != "ws-anne-api.workspaces.svc:80" {
			t.Errorf("dialed %q, want ws-anne-api.workspaces.svc:80", addr)
		}
	}
	mu.Unlock()
	for {
		l, err := cr.ReadString('\n')
		if err != nil || l == "\r\n" {
			break
		}
	}
	_, _ = io.WriteString(conn, "ping\n")
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	echo, _ := cr.ReadString('\n')
	if echo != "echo:ping\n" {
		t.Errorf("echo over upgraded conn = %q", echo)
	}
}
