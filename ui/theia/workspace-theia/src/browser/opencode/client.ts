import { Attachment, OCCommand, OCMessageWithParts, OCPermissionRequest, OCProvidersResponse, OCQuestionRequest, OCSession } from './types';

/**
 * OpenCode's HTTP API through the editor backend's same-origin proxy (src/node/opencode-server.ts).
 * Every call carries `directory=<workspace folder>`: OpenCode's server is multi-project and picks the project
 * (config, sessions, file access) per request from that query parameter — the same thing the official SDK does.
 */
/** The proxy's path (PREFIX in src/node/opencode-server.ts). */
export const OPENCODE_BASE = '/opencode-api';
const BASE = OPENCODE_BASE;

export interface ServerStatus { ready: boolean; starting: boolean; error: string; log: string[] }

export class OpenCodeError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type StreamState = 'open' | 'error';

export class OpenCodeClient {
  constructor(readonly directory: string) {}

  protected url(path: string, query?: Record<string, string | number | undefined>): string {
    const p = new URLSearchParams();
    p.set('directory', this.directory);
    for (const [k, v] of Object.entries(query || {})) { if (v !== undefined) { p.set(k, String(v)); } }
    return `${BASE}${path}?${p.toString()}`;
  }

  protected async call<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    const r = await fetch(this.url(path, query), {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = j?.data?.message || j?.detail || j?.error || j?.message || ''; } catch { /* no JSON body */ }
      throw new OpenCodeError(r.status, detail || `${method} ${path} failed (${r.status})`);
    }
    if (r.status === 204) { return undefined as T; }
    const text = await r.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Backend-side status of the `opencode serve` process (not proxied). */
  async status(): Promise<ServerStatus> {
    const r = await fetch(`${BASE}/_status`);
    return r.json();
  }

  sessions(): Promise<OCSession[]> { return this.call('GET', '/session'); }
  createSession(title?: string): Promise<OCSession> { return this.call('POST', '/session', title ? { title } : {}); }
  deleteSession(id: string): Promise<void> { return this.call('DELETE', `/session/${encodeURIComponent(id)}`); }
  messages(id: string): Promise<OCMessageWithParts[]> { return this.call('GET', `/session/${encodeURIComponent(id)}/message`); }

  /** Fire-and-forget: the reply arrives on the event stream. */
  /** `agent`: OpenCode's `build` (the default) or `plan` (read-only, answers with a plan). Images go as `file` parts. */
  /** `variant`: the Thinking level (a model variant; none = the endpoint's default). */
  /** `steer` (Pi only, OpenCode ignores the field): join the running work after its current step instead of after it. */
  prompt(id: string, text: string, model?: { providerID: string; modelID: string }, agent?: 'build' | 'plan', images: Attachment[] = [], variant?: string, steer?: boolean): Promise<void> {
    const parts = [{ type: 'text', text }, ...images.map(a => ({ type: 'file', mime: a.mime, url: a.url, filename: a.name }))];
    return this.call('POST', `/session/${encodeURIComponent(id)}/prompt_async`, { ...(model ? { model } : {}), ...(agent ? { agent } : {}), ...(variant ? { variant } : {}), ...(steer ? { steer: true } : {}), parts });
  }
  abort(id: string): Promise<void> { return this.call('POST', `/session/${encodeURIComponent(id)}/abort`); }
  /** Permission asks the tools are waiting on (all sessions of the project). */
  permissions(): Promise<OCPermissionRequest[]> { return this.call('GET', '/permission'); }
  /** `message` rides along with a rejection: what the user wants done instead (OpenCode hands it to the model). */
  async permission(id: string, permissionID: string, response: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    try {
      await this.call('POST', `/permission/${encodeURIComponent(permissionID)}/reply`, { reply: response, ...(message ? { message } : {}) });
    } catch (e) {
      if (!(e instanceof OpenCodeError && e.status === 404)) { throw e; }
      // older server: the per-session route
      await this.call('POST', `/session/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionID)}`, { response });
    }
  }

  /** Questions the `question` tool is waiting on (all sessions of the project). */
  questions(): Promise<OCQuestionRequest[]> { return this.call('GET', '/question'); }
  /** `answers` is one array of picked labels per question, in order. */
  answerQuestion(requestID: string, answers: string[][]): Promise<void> {
    return this.call('POST', `/question/${encodeURIComponent(requestID)}/reply`, { answers });
  }
  rejectQuestion(requestID: string): Promise<void> { return this.call('POST', `/question/${encodeURIComponent(requestID)}/reject`); }

  // ── slash commands and friends ──
  commands(): Promise<OCCommand[]> { return this.call('GET', '/command'); }
  /** Run a server-side command (`/init`, `/review`, a skill, a custom command) as the next turn. */
  command(id: string, name: string, args: string, model?: string): Promise<void> {
    return this.call('POST', `/session/${encodeURIComponent(id)}/command`, { command: name, arguments: args, ...(model ? { model } : {}) });
  }
  /** `!ls -la`: run a shell command in the session, output lands in the conversation. */
  shell(id: string, command: string, model?: { providerID: string; modelID: string }): Promise<void> {
    return this.call('POST', `/session/${encodeURIComponent(id)}/shell`, { agent: 'build', command, ...(model ? { model } : {}) });
  }
  /** `/compact`: summarise the conversation so far into a shorter context. */
  summarize(id: string, providerID: string, modelID: string): Promise<void> {
    return this.call('POST', `/session/${encodeURIComponent(id)}/summarize`, { providerID, modelID });
  }
  /** `/undo`: rewind to before a message (its file changes too); `/redo` puts it back. */
  revert(id: string, messageID: string): Promise<void> { return this.call('POST', `/session/${encodeURIComponent(id)}/revert`, { messageID }); }
  unrevert(id: string): Promise<void> { return this.call('POST', `/session/${encodeURIComponent(id)}/unrevert`, {}); }

  /** Sessions currently busy (idle ones are absent). */
  sessionStatus(): Promise<Record<string, { type: string }>> { return this.call('GET', '/session/status'); }

  /** MCP servers of this project and their state (connected, failed, needs_auth, disabled, …). */
  mcpStatus(): Promise<Record<string, { status: string }>> { return this.call('GET', '/mcp'); }
  /** Retry one MCP server in this project; it picks up a sign-in made from another folder (the token is shared on disk). */
  mcpConnect(name: string): Promise<unknown> { return this.call('POST', `/mcp/${encodeURIComponent(name)}/connect`); }

  providers(): Promise<OCProvidersResponse> { return this.call('GET', '/config/providers'); }
  config(): Promise<{ model?: string }> { return this.call('GET', '/config'); }

  // The event bus is not fetched from here: it arrives over Theia's WebSocket (./events.ts), because an
  // EventSource through the gateway was cut every 15 s.
}
