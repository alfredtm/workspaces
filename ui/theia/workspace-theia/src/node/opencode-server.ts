import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';

/**
 * The OpenCode assistant card (browser/opencode/) talks to a headless `opencode serve` that this contribution
 * owns: started on the first request, reused when one is already listening on the port (a backend restart must
 * not orphan one server and spawn another), and every request under PREFIX is forwarded to it —
 * including the server-sent event stream the chat follows (GET /event). Same origin, so the browser needs no
 * CORS, no extra hostname on the gateway and no authproxy banner; the session cookie already guards the editor.
 *
 * The server binds 127.0.0.1 without a password, exactly like the server the `opencode` TUI starts for itself:
 * the pod is single-user, ingress is default-deny (only authproxy's :8080 is reachable) and OpenCode reads the
 * provider config (OPENCODE_CONFIG, exported by the entrypoint from the LLM_* env) from this process's
 * environment, so the inference providers are there without anything per request.
 *
 *   GET PREFIX/_status  → { ready, starting, error, log }  (the card's boot screen polls this; the first
 *                          poll is what starts the server)
 *   *   PREFIX/<path>   → http://127.0.0.1:4097/<path>     (503 + JSON while OpenCode is not up)
 */
const PREFIX = '/opencode-api';
export const OPENCODE_HOST = '127.0.0.1';
export const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 4097);
const HOST = OPENCODE_HOST;
const PORT = OPENCODE_PORT;
/** Pi (beta): with the assistant preference set to "pi" the card's traffic goes to Pi's server (services/pi), which
 *  speaks OpenCode's API on this port; started here like `opencode serve`. */
export const PI_PORT = Number(process.env.PI_PORT || 4099);
type ServerKind = 'opencode' | 'pi';
let piCache = { at: 0, pi: false };
export function piChosen(): boolean {
  if (Date.now() - piCache.at < 2000) { return piCache.pi; }
  let pi = false;
  // the key is ASSISTANT_PREF in browser/assistant.ts
  try { pi = /"workspace\.assistant"\s*:\s*"pi"/.test(fs.readFileSync(`${os.homedir()}/.theia/settings.json`, 'utf8')); } catch { /* no settings yet */ }
  piCache = { at: Date.now(), pi };
  return pi;
}
const START_TIMEOUT_MS = 120_000;
/** After a failed start, wait this long before the next status poll may try again (no spawn storm). */
const RETRY_AFTER_MS = 10_000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * OpenCode answers GET /config and /config/providers (and /provider) with the resolved config, which includes each
 * provider's API key in plain text — `{env:LLM_API_KEY}` comes back filled in. The card only needs model ids
 * and names, so the backend strips anything credential-shaped before the browser (and every screenshot, HAR file or
 * log of it) sees the inference provider's key.
 */
const CONFIG_PATHS = /^\/(config|provider)(\/[^?]*)?(\?|$)/;
const SECRET_KEY = /(api[-_]?key|secret|token|password|authorization|credential)/i;
export function redactSecrets(v: unknown): unknown {
  if (Array.isArray(v)) { return v.map(redactSecrets); }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      // headers carry auth under any name (Authorization, X-Api-Key, …): drop them wholesale
      if (SECRET_KEY.test(k) || k.toLowerCase() === 'headers') { continue; }
      out[k] = redactSecrets(x);
    }
    return out;
  }
  return v;
}
/** Identity of this backend process. A frontend that reconnects and sees a different one is talking to a new pod (or a
 *  restarted backend) and must reload: its plugin webviews (Claude) still show the old session with nothing behind it. */
export const BACKEND_BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

@injectable()
export class OpenCodeServer implements BackendApplicationContribution {
  /** The servers this backend started (a server we merely reused belongs to whoever started it). */
  protected children = new Map<ServerKind, ChildProcess>();
  protected ready = false;
  protected starting?: Promise<boolean>;
  protected error = '';
  protected failedAt = 0;
  protected log: string[] = [];

