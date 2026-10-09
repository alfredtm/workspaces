// The workspace agent: the Theia editor's small backend inside each pod — single file, deps: ws + node-pty
// (optional). Binds 127.0.0.1 only; the editor reaches it through its /workspace-api proxy, behind authproxy.
//
//   AGENT_PORT=13338 PREVIEW_PORT=13339 WS_ROOT=~/workspace node agent.js
//
// Endpoints: GET  /api/info                  workspace name + owner
//            GET  /api/setup                 what is connected (GitHub CLI, Claude)
//            GET  /api/env, PUT /api/env     the user's environment variables (~/.workspace/env)
//            GET  /api/files?path=           dir listing rooted at WS_ROOT
//            POST /api/files/upload?path=    streamed upload (zips are unpacked)
//            GET  /api/ports                 listening TCP ports + open URLs
//            GET  /api/preview/pages         HTML pages for the Preview picker
//            GET  /preview/<path>            a workspace file as a sandboxed page
//            ANY  /proxy/<port>/...          path-based proxy to a local app (lab; authproxy does it in a pod)
//            WS   /term?task=…&mode=guided   guided sign-ins (gh-login, claude-login)
// Plus the page server on PREVIEW_PORT: workspace files as pages on an origin of their own.

"use strict";
const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");

let pty = null;
try {
  pty = require("node-pty");
} catch {
  console.error("node-pty unavailable — falling back to `script` for the PTY (no resize)");
}

const PORT = Number(process.env.AGENT_PORT || 13338);
const ROOT = fs.realpathSync(process.env.WS_ROOT || process.cwd());
const HOST_LABEL = process.env.WORKSPACE_HOST_LABEL || ""; // e.g. user-slug.domain
const PREVIEW_TYPES = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", json: "application/json",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm",
  txt: "text/plain; charset=utf-8", wasm: "application/wasm",
};
// HTML pages in the Preview get a thin, neutral scrollbar like the editor's own (the browser default is a thick
// light-grey rail with "always show scroll bars"). :where() gives it zero specificity and it goes first in <head>,
// so any scrollbar styling the page does itself still wins. Only for pages served here, never the user's file.
const PREVIEW_INJECT_MAX = 5 * 1024 * 1024;
// As subtle as the editor's own (dark theme: a #232327 thumb on #0b0f1e — 15% grey lands there on a dark page and
// still shows on a light one), a little stronger while the pointer is over the page.
const PREVIEW_SCROLLBAR_STYLE =
  '<style id="workspace-preview-scrollbar">:where(html){scrollbar-width:thin;scrollbar-color:rgba(128,128,128,.15) transparent}' +
  ":where(html:hover){scrollbar-color:rgba(128,128,128,.28) transparent}" +
  ":where(html) ::-webkit-scrollbar{width:8px;height:8px}:where(html) ::-webkit-scrollbar-track{background:transparent}" +
  ":where(html) ::-webkit-scrollbar-thumb{background:rgba(128,128,128,.15);border-radius:8px}" +
  ":where(html:hover) ::-webkit-scrollbar-thumb{background:rgba(128,128,128,.28)}</style>" +
  // A dark page usually paints its background on body or a wrapper, and declares no color-scheme: the browser then
  // draws the scrollbar track in the light default (white). Light body text = a dark page → declare dark, and give
  // the track the colour actually behind the page's right edge (first opaque background up from that point, or the
  // first colour of a gradient), so the scrollbar sits on the page's own colour. Pages with their own
  // color-scheme, and light pages, are left alone. (Same snippet in services/authproxy previewScrollbar.)
  '<script id="workspace-preview-scheme">(function(){function f(){try{var d=document.documentElement,b=document.body;' +
  "if(!b||getComputedStyle(d).colorScheme!=='normal')return;var c=getComputedStyle(b).color.match(/[\\d.]+/g);" +
  "if(!c||(0.2126*c[0]+0.7152*c[1]+0.0722*c[2])/255<=0.6)return;d.style.colorScheme='dark';" +
  "var e=document.elementFromPoint(innerWidth-24,innerHeight/2),bg='';for(;e&&!bg;e=e.parentElement){var s=getComputedStyle(e);" +
  "if(!/rgba\\(\\d+, \\d+, \\d+, 0\\)|transparent/.test(s.backgroundColor))bg=s.backgroundColor;else{var g=s.backgroundImage.match(/rgba?\\([^)]*\\)|#[0-9a-f]{3,8}/i);if(g)bg=g[0]}}" +
  "d.style.scrollbarColor='rgba(128,128,128,.28) '+(bg||'#0b0f1e')}catch(x){}}" +
  "document.readyState==='loading'?document.addEventListener('DOMContentLoaded',f):f();" +
  // The editor (preview-widget.tsx) then sends its own colours: track = the Preview header, thumb = the chat's
  // scrollbar. Only from the embedding window, only plain colour values.
  "var C=/^(#[0-9a-f]{3,8}|rgba?\\([\\d.,\\s%]+\\))$/i;addEventListener('message',function(m){var v=m.data&&m.data.workspacePreviewScrollbar;" +
  "if(m.source!==parent||!v||!C.test(v.thumb)||!C.test(v.track))return;var d=document.documentElement;" +
  "if(getComputedStyle(d).colorScheme==='normal'||d.style.colorScheme)d.style.colorScheme=v.dark?'dark':'light';" +
  "d.style.scrollbarColor=v.thumb+' '+v.track})})()</script>";
