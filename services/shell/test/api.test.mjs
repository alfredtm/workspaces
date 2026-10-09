// Integration tests for the workspace agent's HTTP surface. Spawns the real
// agent against a temp workspace root and exercises the API, with emphasis
// on the security guards (traversal, dotfiles).
//
//   cd services/shell && npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 17944;
const PAGE_PORT = 17948; // the agent's page server (PREVIEW_PORT)
const BASE = `http://127.0.0.1:${PORT}`;
const agentPath = join(dirname(fileURLToPath(import.meta.url)), "..", "agent.js");

let root;
let child;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "shell-test-"));
  writeFileSync(join(root, "hello.txt"), "hello world");
  writeFileSync(join(root, ".secret"), "top secret");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "nested.txt"), "nested");
  // symlink escaping the root must be unreachable
  symlinkSync(tmpdir(), join(root, "escape"));

  child = spawn(process.execPath, [agentPath], {
    env: { ...process.env, AGENT_PORT: String(PORT), WS_ROOT: root, HOME: root, PREVIEW_PORT: String(PAGE_PORT), VSCODE_PROXY_URI: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // wait for the server to answer
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE + "/api/ports");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("agent did not start");
});

after(() => {
  child?.kill();
  rmSync(root, { recursive: true, force: true });
});

test("the removed web UI routes are gone", async () => {
  for (const p of ["/", "/vendor/xterm.js", "/api/files/content?path=hello.txt", "/api/files/download?path=hello.txt"]) {
    assert.equal((await fetch(BASE + p, { redirect: "manual" })).status, 404, p);
  }
  assert.equal((await fetch(BASE + "/api/files/delete?path=hello.txt", { method: "POST" })).status, 404);
});

test("info names the workspace", async () => {
  const info = await (await fetch(BASE + "/api/info")).json();
  assert.equal(typeof info.workspace, "string");
  assert.ok("owner" in info && "displayName" in info);
});

test("listing shows files, hides top-level dotfiles", async () => {
  const r = await fetch(BASE + "/api/files?path=");
  const list = await r.json();
  const names = list.map((e) => e.name);
  assert.ok(names.includes("hello.txt"));
  assert.ok(names.includes("sub"));
  assert.ok(!names.includes(".secret"), "dotfiles must be hidden");
});

test("preview serves pages sandboxed, resolves folders to index.html, rejects traversal", async () => {
  mkdirSync(join(root, "game"), { recursive: true });
  writeFileSync(join(root, "game", "index.html"), "<h1>game</h1>");
  writeFileSync(join(root, "game", "style.css"), "h1{}");
  writeFileSync(join(root, "tetris.html"), "<canvas></canvas>");
  const page = await fetch(BASE + "/preview/tetris.html");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  assert.match(page.headers.get("content-security-policy"), /^sandbox allow-scripts/);
  assert.doesNotMatch(page.headers.get("content-security-policy"), /allow-same-origin/);
  // a thin themed scrollbar goes in front of the page (no <head>) or right after <head>
  assert.match(await page.text(), /^<style id="workspace-preview-scrollbar">.*<\/style><script id="workspace-preview-scheme">.*<\/script><canvas><\/canvas>$/s);
  writeFileSync(join(root, "headed.html"), "<html><HEAD><title>t</title></HEAD><body>x</body></html>");
  assert.match(await (await fetch(BASE + "/preview/headed.html")).text(), /^<html><HEAD><style id="workspace-preview-scrollbar">.*<\/script><title>/s);
  const dir = await fetch(BASE + "/preview/game/");
  assert.match(await dir.text(), /<h1>game<\/h1>$/);
  assert.equal(await (await fetch(BASE + "/preview/game/style.css")).text(), "h1{}");   // only HTML is touched
  assert.match((await fetch(BASE + "/preview/game/style.css")).headers.get("content-type"), /^text\/css/);
  for (const evil of ["..%2Fevil", ".secret", "escape/anything", "sub%2F..%2F..%2Fevil"]) {
    const r = await fetch(BASE + "/preview/" + evil);
    assert.notEqual(r.status, 200, `must reject ${evil}`);
  }
  const { base, pages } = await (await fetch(BASE + "/api/preview/pages")).json();
  assert.equal(base, null); // no per-port addresses here (no VSCODE_PROXY_URI): the Preview uses /preview/
  assert.deepEqual(pages.map((p) => p.path).sort(), ["game/index.html", "headed.html", "tetris.html"]);
});

