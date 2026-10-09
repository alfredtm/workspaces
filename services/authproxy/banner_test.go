package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func htmlResponse(h http.Header) *http.Response {
	if h == nil {
		h = http.Header{}
	}
	h.Set("Content-Type", "text/html; charset=utf-8")
	return &http.Response{StatusCode: 200, Header: h, Body: io.NopCloser(strings.NewReader("<html><body><h1>app</h1></body></html>"))}
}

// The banner carries its own dismiss control; the × is a label bound to a
// hidden checkbox and a <style> rule, so it works without inline script.
func TestDevBannerIsDismissable(t *testing.T) {
	resp := htmlResponse(nil)
	if err := injectDevBanner(resp); err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	out := string(body)
	for _, want := range []string{`id="ws-devbanner"`, `<label for="ws-devbanner-x"`, `#ws-devbanner-x:checked~#ws-devbanner{display:none}`, "not a deployment"} {
		if !strings.Contains(out, want) {
			t.Errorf("banner output lacks %q", want)
		}
	}
	if strings.Contains(out, "<script") {
		t.Error("banner must not need inline script")
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "</body></html>") {
		t.Errorf("banner must land before </body>, got tail %q", out[len(out)-40:])
	}
}

// In the editor's Preview (a frame) an app page gets the thin scrollbar style,
// first thing in <head>; the same page in its own tab does not.
func TestPreviewScrollbarOnlyInFrames(t *testing.T) {
	for _, dest := range []string{"iframe", "document"} {
		resp := htmlResponse(nil)
		resp.Body = io.NopCloser(strings.NewReader("<!doctype html><html><HEAD lang=en><title>t</title></HEAD><body>x</body></html>"))
		req, _ := http.NewRequest("GET", "http://x/", nil)
		req.Header.Set("Sec-Fetch-Dest", dest)
		resp.Request = req
		if err := injectDevBanner(resp); err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		out := string(body)
		has := strings.Contains(out, `id="workspace-preview-scrollbar"`)
		if dest == "iframe" && !strings.Contains(out, `<HEAD lang=en><style id="workspace-preview-scrollbar">`) {
			t.Errorf("iframe: style must follow <head>, got %q", out[:min(len(out), 120)])
		}
		if dest == "document" && has {
			t.Error("document: a page in its own tab must not get the preview style")
		}
		// the dev banner: in its own tab yes, inside the editor's Preview no
		banner := strings.Contains(out, `id="ws-devbanner"`)
		if dest == "iframe" && banner {
			t.Error("iframe: the Preview must not show the dev banner")
		}
		if dest == "document" && !banner {
			t.Error("document: an app in its own tab must show the dev banner")
		}
	}
}

// A platform upstream opts out with X-Workspace-Banner: off; the header never
// reaches the browser and the body is untouched.
func TestDevBannerOptOut(t *testing.T) {
	h := http.Header{}
	h.Set(noBannerHeader, "off")
	resp := htmlResponse(h)
	if err := injectDevBanner(resp); err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	if strings.Contains(string(body), "ws-devbanner") {
		t.Error("banner injected despite opt-out")
	}
	if resp.Header.Get(noBannerHeader) != "" {
		t.Error("opt-out header must be stripped")
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Error("no-store must still apply to opted-out responses")
	}
}