function withPreviewScrollbar(html) {
  const m = html.match(/<head[^>]*>/i);
  return m ? html.slice(0, m.index + m[0].length) + PREVIEW_SCROLLBAR_STYLE + html.slice(m.index + m[0].length) : PREVIEW_SCROLLBAR_STYLE + html;
}

// --- path safety: every file endpoint resolves inside ROOT or dies ---------
async function safeResolve(rel) {
  const p = path.resolve(ROOT, "." + path.sep + (rel || "."));
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) throw new Error("outside root");
  const real = await fsp.realpath(p); // resolves symlinks; must still be inside
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) throw new Error("outside root");
  const base = path.basename(real);
  if (base.startsWith(".") && path.dirname(real) === ROOT) throw new Error("hidden");
  return real;
}

// --- uploads ----------------------------------------------------------------
const MAX_UPLOAD = 200 * 1024 * 1024;

// Validate a client-supplied relative path (may contain subdirs from folder
// uploads). Rejects traversal and hidden segments.
function safeWritePath(rel) {
  const parts = String(rel).split("/").filter((s) => s && s !== ".");
  if (!parts.length || parts.some((s) => s === ".." || s.startsWith(".") || s.includes("\\")))
    throw new Error("bad path");
  const p = path.join(ROOT, ...parts);
  if (!p.startsWith(ROOT + path.sep)) throw new Error("outside root");
  return p;
}

// Never overwrite: report.csv → report (2).csv
async function uniquePath(p) {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  for (let i = 1; i < 1000; i++) {
    const cand = i === 1 ? p : path.join(dir, `${base} (${i})${ext}`);
    try {
      await fsp.access(cand);
    } catch {
      return cand;
    }
  }
  throw new Error("too many name collisions");
}

async function handleUpload(req, res, url) {
  let p = safeWritePath(url.searchParams.get("path") || "upload.bin");
  await fsp.mkdir(path.dirname(p), { recursive: true });
  p = await uniquePath(p);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(p, { flags: "wx" });
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        out.destroy();
        fs.unlink(p, () => {});
        reject(new Error("file too large (200MB max)"));
        req.destroy();
      }
    });
    out.on("error", reject);
    out.on("finish", resolve);
    req.on("error", reject);
    req.pipe(out);
  });
  // Zips get unpacked into a folder named after the archive, then removed.
  if (p.toLowerCase().endsWith(".zip")) {
    const dest = await uniquePath(p.slice(0, -4));
    try {
      await fsp.mkdir(dest, { recursive: true });
      await new Promise((resolve, reject) =>
        execFile("unzip", ["-q", "-n", p, "-d", dest], (err) => (err ? reject(err) : resolve())),
      );
      await fsp.unlink(p);
      return json(res, 200, { path: path.relative(ROOT, dest), extracted: true });
    } catch (e) {
      // no unzip / bad archive: keep the zip itself
      await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
      return json(res, 200, { path: path.relative(ROOT, p), extracted: false });
    }
  }
  json(res, 200, { path: path.relative(ROOT, p) });
}

// --- port detection ----------------------------------------------------------
// Processes that are part of the workspace itself, never a user's app: the editor
// (Theia backend + plugin host), the Claude Code extension's IDE
// server (random CLAUDE_CODE_SSE_PORT, one per window), OpenCode's own local
// server (the TUI starts one on a random port), authproxy, this agent.
// Matched against the owning process's cmdline (best effort via /proc).
const INFRA_CMD_RE = /plugin-host|lib\/backend\/main\.js|workspace-agent\/agent\.js|\bauthproxy\b|(^|\/)claude(\s|$)|(^|\/)opencode(\S*)? serve\b/;
function infraPorts() {
  // Socket inode -> owning cmdline, then flag infra owners. Also honour Claude's
  // IDE lock files (~/.claude/ide/<port>.lock) — cheaper and exact for that case.
  const infra = new Set();
  try {
    for (const f of fs.readdirSync(path.join(HOME_DIR, ".claude", "ide"))) {
      const m = f.match(/^(\d+)\.lock$/);
      if (m) infra.add(Number(m[1]));
    }
  } catch {}
  const inodeOwner = new Map();
  const inodePid = new Map(); // every process's sockets: which app process owns a listening port (appFolder)
  try {
    for (const pid of fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      let fds;
      try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      let cmd = "";
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim(); } catch {}
      const isInfra = INFRA_CMD_RE.test(cmd);
      for (const fd of fds) {
        let link;
        try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
        const m = link.match(/^socket:\[(\d+)\]$/);
        if (!m) continue;
        if (isInfra) inodeOwner.set(m[1], cmd);
        else inodePid.set(m[1], pid);
      }
    }
  } catch {}
  return { infra, inodeOwner, inodePid };
}