  configure(app: any): void {
    app.get(`${PREFIX}/_status`, (_req: any, res: any) => {
      if (!this.ready && !this.starting && Date.now() - this.failedAt > RETRY_AFTER_MS) { void this.ensure(); }
      res.json({ ready: this.ready, starting: !!this.starting, error: this.error, log: this.log.slice(-15), port: this.port(), bootId: BACKEND_BOOT_ID });
    });
    app.use(PREFIX, async (req: any, res: any) => {
      if (!this.ready && !(await this.ensure())) {
        res.status(503).json({ error: `${piChosen() ? 'Pi' : 'OpenCode'} is not running`, detail: this.error });
        return;
      }
      this.proxy(req, res);
    });
  }

  onStop(): void {
    for (const child of this.children.values()) { try { child.kill(); } catch { /* already gone */ } }
  }

  /** For other backend services that talk to OpenCode directly (the event relay): up, or started now. */
  ensureReady(): Promise<boolean> { return this.ensure(); }

  /** Where the card's server is right now: OpenCode, or the Pi stand-in while Pi is the pick. */
  protected lastPort = PORT;
  port(): number {
    const p = piChosen() ? PI_PORT : PORT;
    if (p !== this.lastPort) { this.lastPort = p; this.ready = false; this.error = ''; this.failedAt = 0; }
    return p;
  }

  protected proxy(req: any, res: any): void {
    const path = (req.originalUrl || req.url).slice(PREFIX.length) || '/';
    const port = this.port();
    const headers: Record<string, any> = { ...req.headers, host: `${HOST}:${port}` };
    delete headers['accept-encoding'];   // plain bodies: an SSE stream must not come back gzipped and buffered
    const up = http.request({ host: HOST, port, path, method: req.method, headers }, upRes => {
      if (req.method === 'GET' && CONFIG_PATHS.test(path)) { this.redacted(upRes, res); return; }
      const h: Record<string, any> = { ...upRes.headers };
      if (path.startsWith('/event')) { h['x-accel-buffering'] = 'no'; h['cache-control'] = 'no-cache'; }
      res.writeHead(upRes.statusCode || 502, h);
      if (typeof res.flushHeaders === 'function') { res.flushHeaders(); }
      // No keepalive of our own: OpenCode 1.18.30 sends `server.heartbeat` on /event every 10 s (measured in
      // the lab), so the stream is never idle long enough for a proxy on the way to cut it for inactivity.
      upRes.pipe(res);
    });
    up.on('error', () => {
      this.ready = false;
      if (!res.headersSent) { res.statusCode = 503; res.end(JSON.stringify({ error: 'OpenCode went away' })); } else { res.end(); }
    });
    // The client went away (tab closed, widget re-subscribed): drop the upstream stream too, or every
    // reload leaves one more /event subscription open on the OpenCode side.
    res.on('close', () => up.destroy());
    if (req.complete) {
      // Theia's express app parses JSON bodies before we see the request (express.json()), so the stream is
      // already drained — piping it would never end the upstream request. Re-serialise what the parser kept.
      const b = req.body;
      const body = b === undefined || (typeof b === 'object' && !Buffer.isBuffer(b) && Object.keys(b).length === 0 && req.headers['content-length'] === '0')
        ? undefined : typeof b === 'string' || Buffer.isBuffer(b) ? b : JSON.stringify(b ?? {});
      if (body !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
        up.setHeader('content-length', String(Buffer.byteLength(body)));
        up.removeHeader('transfer-encoding');
        up.end(body);
      } else { up.end(); }
    } else {
      req.pipe(up);
    }
  }