test("page server serves pages on their own port, without the sandbox, read only", async () => {
  const PAGES = `http://127.0.0.1:${PAGE_PORT}`;
  writeFileSync(join(root, "store.html"), "<script>localStorage.x=1</script>");
  const page = await fetch(PAGES + "/store.html");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  assert.equal(page.headers.get("content-security-policy"), null); // its own origin: storage must work
  assert.equal(await page.text(), "<script>localStorage.x=1</script>"); // untouched (authproxy styles it in a pod)
  assert.equal(await (await fetch(PAGES + "/game/")).text(), "<h1>game</h1>");
  for (const evil of ["..%2Fevil", ".secret", "escape/anything", "sub%2F..%2F..%2Fevil"]) {
    assert.notEqual((await fetch(PAGES + "/" + evil)).status, 200, `must reject ${evil}`);
  }
  assert.equal((await fetch(PAGES + "/store.html", { method: "POST" })).status, 405);
  // and it never shows up as one of the user's apps
  const ports = await (await fetch(BASE + "/api/ports")).json();
  assert.ok(!ports.some((p) => p.port === PAGE_PORT));
});

test("listing rejects traversal", async () => {
  assert.equal((await fetch(BASE + "/api/files?path=sub")).status, 200);
  for (const evil of ["../evil", "..%2Fevil", ".secret", "escape", "sub/../../evil"]) {
    const r = await fetch(BASE + "/api/files?path=" + evil);
    assert.notEqual(r.status, 200, `must reject ${evil}`);
  }
});

test("upload streams, auto-renames, creates nested dirs, rejects bad paths", async () => {
  const up = (p, body = "data") =>
    fetch(BASE + "/api/files/upload?path=" + encodeURIComponent(p), { method: "POST", body });
  assert.equal((await (await up("new.txt")).json()).path, "new.txt");
  assert.equal((await (await up("new.txt")).json()).path, "new (2).txt");
  assert.equal((await (await up("a/b/c.txt")).json()).path, "a/b/c.txt");
  for (const evil of ["../x", ".hidden", "a/../../x", "a/.sneak/x"]) {
    assert.notEqual((await up(evil)).status, 200, `must reject ${evil}`);
  }
});

test("ports endpoint answers and hides infrastructure ports", async () => {
  const r = await fetch(BASE + "/api/ports");
  assert.equal(r.status, 200);
  const ports = await r.json();
  assert.ok(Array.isArray(ports));
  assert.ok(!ports.some((p) => [PORT, 13337, 13338, 8080, 5432].includes(p.port)));
});

test("env vars round-trip and reject bad names", async () => {
  const put = (o) => fetch(BASE + "/api/env", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
  assert.equal((await put({ MY_TOKEN: "sk-123", API_URL: "https://x" })).status, 200);
  const got = await (await fetch(BASE + "/api/env")).json();
  assert.equal(got.MY_TOKEN, "sk-123");
  assert.equal(got.API_URL, "https://x");
  // the generated shell file quotes values safely
  const sh = readFileSync(join(root, ".workspace", "env"), "utf8");
  assert.match(sh, /export MY_TOKEN='sk-123'/);
  assert.match(readFileSync(join(root, ".bashrc"), "utf8"), /\. ~\/\.workspace\/env/);
  // bad names rejected
  assert.equal((await put({ "2BAD": "x" })).status, 400);
  assert.equal((await put({ "has space": "x" })).status, 400);
  // clearing works
  assert.equal((await put({})).status, 200);
  assert.deepEqual(await (await fetch(BASE + "/api/env")).json(), {});
});

test("the terminal socket only runs the guided sign-ins", async () => {
  const closed = (q) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/term?${q}`);
    ws.onclose = (e) => resolve(e.code);
    ws.onerror = () => {};
  });
  for (const q of ["task=terminal", "task=main", "task=mcp-login&mode=guided", "task=gh-login"]) {
    assert.equal(await closed(q), 1008, q);
  }
});