// The folder an app serves (see appFolder), as an absolute path — for its name when it lives outside ROOT.
function appDir(pid) {
  let cwd = "", args = [];
  try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return undefined; }
  try { args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); } catch {}
  const flag = args.findIndex((a) => a === "-d" || a === "--directory");
  if (flag !== -1 && args[flag + 1]) return path.resolve(cwd, args[flag + 1]);
  const eq = args.find((a) => a.startsWith("--directory="));
  return eq ? path.resolve(cwd, eq.slice("--directory=".length)) : cwd;
}

// A name for the Preview's picker instead of "Your app · port 4000": the page's own <title> (what the user sees
// in the app), else the folder it runs from. Titles are fetched from the app on localhost with a short timeout and
// cached per port for 30 s, so the 3-second port poll never waits on a slow app.
const titleCache = new Map(); // port -> { at, title }
const TITLE_TTL = 30000;
function htmlTitle(html) {
  const m = String(html).match(/<title[^>]*>([^<]{1,120})<\/title>/i);
  if (!m) return "";
  // &amp; last, so "&amp;lt;" becomes "&lt;" and not "<" (no double unescaping)
  return m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
function appTitle(port) {
  const hit = titleCache.get(port);
  if (hit && Date.now() - hit.at < TITLE_TTL) return Promise.resolve(hit.title);
  return new Promise((resolve) => {
    const done = (title) => { titleCache.set(port, { at: Date.now(), title }); resolve(title); };
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 800, headers: { accept: "text/html" } }, (res) => {
      if (!/text\/html/i.test(res.headers["content-type"] || "")) { res.resume(); return done(""); }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { buf += c; if (buf.length > 64 * 1024 || /<\/title>/i.test(buf)) { req.destroy(); done(htmlTitle(buf)); } });
      res.on("end", () => done(htmlTitle(buf)));
      res.on("error", () => done(""));
    });
    req.on("timeout", () => { req.destroy(); done(""); });
    req.on("error", () => done(""));
  });
}

// The project an app belongs to: the top-level folder under ROOT it serves. A directory argument wins
// (`python -m http.server -d ~/shop`, `--directory`, `serve <dir>`-style last arg that is a folder), else the
// process's working directory. "" = the workspace root itself; undefined = somewhere else, or unknown.
// The editor's Preview follows the OpenCode tab's project with it (preview-widget.tsx).
function appFolder(pid) {
  let cwd = "", args = [];
  try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return undefined; }
  try { args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); } catch {}
  let dir = cwd;
  const flag = args.findIndex((a) => a === "-d" || a === "--directory");
  if (flag !== -1 && args[flag + 1]) dir = path.resolve(cwd, args[flag + 1]);
  else {
    const eq = args.find((a) => a.startsWith("--directory="));
    if (eq) dir = path.resolve(cwd, eq.slice("--directory=".length));
  }
  let real;
  try { real = fs.realpathSync(dir); } catch { return undefined; }
  if (real === ROOT) return "";
  if (!real.startsWith(ROOT + path.sep)) return undefined;
  return path.relative(ROOT, real).split(path.sep)[0];
}

function readProcPorts() {
  const out = [];
  const { infra, inodeOwner, inodePid } = infraPorts();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let data;
    try {
      data = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of data.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== "0A") continue; // 0A = LISTEN
      const [addr, portHex] = cols[1].split(":");
      const port = parseInt(portHex, 16);
      const wildcard = /^0+$/.test(addr);
      // 127.0.0.1 (v4, little-endian "0100007F") and ::1 (v6) count too:
      // authproxy dials 127.0.0.1:<port> for every access model, so a
      // loopback-bound dev server — the DEFAULT for Vite/Next/Flask/CRA/Rails —
      // is just as reachable as a 0.0.0.0 one. Only marking wildcard reachable
      // hid the button for the common case.
      const loopback = addr === "0100007F" || addr === "00000000000000000000000001000000";
      if (infra.has(port) || (cols[9] && inodeOwner.has(cols[9]))) continue; // editor/Claude/agent, not an app
      if (!out.some((p) => p.port === port)) {
        const pid = cols[9] && inodePid.get(cols[9]);
        const folder = pid ? appFolder(pid) : undefined;
        const dir = pid ? appDir(pid) : undefined;
        const dirName = dir && dir !== ROOT && dir !== HOME_DIR ? path.basename(dir) : "";
        out.push({ port, reachable: wildcard || loopback, ...(folder !== undefined ? { folder } : {}), ...(dirName ? { dirName } : {}) });
      }
    }
  }
  return out.sort((a, b) => a.port - b.port);
}

function lsofPorts(cb) {
  // macOS fallback, so the agent runs on a laptop too
  execFile("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"], (err, stdout) => {
    if (err) return cb([]);
    const out = [];
    for (const line of stdout.split("\n").slice(1)) {
      const m = line.match(/^(\S+).* (?:\*|0\.0\.0\.0|\[?::\]?):(\d+) \(LISTEN\)/);
      if (m) {
        const port = Number(m[2]);
        if (!out.some((p) => p.port === port)) out.push({ port, reachable: true, proc: m[1] });
      }
    }
    cb(out.sort((a, b) => a.port - b.port));
  });
}

