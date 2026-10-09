import { injectable, inject } from '@theia/core/shared/inversify';
import * as http from 'http';
import { OpenCodeEventsClient, OpenCodeEventsServer } from '../common/opencode-events';
import { OpenCodeServer, OPENCODE_HOST } from './opencode-server';

/** Wait this long before re-attaching to OpenCode's stream after it ended or failed. */
const RETRY_MS = 2_000;

/** One followed folder: its current `GET /event` request and a pending retry. */
interface Follow { req?: http.ClientRequest; retry?: ReturnType<typeof setTimeout> }

/**
 * Backend side of the OpenCode event relay (see ../common/opencode-events.ts): follows `GET /event` on the
 * local `opencode serve` — one stream per project folder the card has a tab for — parses the SSE frames and
 * forwards each event to the connected frontend over Theia's RPC channel. The streams on localhost are never cut
 * by anything on the way; if OpenCode itself goes away the relay tells the frontend (`error`) per folder and
 * keeps trying until it is back (`open`).
 */
@injectable()
export class OpenCodeEventsServerImpl implements OpenCodeEventsServer {
  @inject(OpenCodeServer) protected readonly opencode: OpenCodeServer;

  protected client?: OpenCodeEventsClient;
  protected follows = new Map<string, Follow>();
  protected disposed = false;

  setClient(client: OpenCodeEventsClient | undefined): void { this.client = client; }

  async subscribe(directory: string): Promise<void> {
    if (this.follows.has(directory)) { return; }   // already following it (a re-subscribe after reconnect is a no-op)
    this.follows.set(directory, {});
    void this.connect(directory);
  }

  async unsubscribe(directory?: string): Promise<void> {
    for (const dir of directory === undefined ? [...this.follows.keys()] : [directory]) {
      const f = this.follows.get(dir);
      if (!f) { continue; }
      this.follows.delete(dir);
      if (f.retry) { clearTimeout(f.retry); }
      f.req?.destroy();
    }
  }

  dispose(): void {
    this.disposed = true;
    void this.unsubscribe();
    this.client = undefined;
  }

  protected async connect(dir: string): Promise<void> {
    if (!this.follows.has(dir) || this.disposed) { return; }
    if (!(await this.opencode.ensureReady())) { this.lost(dir, undefined); return; }
    const f = this.follows.get(dir);
    if (!f || this.disposed) { return; }   // unsubscribed while OpenCode started
    const req = http.get({
      host: OPENCODE_HOST, port: this.opencode.port(), path: `/event?directory=${encodeURIComponent(dir)}`,
      headers: { accept: 'text/event-stream' },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); this.lost(dir, req); return; }
      this.client?.onState(dir, 'open');
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) !== -1) { this.frame(dir, buf.slice(0, i)); buf = buf.slice(i + 2); }
      });
      res.on('end', () => this.lost(dir, req));
      res.on('error', () => this.lost(dir, req));
    });
    req.on('error', () => this.lost(dir, req));
    f.req = req;
  }

  /** One SSE frame → one RPC notification. Comments (`: …`) and frames without data are skipped. */
  protected frame(dir: string, frame: string): void {
    const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data) { return; }
    try { this.client?.onEvent(dir, JSON.parse(data)); } catch { /* not JSON — OpenCode only sends JSON */ }
  }

  /** A folder's stream ended or failed: tell the frontend and retry, unless it was us who stopped it. */
  protected lost(dir: string, req: http.ClientRequest | undefined): void {
    const f = this.follows.get(dir);
    if (this.disposed || !f) { return; }
    if (req && f.req !== req) { return; }   // a stream we already replaced or stopped
    f.req = undefined;
    this.client?.onState(dir, 'error');
    if (!f.retry) { f.retry = setTimeout(() => { f.retry = undefined; void this.connect(dir); }, RETRY_MS); }
  }
}