  /** A config answer without its credentials (see redactSecrets); anything that is not JSON is withheld entirely. */
  protected redacted(upRes: http.IncomingMessage, res: any): void {
    const chunks: Buffer[] = [];
    upRes.on('data', (c: Buffer) => chunks.push(c));
    upRes.on('end', () => {
      let body: string;
      try { body = JSON.stringify(redactSecrets(JSON.parse(Buffer.concat(chunks).toString('utf8')))); } catch { res.status(502).json({ error: 'OpenCode answered with something that is not JSON' }); return; }
      res.writeHead(upRes.statusCode || 200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store' });
      res.end(body);
    });
    upRes.on('error', () => { if (!res.headersSent) { res.status(502).end(); } else { res.end(); } });
  }

  protected ensure(): Promise<boolean> {
    this.port();   // a switch to/from Pi resets `ready`
    if (this.ready) { return Promise.resolve(true); }
    if (this.starting) { return this.starting; }
    const kind: ServerKind = piChosen() ? 'pi' : 'opencode';
    const name = kind === 'pi' ? 'Pi' : 'OpenCode';
    this.starting = (async () => {
      try {
        if (await this.health()) { this.ready = true; this.error = ''; this.note(`reusing the ${name} server already on :${this.port()}`); return true; }
        if (!this.spawnServer(kind)) { return false; }
        const t0 = Date.now();
        while (Date.now() - t0 < START_TIMEOUT_MS) {
          await sleep(500);
          if (!this.children.get(kind)) { this.error = this.error || `${name} exited: ${this.log.slice(-3).join(' · ')}`; this.failedAt = Date.now(); return false; }
          if (await this.health()) { this.ready = true; this.error = ''; this.note(`${name} is up`); return true; }
        }
        this.error = `${name} did not come up within two minutes`; this.failedAt = Date.now();
        try { this.children.get(kind)?.kill(); } catch { /* ignore */ }
        return false;
      } finally { this.starting = undefined; }
    })();
    return this.starting;
  }

  /** `opencode serve`, or Pi's server (services/pi, baked at /opt/pi; the lab points PI_SERVER and PI_NODE at the
   *  repo copy and a Node ≥22 — Theia's own Node 20 is too old for Pi). Pi keeps its state in PI_DATA (passed
   *  through in the environment). */
  protected spawnServer(kind: ServerKind): boolean {
    const cwd = this.workspaceDir();
    const [cmd, args] = kind === 'pi'
      ? [process.env.PI_NODE || 'node', [process.env.PI_SERVER || '/opt/pi/server.mjs', cwd]]
      : ['opencode', ['serve', '--port', String(PORT), '--hostname', HOST]];
    // NODE_NO_WARNINGS: Node 22/24 flag node:sqlite (Pi's storage) as experimental on every start
    const env = kind === 'pi' ? { ...process.env, PI_PORT: String(PI_PORT), NODE_NO_WARNINGS: '1' } : process.env;
    this.note(`starting ${kind} on ${HOST}:${kind === 'pi' ? PI_PORT : PORT} in ${cwd}`);
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      this.error = `could not start ${kind}: ${e?.message || e}`; this.failedAt = Date.now(); return false;
    }
    this.children.set(kind, child);
    const onLine = (chunk: Buffer) => { for (const line of String(chunk).split('\n')) { if (line.trim()) { this.note(line.trim()); } } };
    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);
    child.on('error', e => { this.error = `could not start ${kind}: ${e.message}`; this.failedAt = Date.now(); if (this.children.get(kind) === child) { this.children.delete(kind); } });
    child.on('exit', (code, signal) => {
      this.note(`${kind} exited (code ${code}, signal ${signal})`);
      if (this.children.get(kind) === child) { this.children.delete(kind); this.ready = false; }
    });
    return true;
  }

  /** The folder OpenCode works in — the user's workspace. The pod passes it to Theia as the last argument (the lab
   *  sets WS_ROOT as well); a request's `directory` query decides the project per call anyway, this is the cwd. */
  protected workspaceDir(): string {
    const candidates = [process.env.WS_ROOT, ...process.argv.slice(2).filter(a => !a.startsWith('-')).reverse(), os.homedir()];
    for (const c of candidates) {
      if (!c) { continue; }
      try { if (fs.statSync(c).isDirectory()) { return c; } } catch { /* not a dir */ }
    }
    return os.homedir();
  }

  protected health(): Promise<boolean> {
    return new Promise(resolve => {
      const r = http.get({ host: HOST, port: this.port(), path: '/global/health', timeout: 1500 }, res => { res.resume(); resolve(res.statusCode === 200); });
      r.on('timeout', () => { r.destroy(); resolve(false); });
      r.on('error', () => resolve(false));
    });
  }

  protected note(line: string): void {
    this.log.push(line);
    if (this.log.length > 60) { this.log.splice(0, this.log.length - 60); }
    console.info('opencode-server:', line);
  }
}