function openURL(port) {
  // The full workspace host lives in VSCODE_PROXY_URI
  // (https://<user>-<slug>.<domain>/proxy/{{port}}/) —
  // WORKSPACE_HOST_LABEL alone is just the leftmost DNS label.
  const m = (process.env.VSCODE_PROXY_URI || "").match(/^https?:\/\/([^/]+)/);
  if (m) return `https://${port}--${m[1]}/`;
  if (!HOST_LABEL || !HOST_LABEL.includes(".")) return null;
  const [head, ...rest] = HOST_LABEL.split(".");
  return `https://${port}--${head}.${rest.join(".")}/`;
}

// Pre-seed Claude Code config: first run otherwise blocks on a theme picker
// and trust dialog — in a hidden PTY that means hanging forever, and in a
// terminal it's ceremony users shouldn't see. Dark mode, done.
try {
  const claudeCfg = path.join(os.homedir(), ".claude.json");
  // MERGE into whatever exists: the user (or an earlier `claude` run) may have
  // created this file already, and a create-if-missing seed would then be skipped.
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(claudeCfg, "utf8")); } catch {}
  let dirty = false;
  if (!cfg.theme) { cfg.theme = "dark"; dirty = true; }
  if (!cfg.hasCompletedOnboarding) { cfg.hasCompletedOnboarding = true; dirty = true; }
  cfg.projects = cfg.projects || {};
  const proj = (cfg.projects[ROOT] = cfg.projects[ROOT] || {});
  if (!proj.hasTrustDialogAccepted || !proj.hasCompletedProjectOnboarding) {
    proj.hasTrustDialogAccepted = true;
    proj.hasCompletedProjectOnboarding = true;
    dirty = true;
  }
  if (dirty) fs.writeFileSync(claudeCfg, JSON.stringify(cfg, null, 2));
} catch (e) {
  console.error("claude config seed failed:", e.message);
}

// --- http -------------------------------------------------------------------
function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

let setupCache = null; // { at, body } — see /api/setup
const OWN_PORT = PORT;
// The page server (servePreviewFile, below): HTML files for the editor's Preview, on a port of their own so that in
// a pod they get their own origin (`<port>--<host>`, through authproxy like any app).
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT || 13339);
// self, page server, editor, authproxy, postgres, the editor's assistant servers (opencode serve, Pi)
const HIDDEN_PORTS = new Set([OWN_PORT, PREVIEW_PORT, 13337, 13338, 8080, 5432, Number(process.env.OPENCODE_PORT || 4097), Number(process.env.PI_PORT || 4099)]);

/**
 * One workspace file as a web page for the Preview: folders resolve to index.html, relative assets next to it.
 * `sandbox` (the /preview/ route on the editor's own origin, the lab's fallback): a CSP sandbox = an opaque origin,
 * so the page can never script the editor — at the price of no browser storage (localStorage throws). The page
 * server on PREVIEW_PORT serves without it: its origin is not the editor's, so pages get storage like any app.
 */
