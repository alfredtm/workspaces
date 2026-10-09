import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import * as http from 'http';
import * as net from 'net';

/**
 * Same-origin bridge to the workspace agent (services/shell/agent.js). The agent owns the
 * workspace-specific logic — listening ports, guided sign-ins (hidden PTYs),
 * secrets/env, uploads. Everything under /workspace-api/ is forwarded to it,
 * including websocket upgrades (the guided flows + terminals ride /term).
 */
/** A neutral favicon: a plain rounded square (the layout's "your turn" badge draws the same square, plus a dot). */
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect x="10" y="10" width="76" height="76" rx="20" fill="#7c83f7"/></svg>';

@injectable()
export class AgentProxy implements BackendApplicationContribution {
  private readonly prefix = '/workspace-api';
  private readonly agentHost = '127.0.0.1';
  private readonly agentPort = Number(process.env.AGENT_PORT || 13338);

  configure(app: any): void {
    // Theia's index.html has no icon: serve one for /favicon.svg and the /favicon.ico browsers ask for anyway.
    const favicon = (_req: any, res: any) => { res.setHeader('Content-Type', 'image/svg+xml'); res.setHeader('Cache-Control', 'public, max-age=86400'); res.end(FAVICON_SVG); };
    app.get('/favicon.svg', favicon);
    app.get('/favicon.ico', favicon);
    app.use(this.prefix, (req: any, res: any) => {
      const path = (req.originalUrl || req.url).slice(this.prefix.length) || '/';
      const upstream = http.request(
        { host: this.agentHost, port: this.agentPort, path, method: req.method,
          headers: { ...req.headers, host: `${this.agentHost}:${this.agentPort}` } },
        up => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); }
      );
      upstream.on('error', () => { res.statusCode = 502; res.end(JSON.stringify({ error: 'workspace agent not reachable' })); });
      if (req.complete) {
        // Theia's express app has already parsed JSON bodies (express.json()) by the time we see the request, so
        // the stream is drained: piping it forwards nothing while Content-Length still promises a body — the agent
        // waits forever, or reads `{}` and, for PUT /api/env, wipes every saved variable. Re-serialise what the
        // parser kept (same fix as opencode-server.ts).
        const b = req.body;
        const body = b === undefined || (typeof b === 'object' && !Buffer.isBuffer(b) && Object.keys(b).length === 0 && req.headers['content-length'] === '0')
          ? undefined : typeof b === 'string' || Buffer.isBuffer(b) ? b : JSON.stringify(b ?? {});
        if (body !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
          upstream.setHeader('content-length', String(Buffer.byteLength(body)));
          upstream.removeHeader('transfer-encoding');
          upstream.end(body);
        } else { upstream.end(); }
      } else {
        req.pipe(upstream);
      }
    });
  }

  onStart(server: http.Server): void {
    server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      if (!req.url || !req.url.startsWith(this.prefix + '/')) { return; }
      const path = req.url.slice(this.prefix.length);
      const up = net.connect(this.agentPort, this.agentHost, () => {
        up.write(`${req.method} ${path} HTTP/1.1\r\n`);
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const k = req.rawHeaders[i]; const v = req.rawHeaders[i + 1];
          up.write(`${k}: ${k.toLowerCase() === 'host' ? `${this.agentHost}:${this.agentPort}` : v}\r\n`);
        }
        up.write('\r\n');
        if (head && head.length) { up.write(head); }
        up.pipe(socket); socket.pipe(up);
      });
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    });
  }
}