async function servePreviewFile(req, res, rawRel, { sandbox }) {
  let f = await safeResolve(decodeURIComponent(rawRel));
  if ((await fsp.stat(f)).isDirectory()) f = await safeResolve(path.relative(ROOT, path.join(f, "index.html")));
  res.writeHead(200, {
    "content-type": PREVIEW_TYPES[path.extname(f).slice(1).toLowerCase()] || "application/octet-stream",
    ...(sandbox ? { "content-security-policy": "sandbox allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock" } : {}),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") return res.end();
  // the scrollbar style: authproxy adds it to frames in a pod, the page server's pages pass through it there
  if (sandbox && /\.html?$/i.test(f)) {
    const st = await fsp.stat(f);
    if (st.size <= PREVIEW_INJECT_MAX) return res.end(withPreviewScrollbar(await fsp.readFile(f, "utf8")));
  }
  return fs.createReadStream(f).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    // Path-based proxy so "Open your app" works without authproxy (the lab, a port-forward).
    // (In a pod authproxy provides /proxy/{port}/.)
    const prox = url.pathname.match(/^\/proxy\/(\d+)(\/.*)?$/);
    if (prox) {
      // In the editor's Preview (a frame) HTML pages get the thin scrollbar style, like authproxy does in a pod
      // (services/authproxy injectDevBanner). Ask for an uncompressed body so it can be edited.
      const inFrame = req.headers["sec-fetch-dest"] === "iframe";
      const headers = { ...req.headers, host: "127.0.0.1" };
      // No revalidation either: a 304 would hand the browser its cached copy, injected by an older style
      // (authproxy sets no-store on app responses for the same reason).
      if (inFrame) { delete headers["accept-encoding"]; delete headers["if-none-match"]; delete headers["if-modified-since"]; }
      const upstream = http.request(
        { host: "127.0.0.1", port: Number(prox[1]), path: (prox[2] || "/") + url.search, method: req.method, headers },
        (up) => {
          if (inFrame && /text\/html/i.test(up.headers["content-type"] || "") && !up.headers["content-encoding"]) {
            const chunks = [];
            up.on("data", (c) => chunks.push(c));
            up.on("end", () => {
              const h = { ...up.headers, "cache-control": "no-store" };
              delete h["content-length"]; delete h["etag"]; delete h["last-modified"]; delete h["expires"];
              res.writeHead(up.statusCode, h);
              res.end(withPreviewScrollbar(Buffer.concat(chunks).toString("utf8")));
            });
            return;
          }
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => json(res, 502, { error: "app not reachable" }));
      return req.pipe(upstream);
    }
    if (url.pathname === "/api/files") {
      const dir = await safeResolve(url.searchParams.get("path"));
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        if (e.name.startsWith(".") && dir === ROOT) continue;
        let st = null;
        try {
          st = await fsp.stat(path.join(dir, e.name));
        } catch {
          continue;
        }
        out.push({
          name: e.name,
          dir: st.isDirectory(),
          size: st.size,
          mtime: st.mtimeMs,
          path: path.relative(ROOT, path.join(dir, e.name)),
        });
      }
      out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
      return json(res, 200, out);
    }
    // The editor's Preview pane shows plain HTML files (a game in one tetris.html,
    // a static site) without a dev server: files are served as web pages, so
    // relative assets (style.css, img/…) resolve next to them. The page runs in a
    // CSP sandbox — an opaque origin — so it can never script the editor, which
    // shares this origin, not even when opened in a tab of its own.
    if (url.pathname.startsWith("/preview/") && (req.method === "GET" || req.method === "HEAD")) {
      // await: a rejected path must land in the catch below, not escape as an unhandled rejection (fatal in Node)
      return await servePreviewFile(req, res, url.pathname.slice("/preview/".length), { sandbox: true });
    }
    if (url.pathname === "/api/preview/pages") {
      // HTML pages worth offering in the Preview picker: the workspace root and one
      // level down, newest first (the one the assistant just wrote is on top).
      const pages = [];
      const scan = async (dir, depth) => {
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { if (depth > 0) await scan(p, depth - 1); continue; }
          if (!/\.html?$/i.test(e.name)) continue;
          try {
            const st = await fsp.stat(p);
            // the page's <title> names it in the Preview's picker ("Tetris" rather than tetris.html)
            let title = "";
            try { const fh = await fsp.open(p, "r"); try { const { bytesRead, buffer } = await fh.read(Buffer.alloc(16384), 0, 16384, 0); title = htmlTitle(buffer.subarray(0, bytesRead).toString("utf8")); } finally { await fh.close(); } } catch { /* unreadable */ }
            pages.push({ path: path.relative(ROOT, p), mtime: st.mtimeMs, ...(title ? { title } : {}) });
          } catch { /* vanished */ }
        }
      };
      await scan(ROOT, 1);
      pages.sort((a, b) => b.mtime - a.mtime);
      // base: where the Preview loads pages from — the page server's own address in a pod (a real origin: storage
      // works, the editor is out of reach), null where ports have no address of their own (the lab: it falls back
      // to the sandboxed /preview/ route on the editor's origin).
      return json(res, 200, { base: openURL(PREVIEW_PORT), pages: pages.slice(0, 20) });
    }
    if (url.pathname === "/api/files/upload" && req.method === "POST") {
      return await handleUpload(req, res, url);
    }
    if (url.pathname === "/api/env" && req.method === "GET") {
      return json(res, 200, readEnvVars());
    }
    if (url.pathname === "/api/env" && req.method === "PUT") {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 256 * 1024) throw new Error("too large");
        chunks.push(c);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const out = {};
      for (const [k, v] of Object.entries(body || {})) {
        if (!ENV_KEY_RE.test(k)) return json(res, 400, { error: `Invalid name: ${k}` });
        out[k] = String(v ?? "");
      }
      writeEnvVars(out);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/info") {
      // Who and where: the brand shows "<slug> Workspace", the sidebar footer shows the owner.
      const n = process.env.WORKSPACE_NAME || "", owner = process.env.WORKSPACE_OWNER || "";
      const prefix = "ws-" + owner + "-";
      const workspace = n.startsWith(prefix) && n.length > prefix.length ? n.slice(prefix.length) : path.basename(ROOT);
      const displayName = owner.split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
      return json(res, 200, { workspace, owner, displayName });
    }
    if (url.pathname === "/api/setup") {
      // What's already connected (and as whom)? Drives the wizard, settings and the account row.
      // The probes take seconds (gh/claude) — serve a result younger than 20s straight away.
      if (setupCache && Date.now() - setupCache.at < 20000) return json(res, 200, setupCache.body);
      const check = (cmd, args, parse) =>
        new Promise((r) => {
          execFile(cmd, args, { timeout: 10000 }, (err, stdout, stderr) =>
            r(err ? { ok: false } : { ok: true, user: parse((stdout || "") + (stderr || "")) || "" }),
          );
        });
      const [gh, claude] = await Promise.all([
        check("gh", ["auth", "status"], (out) => (out.match(/account (\S+)/i) || [])[1]),
        check(
          "bash",
          // ANTHROPIC_API_KEY deliberately does NOT count: an API key outranks
          // the user's own sign-in and bills all usage as API tokens. It still
          // works, but the wizard offers the sign-in.
          // Only a real ACCOUNT login counts. The credentials file can also exist
          // carrying just an `mcpOAuth` section after an MCP server sign-in —
          // testing mere file existence showed a false "Claude connected".
          // Require a claudeAiOauth access token instead.
          ["-lc", "test -n \"$CLAUDE_CODE_OAUTH_TOKEN\" || jq -e '((.claudeAiOauth.accessToken // \"\") | length) > 0' ~/.claude/.credentials.json >/dev/null 2>&1"],
          () => "",
        ),
      ]);
      setupCache = { at: Date.now(), body: { gh, claude } };
      return json(res, 200, setupCache.body);
    }
    if (url.pathname === "/api/ports") {
      const finish = async (ports) => {
        const shown = ports.filter((p) => !HIDDEN_PORTS.has(p.port));
        // name = the app's <title>, else the folder it serves (cached; see appTitle)
        const titles = await Promise.all(shown.map((p) => (p.reachable ? appTitle(p.port) : Promise.resolve(""))));
        json(res, 200, shown.map((p, i) => {
          const name = titles[i] || p.dirName || "";
          const { dirName, ...rest } = p;
          return { ...rest, ...(name ? { name } : {}), openUrl: p.reachable ? openURL(p.port) : null };
        }));
      };
      if (os.platform() === "linux") return finish(readProcPorts());
      return lsofPorts(finish);
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    // Our guards throw plain Errors with short messages meant for the UI; the
    // exception object itself (stack, absolute paths) stays server-side.
    console.error("api error:", url.pathname, e);
    json(res, 400, { error: e instanceof Error ? e.message : "request failed" });
  }
});

// --- guided sign-ins ----------------------------------------------------------
const wss = new WebSocketServer({ server, path: "/term" });

// Named tasks: every sign-in the editor can start maps to one fixed command,
// run in a PTY of its own.
const TASKS = {
  // NO_COLOR skips termenv's background-color query, which otherwise stalls
  // 5s waiting for a terminal reply our hidden PTY can't deliver.
  "gh-login": "NO_COLOR=1 GH_PROMPT_DISABLED=1 gh auth login --hostname github.com --git-protocol https --web",
  // The real interactive login — NOT setup-token, which mints a plan-less
  // personal token with no organization context. Old-style env tokens are
  // stripped first: they would outrank the fresh credentials file.
  "claude-login":
    "sed -i '/CLAUDE_CODE_OAUTH_TOKEN/d' ~/.bashrc ~/.profile 2>/dev/null; " +
    "NO_COLOR=1 env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY claude /login",
};

// Guided mode: the PTY runs hidden; we parse its output and stream structured
// events the frontend renders as a friendly dialog. `auto` entries answer the
// command's prompts so the user never has to; `answers` are typed from what the
// user enters in the dialog (`creds` messages).
const GUIDED = {
  "gh-login": {
    auto: [
      { re: /\(Y\/n\)/i, send: "Y\r" },
      { re: /Press Enter/i, send: "\r" },
    ],
    code: /one-time code: ([A-Z0-9-]{6,})/i,
    // Host and path are literal; the URL runs to whitespace or end of output.
    url: /(https:\/\/github\.com\/login\/device[^\s]*)(?=\s|$)/i,
    done: /Logged in as (\S+)/i,
  },
  "claude-login": {
    auto: [
      // "Select login method" — option 1 (Claude account with subscription,
      // which covers Team/Enterprise) is preselected: Enter.
      { re: /select\s*login\s*method/i, send: "\r" },
      // An organization's managed-settings approval can appear right after
      // auth, inside this hidden PTY (option 1 is preselected).
      { re: /managed\s*settings\s*require\s*approval/i, send: "\r" },
    ],
    // Host anchored to the trusted domains (CodeQL: no evil.com/?x=claude.com matches).
    url: /(https:\/\/(?:[\w-]+\.)*(?:anthropic\.com|claude\.(?:ai|com))(?:\/[^\s\x1b\x07]*)?)/i,
    answers: [{ re: /paste\s*code\s*here/i, key: "code" }],
    retryErr: /invalid\s*code|oauth\s*error/i,
    // claude writes ~/.claude/.credentials.json itself — nothing to persist.
    // Success shows a login confirmation or drops into the normal UI.
    done: /logg?ed in successfully|login successful|logged in as|\? for shortcuts/i,
  },
};
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?>=]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\r\x07]/g, "");

// --- user environment variables / secrets ----------------------------------
// Source of truth is ~/.workspace/env.json; we generate a shell file from it and
// make every login shell source it, so terminals and apps see the vars. The
// agent also merges them into every PTY it spawns.
const HOME_DIR = process.env.HOME || os.homedir();
const ENV_DIR = path.join(HOME_DIR, ".workspace");
const ENV_JSON = path.join(ENV_DIR, "env.json");
const ENV_SH = path.join(ENV_DIR, "env");
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function readEnvVars() {
  try {
    const o = JSON.parse(fs.readFileSync(ENV_JSON, "utf8"));
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
// BASH_ENV must point at a file that always exists, or every `bash -c` errors.
function ensureEnvFile() {
  try {
    fs.mkdirSync(ENV_DIR, { recursive: true });
    fs.writeFileSync(ENV_SH, "", { flag: "wx", mode: 0o600 }); // EEXIST when already there
  } catch {}
}
ensureEnvFile();
const shQuote = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
function writeEnvVars(obj) {
  fs.mkdirSync(ENV_DIR, { recursive: true });
  fs.writeFileSync(ENV_JSON, JSON.stringify(obj, null, 2), { mode: 0o600 });
  const body = Object.entries(obj).map(([k, v]) => `export ${k}=${shQuote(v)}`).join("\n");
  fs.writeFileSync(ENV_SH, body + "\n", { mode: 0o600 });
  // ensure each login shell sources it (once)
  const src = "[ -f ~/.workspace/env ] && . ~/.workspace/env";
  for (const f of [".bashrc", ".zshrc", ".profile"]) {
    const p = path.join(HOME_DIR, f);
    let c = "";
    try { c = fs.readFileSync(p, "utf8"); } catch {}
    if (!c.includes(".workspace/env")) {
      try { fs.appendFileSync(p, `\n${src}\n`); } catch {}
    }
  }
}

function spawnTaskPTY(shell, onData, onExit, cols = 80) {
  // Two levers so newly-saved secrets reach running processes without a restart:
  //   CLAUDE_ENV_FILE — Claude Code sources this before *every* Bash tool call.
  //     Claude snapshots the shell once at launch and does NOT re-read
  //     .bashrc/BASH_ENV per command, so this is the ONLY thing that reaches a
  //     running Claude; a var added after it started shows up on its next call.
  //   BASH_ENV — a fresh `bash -c` (apps the user starts, plain terminals)
  //     sources this at startup.
  // readEnvVars() seeds the interactive shell's own env at spawn time.
  const childEnv = { ...process.env, BASH_ENV: ENV_SH, CLAUDE_ENV_FILE: ENV_SH, ...readEnvVars() };
  if (pty) {
    try {
      const t = pty.spawn(process.env.SHELL || "bash", ["-lc", shell], {
        name: "xterm-256color",
        cols,
        rows: 24,
        cwd: ROOT,
        env: childEnv,
      });
      t.onData(onData);
      t.onExit(onExit);
      return t;
    } catch (e) {
      console.error("node-pty spawn failed, falling back to `script`:", e.message);
    }
  }
  const { spawn } = require("child_process");
  const args =
    os.platform() === "darwin" ? ["-q", "/dev/null", "bash", "-lc", shell] : ["-qfc", shell, "/dev/null"];
  const child = spawn("script", args, { cwd: ROOT, env: childEnv });
  child.stdout.on("data", (d) => onData(d.toString("utf8")));
  child.on("exit", onExit);
  return { write: (d) => child.stdin.write(d), resize: () => {}, kill: () => child.kill() };
}

wss.on("connection", (ws, req) => {
  const q = new URL(req.url, "http://x").searchParams;
  const task = q.get("task") || "";
  const send = (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
  // Guided sign-ins only: there is no free-form terminal here (the editor has its own).
  const shell = TASKS[task];
  const guide = q.get("mode") === "guided" ? GUIDED[task] : null;
  if (!shell || !guide) {
    ws.close(1008, "unknown task");
    return;
  }

  let term;
  let creds = null;
  let clean = "";
  const attempts = {};          // prompt id ("f"+i form / "a"+i auto) -> sends so far
  const lastAnswerAt = {};      // prompt id -> last send time, to throttle re-sends
  const MAX_TRY = 4;            // cap re-sends so a bad prompt never spins forever
  const STUCK_MS = 30000;       // no progress this long -> tell the UI to offer retry
  let progressAt = Date.now();
  const bump = () => { progressAt = Date.now(); };
  // Clear form-answer state so a rejected code/credentials can be re-entered.
  const resetFormAnswers = () => {
    for (const k of Object.keys(attempts)) {
      if (k[0] === "f") { delete attempts[k]; delete lastAnswerAt[k]; }
    }
  };
  // Answer form-style prompts ("Paste code here") once creds have arrived and
  // the prompt is the last thing on screen. Re-sends the same answer if that
  // prompt is still showing a couple seconds later — under load the CLI can drop
  // a keystroke typed before it was reading, and answering once would deadlock.
  const answerPrompts = () => {
    if (!guide || !guide.answers || !creds) return;
    // Match against the recent tail, not just the last line: TUIs pad prompts
    // with cursor moves and follow them with terminal queries.
    const last = clean.slice(-300).trimEnd();
    for (const [i, a] of guide.answers.entries()) {
      const id = "f" + i;
      if (!a.re.test(last)) continue;                 // only the prompt on screen now
      if ((attempts[id] || 0) >= MAX_TRY) break;
      if (lastAnswerAt[id] && Date.now() - lastAnswerAt[id] < 2500) break;
      attempts[id] = (attempts[id] || 0) + 1;
      lastAnswerAt[id] = Date.now();
      bump();
      send({ t: "debug", d: "answered " + a.key + " (try " + attempts[id] + ")" });
      // Two separate writes, human-paced: an Enter within the TUI's
      // paste-detection window (~1s) is swallowed as part of the paste.
      const val = creds[a.key] || "";
      setTimeout(() => {
        term.write(val);
        setTimeout(() => term.write("\r"), 1500);
      }, 300);
      break;
    }
  };
  if (guide) {
    // Hidden PTY: parse output into events instead of piping raw bytes.
    const found = {};
    let nudge = null;
    // Same re-send guard as answerPrompts, for the auto entries (Enter on
    // "select login method", Y/n, etc.): only fire while the prompt is still the
    // last thing on screen, and cap the retries.
    const runAuto = () => {
      const tail = clean.slice(-400);
      for (const [i, a] of (guide.auto || []).entries()) {
        const id = "a" + i;
        if (!a.re.test(tail)) continue;
        if ((attempts[id] || 0) >= MAX_TRY) continue;
        if (lastAnswerAt[id] && Date.now() - lastAnswerAt[id] < 2500) continue;
        attempts[id] = (attempts[id] || 0) + 1;
        lastAnswerAt[id] = Date.now();
        bump();
        send({ t: "debug", d: "auto-answered #" + i + " (try " + attempts[id] + ")" });
        // Delay: prompt libs flush buffered input when entering raw mode, so an
        // instant answer gets discarded. Type like a (fast) human.
        setTimeout(() => term.write(a.send), 600);
      }
    };
    term = spawnTaskPTY(
      shell,
      (d) => {
        const raw = d.toString();
        send({ t: "log", d: raw.replace(/sk-ant-[\w-]+/g, "***") });
        // Answer terminal capability queries (OSC 10/11 color, DA) like a real
        // terminal would — CLIs (termenv/survey) stall waiting for these.
        if (/\x1b\]1[01];\?/.test(raw)) term.write("\x1b]11;rgb:0909/0d0d/1a1a\x1b\\");
        if (/\x1b\[c/.test(raw)) term.write("\x1b[?6c");
        const chunkClean = stripAnsi(raw);
        clean += chunkClean;
        // "Invalid code. Press Enter to retry." — press it, reset our state,
        // and tell the UI to start the code step over.
        if (guide.retryErr && guide.retryErr.test(chunkClean)) {
          creds = null;
          resetFormAnswers();
          setTimeout(() => term.write("\r"), 600);
          send({ t: "reset" });
        }
        answerPrompts();
        runAuto();
        for (const key of ["code", "url"]) {
          if (!guide[key]) continue;
          // Take the LAST match: a failed exchange makes the CLI retry with a
          // brand-new URL, and the stale one must not win.
          const flags = guide[key].flags.includes("g") ? guide[key].flags : guide[key].flags + "g";
          const all = [...clean.matchAll(new RegExp(guide[key].source, flags))];
          const m = all[all.length - 1];
          if (m && found[key] !== m[1]) {
            const isRetry = key === "url" && found[key] !== undefined;
            found[key] = m[1];
            bump();
            send({ t: key, v: m[1] });
            if (isRetry) {
              // Fresh OAuth attempt: forget the old code so a new one can be answered.
              creds = null;
              resetFormAnswers();
            }
          }
        }
        if (guide.done && !found.done) {
          const m = clean.match(guide.done);
          if (m) {
            found.done = true;
            bump();
            if (guide.secret) {
              guide.secret(m[1]);
              send({ t: "done", v: "" });
            } else {
              send({ t: "done", v: m[1] || "" });
            }
          }
        }
      },
      (e) => {
        clearInterval(nudge);
        // Surface a real failure instead of closing silently: a non-zero exit
        // without a `done` means the login tool died (bad creds, throttled, etc.).
        send({ t: "exit", ok: !!found.done, code: e && typeof e.exitCode === "number" ? e.exitCode : null });
        ws.close();
      },
      500, // hidden PTY: extra-wide so long OAuth URLs never line-wrap mid-parse
    );
    // Keep answering even while the CLI is silent (a dropped keystroke leaves no
    // new output to trigger the data handler), and after STUCK_MS with no
    // progress tell the UI to surface a retry instead of an endless spinner.
    nudge = setInterval(() => {
      if (found.done) return;
      answerPrompts();
      runAuto();
      if (Date.now() - progressAt > STUCK_MS) {
        bump(); // one nudge per window, don't spam
        send({ t: "stuck" });
      }
    }, 2500);
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === "creds") {
      creds = { ...msg.v };
      answerPrompts();
    }
  });
  ws.on("close", () => term.kill());
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`workspace agent on http://127.0.0.1:${PORT}  root=${ROOT}  pty=${pty ? "node-pty" : "script"}`);
});

// The page server: workspace files as pages for the Preview, nothing else (no API, no proxy). Loopback only;
// in a pod it is reached as `<PREVIEW_PORT>--<host>` through authproxy, which checks the session like for any app.
const pageServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "read only" });
    return await servePreviewFile(req, res, url.pathname.replace(/^\/+/, ""), { sandbox: false });
  } catch (e) {
    json(res, 404, { error: e instanceof Error ? e.message : "not found" });
  }
});
pageServer.on("error", (e) => console.error(`page server on :${PREVIEW_PORT} not started:`, e.message));
pageServer.listen(PREVIEW_PORT, "127.0.0.1");
