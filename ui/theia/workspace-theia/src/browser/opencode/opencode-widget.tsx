import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';
import React = require('@theia/core/shared/react');
import { OpenCodeClient, OpenCodeError, StreamState } from './client';
import { OpenCodeEvents } from './events';
import { OpenCodeChat } from './chat';
import { BusyHint, CardBoundary, Composer, TurnView } from './components';
import { ILogger } from '@theia/core/lib/common/logger';
import { Attachment, ModelOption, OCCommand, OCEvent, OCSession, QuestionBlock } from './types';
import { agentName, OPENCODE_WIDGET_ID } from '../assistant';

export { OPENCODE_WIDGET_ID };

const LS_SESSION = 'ws-oc-session:';
/** Open project tabs and the active one, per workspace root: { folders: string[], active: string }. */
const LS_TABS = 'ws-oc-tabs:';
/** At most this many tabs, Workspace included: a tidy header, and a bound on parallel sessions against the model. */
const MAX_TABS = 4;

/** Slash commands the card handles itself; the server's own (/init, /review, skills, custom commands) are added
 *  from GET /command. `!cmd` runs a shell command directly. */
interface SlashCommand { name: string; description: string; args?: string; server?: boolean }
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'new', description: 'Start a new chat' },
  { name: 'sessions', description: 'Previous chats' },
  { name: 'model', description: 'Pick the model', args: '[name]' },
  { name: 'compact', description: 'Summarise the conversation so far to free up room' },
  { name: 'undo', description: 'Take back the last message and the changes it made' },
  { name: 'redo', description: 'Bring back what /undo took away' },
  { name: 'help', description: 'What can I type here?' },
];
const LS_MODEL = 'ws-oc-model';
/** Build | Plan (OpenCode's `build` / `plan` agent; Pi maps it to a read-only mode), remembered across reloads. */
const LS_MODE = 'ws-oc-mode';
/** The Thinking choice ('' = the model's default), remembered across reloads. */
const LS_EFFORT = 'ws-oc-effort';
const EFFORTS: { id: string; label: string; hint: string }[] = [
  { id: '', label: 'Default', hint: 'What the platform picked for this model' },
  { id: 'low', label: 'Low', hint: 'Fast — fine for most things' },
  { id: 'medium', label: 'Medium', hint: 'Thinks a bit more' },
  { id: 'high', label: 'High', hint: 'For tricky problems; slower' },
  { id: 'max', label: 'Max', hint: 'Thinks as long as it needs; can take minutes' },
];
/** Images per message and per image: what a model request comfortably carries as data URLs. */
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** How long one boot request (models, sessions, history) may take before the boot screen says so and retries. */
const BOOT_STEP_TIMEOUT_MS = 30_000;

/**
 * One project tab: a top-level folder of the workspace ('' = the whole workspace, the "Default" tab). OpenCode
 * keeps sessions per folder, so each tab has its own client (its `directory`), sessions, current chat, draft and
 * event stream — background tabs keep following theirs, which is what their status dot shows.
 */
interface Tab {
  folder: string;
  client: OpenCodeClient;
  chat?: OpenCodeChat;
  unsubscribe?: () => void;
  stream: StreamState | 'closed';
  sessions: OCSession[];
  sessionId?: string;          // undefined = a draft: the session is created with the first message
  input: string;
  /** follow-ups typed while it works, sent one by one when it is idle again (oldest first) */
  queue: Queued[];
  sending: boolean;
  localErrors: { id: string; message: string }[];
  /** transient rows the card adds itself (/help, "unknown command"), never sent anywhere; `at` places them among
   *  the turns, and sending a message clears them */
  notes: { id: string; html: string; at: number }[];
  /** a /compact in flight: its placeholder row stays until a compaction block arrives (Pi writes it only when done) */
  compacting?: { since: number; before: number };
  stick: boolean;
  wasBusy: boolean;
  /** finished while it was not the tab in front: a quiet dot until it is looked at */
  unseen: boolean;
  loaded: boolean;
  /** images for the next message (shown above the input) */
  attachments: Attachment[];
  /** last MCP reconnect attempt (ms), see reconnectMcp */
  mcpTried?: number;
}
interface Queued { id: string; text: string; images: Attachment[] }
type TabState = 'idle' | 'busy' | 'needs' | 'done';

/**
 * The OpenCode assistant card: our own chat UI over `opencode serve` (through the backend proxy, see
 * src/node/opencode-server.ts), the way the Claude Code extension is a chat UI over the claude CLI.
 * Native Theia widget — it paints with the editor's CSS variables, so every theme (Paper, Dark, Navy) is right
 * without a webview, an iframe or a terminal in between.
 *
 * Tabs are projects (see Tab): Workspace plus the top-level folders the user opened with "+". Switching tabs
 * switches the chat and tells the Preview which project to show (`ws:project`). Sessions are OpenCode's own (per
 * folder): a tab resumes the one it showed last (or the newest), "New chat" is a draft until the first message
 * creates the session, the clock icon lists the others. The model chip picks among the models of the inference
 * providers the pod's LLM_* config provides; the choice is remembered per browser and shared by all tabs.
 */
@injectable()
export class OpenCodeWidget extends ReactWidget {
  @inject(WorkspaceService) protected readonly workspace: WorkspaceService;
  @inject(OpenCodeEvents) protected readonly events: OpenCodeEvents;
  @inject(FileService) protected readonly files: FileService;
  /** Theia's logger reaches the pod log (the browser console does not): where a card crash shows up for us. */
  @inject(ILogger) protected readonly logger: ILogger;
  /** Bumped by "Try again": a fresh boundary renders the card anew. */
  protected crashKey = 0;

  protected root = '/';
  protected rootUri?: URI;
  protected tabs: Tab[] = [];
  protected activeFolder = '';

  protected phase: 'boot' | 'ready' = 'boot';
  protected bootMessage = 'Starting OpenCode…';
  protected bootError = '';
  protected bootLog: string[] = [];

  protected models: ModelOption[] = [];
  protected modelId?: string;
  protected mode: 'build' | 'plan' = localStorage.getItem(LS_MODE) === 'plan' ? 'plan' : 'build';
  protected effort: string = localStorage.getItem(LS_EFFORT) || '';
  protected menu: 'none' | 'history' | 'models' | 'tabs' | 'effort' = 'none';
  protected serverCommands: OCCommand[] = [];
  protected paletteIndex = 0;
  protected inputRef = React.createRef<HTMLTextAreaElement>();
  /** "+" menu: top-level folders that have no tab yet, and the new-folder field */
  protected folderChoices: string[] = [];
  protected newFolder = '';

  protected scrollRef = React.createRef<HTMLDivElement>();
  protected raf?: number;
  protected lastInput = Date.now();

  /** The tab in front. Everything the render and the user's actions touch goes through it. */
  protected get tab(): Tab { return this.tabs.find(t => t.folder === this.activeFolder) || this.tabs[0]; }
  protected get client(): OpenCodeClient | undefined { return this.tab?.client; }
  protected get chat(): OpenCodeChat | undefined { return this.tab?.chat; }
  protected get sessionId(): string | undefined { return this.tab?.sessionId; }
  protected get input(): string { return this.tab?.input || ''; }
  protected set input(v: string) { if (this.tab) { this.tab.input = v; } }

  @postConstruct()
  protected init(): void {
    this.id = OPENCODE_WIDGET_ID;
    this.title.label = agentName();
    this.title.caption = `${agentName()} on your inference provider’s models`;
    this.bootMessage = `Starting ${agentName()}…`;
    this.title.closable = false;
    this.addClass('ws-oc');
    this.node.tabIndex = -1;
    const close = (e: MouseEvent) => { if (this.menu !== 'none' && !(e.target as HTMLElement).closest?.('.oc-menu, .oc-tb-btn, .oc-model-pill, .oc-tab-add')) { this.menu = 'none'; this.update(); } };
    document.addEventListener('mousedown', close, true);
    const touch = () => { this.lastInput = Date.now(); this.clearAttention(); };
    window.addEventListener('pointerdown', touch, true); window.addEventListener('keydown', touch, true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { this.clearAttention(); } });
    this.toDispose.push({ dispose: () => { document.removeEventListener('mousedown', close, true); window.removeEventListener('pointerdown', touch, true); window.removeEventListener('keydown', touch, true); for (const t of this.tabs) { t.unsubscribe?.(); } } });
    this.update();
    void this.boot();
  }

  // ── tabs ──────────────────────────────────────────────────────────────────

  protected dirOf(folder: string): string { return folder ? `${this.root.replace(/\/$/, '')}/${folder}` : this.root; }
  protected labelOf(folder: string): string { return folder || 'Default'; }

  protected makeTab(folder: string): Tab {
    return { folder, client: new OpenCodeClient(this.dirOf(folder)), stream: 'closed', sessions: [], input: '', queue: [], sending: false,
      localErrors: [], notes: [], stick: true, wasBusy: false, unseen: false, loaded: false, attachments: [] };
  }

  protected saveTabs(): void {
    try { localStorage.setItem(LS_TABS + this.root, JSON.stringify({ folders: this.tabs.map(t => t.folder).filter(Boolean), active: this.activeFolder })); } catch { /* storage full */ }
  }

  /** Tell the Preview (and anyone else) which project is in front. */
  protected announceProject(): void {
    (window as any).__wsProject = this.activeFolder;
    window.dispatchEvent(new CustomEvent('ws:project', { detail: { folder: this.activeFolder } }));
  }

  /** Bring a tab to the front; load it the first time. */
  protected async activateTab(folder: string): Promise<void> {
    const t = this.tabs.find(x => x.folder === folder);
    if (!t) { return; }
    this.activeFolder = folder; this.menu = 'none'; this.paletteIndex = 0;
    t.unseen = false;
    this.saveTabs(); this.announceProject();
    this.update();
    if (!t.loaded) { await this.loadTab(t); }
    requestAnimationFrame(() => this.inputRef.current?.focus());
  }

  /** Sessions of a tab's folder, then the remembered (or newest) one; subscribes the folder's event stream. */
  protected async loadTab(t: Tab): Promise<void> {
    try {
      await this.loadSessions(t);
      const remembered = localStorage.getItem(LS_SESSION + t.client.directory) || undefined;
      const initial = t.sessions.find(s => s.id === remembered) || t.sessions[0];
      await this.openSession(t, initial?.id);
      t.loaded = true;
      this.update();
    } catch (e) { this.fail(t, e, 'Could not load the chats'); }
  }

  protected async openTab(folder: string): Promise<void> {
    if (!this.tabs.some(t => t.folder === folder)) {
      if (this.tabs.length >= MAX_TABS) { return; }   // the "+" menu says so instead of offering folders
      this.tabs.push(this.makeTab(folder));
    }
    await this.activateTab(folder);
  }

  protected closeTab(folder: string, e: React.MouseEvent): void {
    e.stopPropagation();
    if (!folder) { return; }   // Workspace always stays
    const t = this.tabs.find(x => x.folder === folder);
    if (!t) { return; }
    t.unsubscribe?.();
    this.tabs = this.tabs.filter(x => x !== t);
    if (this.activeFolder === folder) { void this.activateTab(''); } else { this.saveTabs(); this.update(); }
  }

  /** The "+" menu: top-level folders without a tab (the agent lists the workspace; dotfolders are hidden there). */
  protected async openTabsMenu(): Promise<void> {
    this.menu = this.menu === 'tabs' ? 'none' : 'tabs'; this.newFolder = '';
    this.update();
    if (this.menu !== 'tabs') { return; }
    try {
      const entries: { name: string; dir: boolean }[] = await (await fetch('/workspace-api/api/files?path=')).json();
      this.folderChoices = (Array.isArray(entries) ? entries : []).filter(e => e.dir && e.name !== 'node_modules' && !this.tabs.some(t => t.folder === e.name)).map(e => e.name);
    } catch { this.folderChoices = []; }
    this.update();
  }

  protected async createFolder(): Promise<void> {
    const name = this.newFolder.trim();
    if (!name || !/^[\w][\w .-]*$/.test(name) || name.includes('..')) { return; }
    try { await this.files.createFolder((this.rootUri || new URI('file://' + this.root)).resolve(name)); } catch (e) { this.fail(this.tab, e, 'Could not create the folder'); return; }
    this.newFolder = '';
    await this.openTab(name);
  }

  protected stateOf(t: Tab): TabState {
    const chat = t.chat;
    if (!chat) { return t.unseen ? 'done' : 'idle'; }
    const waiting = chat.turns.some(turn => turn.blocks.some(b => (b.type === 'permission' || b.type === 'question') && b.status === 'pending'));
    if (waiting) { return 'needs'; }
    if (chat.status !== 'idle') { return 'busy'; }
    return t.unseen ? 'done' : 'idle';
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  protected async boot(): Promise<void> {
    const roots = await this.workspace.roots;
    this.root = roots[0]?.resource.path.toString() || '/';
    this.rootUri = roots[0]?.resource;
    const status = new OpenCodeClient(this.root);
    this.phase = 'boot';
    for (;;) {
      if (this.isDisposed) { return; }
      const s = await status.status().catch(() => undefined);
      if (s?.ready) { break; }
      this.bootError = s?.error || (s ? '' : 'The editor backend is not answering');
      this.bootMessage = s?.error ? `${agentName()} could not start` : `Starting ${agentName()}…`;
      this.bootLog = s?.log || [];
      this.update();
      await sleep(s?.error ? 3000 : 800);
    }
    try {
      if (!this.tabs.length) {
        let saved: { folders?: string[]; active?: string } = {};
        try { saved = JSON.parse(localStorage.getItem(LS_TABS + this.root) || '{}'); } catch { /* none */ }
        this.tabs = [this.makeTab(''), ...(saved.folders || []).filter(f => typeof f === 'string' && f).slice(0, MAX_TABS - 1).map(f => this.makeTab(f))];
        this.activeFolder = this.tabs.some(t => t.folder === saved.active) ? saved.active! : '';
      }
      // The server answers its health check before it has answered anything else. A request that hangs here
      // used to leave the boot screen up forever with a stale log — bound each step, fail, and try again.
      const bounded = <T,>(p: Promise<T>, what: string) => Promise.race([p, sleep(BOOT_STEP_TIMEOUT_MS).then(() => { throw new Error(`${what} did not answer`); })]);
      const front = this.tab;
      await bounded(Promise.all([this.loadModels(front.client), this.loadSessions(front), front.client.commands().then(c => { this.serverCommands = c || []; }).catch(() => { /* older server */ })]), 'The model and session list');
      const remembered = localStorage.getItem(LS_SESSION + front.client.directory) || undefined;
      const initial = front.sessions.find(s => s.id === remembered) || front.sessions[0];
      await bounded(this.openSession(front, initial?.id), 'The conversation history');
      front.loaded = true;
      this.phase = 'ready';
      this.announceProject();
      this.update();
      // the other tabs load in the background so their dots are live from the start
      for (const t of this.tabs) { if (!t.loaded) { void this.loadTab(t); } }
    } catch (e) {
      if (this.isDisposed) { return; }
      console.warn('workspace: OpenCode boot failed, retrying', e);
      this.bootError = String((e as Error)?.message || e); this.bootMessage = `${agentName()} is not answering`;
      this.update();
      await sleep(2000);
      return this.boot();
    }
  }

  /** A request failed because the server went away: back to the boot screen, which waits for it. */
  protected fail(t: Tab | undefined, e: unknown, what: string): void {
    if (e instanceof OpenCodeError && e.status === 503) { void this.boot(); return; }
    const message = e instanceof Error ? e.message : String(e);
    console.warn('workspace: OpenCode', what, e);
    if (!t) { return; }
    t.localErrors.push({ id: `local-${Date.now()}`, message: `${what}: ${message}` });
    if (t.localErrors.length > 3) { t.localErrors.shift(); }
    this.update();
  }

  protected async loadModels(client: OpenCodeClient): Promise<void> {
    const [providers, config] = await Promise.all([client.providers(), client.config().catch(() => ({} as { model?: string }))]);
    const models: ModelOption[] = [];
    for (const p of providers.providers || []) {
      for (const m of Object.values(p.models || {})) {
        models.push({
          id: `${p.id}/${m.id}`, label: m.name || m.id, provider: p.name || p.id, providerID: p.id, modelID: m.id,
          images: !!(m.capabilities?.input?.image || m.capabilities?.attachment),
          efforts: EFFORTS.map(e => e.id).filter(id => id && m.variants && id in m.variants),
        });
      }
    }
    // within one heading, endpoint order first (llm, llm-2, …: endpoint 1 holds the default model)
    models.sort((a, b) => a.provider.localeCompare(b.provider) || a.providerID.localeCompare(b.providerID, undefined, { numeric: true }) || a.label.localeCompare(b.label));
    this.models = models;
    const remembered = localStorage.getItem(LS_MODEL) || undefined;
    const fallback = config.model || (providers.providers?.[0] ? `${providers.providers[0].id}/${providers.default?.[providers.providers[0].id] || Object.keys(providers.providers[0].models || {})[0]}` : undefined);
    this.modelId = models.find(m => m.id === remembered)?.id || models.find(m => m.id === fallback)?.id || models[0]?.id;
  }

  protected async loadSessions(t: Tab): Promise<void> {
    const all = await t.client.sessions();
    t.sessions = (all || []).filter(s => !s.parentID).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
  }

  /** Show a session in a tab (undefined = a fresh draft). Subscribes the tab's event stream once. */
  protected async openSession(t: Tab, id: string | undefined): Promise<void> {
    if (t === this.tab) { this.menu = 'none'; }
    t.queue = [];
    t.localErrors = [];
    t.sessionId = id;
    t.notes = [];
    t.compacting = undefined;
    t.chat = id ? new OpenCodeChat(id) : undefined;
    const chat = t.chat;
    if (chat) { chat.revertFrom = t.sessions.find(s => s.id === id)?.revert?.messageID; }
    if (id && chat) {
      localStorage.setItem(LS_SESSION + t.client.directory, id);
      const messages = await t.client.messages(id);
      if (t.sessionId !== id) { return; }   // the user moved on while history loaded
      chat.loadHistory(messages);
      chat.onChange(() => this.onChatChange(t, chat));
      // a question the tool is still waiting on (the card was reloaded mid-turn) must stay answerable
      try { for (const q of await t.client.questions()) { if (q.sessionID === id) { chat.attachQuestion(q); } } } catch { /* older server */ }
      try { for (const p of await t.client.permissions()) { if (p.sessionID === id) { chat.attachPermission(p); } } } catch { /* older server */ }
      // a tool the stored history still shows as running, in a session the server calls idle, was interrupted
      try { const busy = await t.client.sessionStatus(); if (busy[id]?.type === 'busy') { chat.status = 'busy'; t.wasBusy = true; } else { chat.settle(); } } catch { /* older server */ }
      if (t.sessionId !== id) { return; }
      this.update();
    } else {
      localStorage.removeItem(LS_SESSION + t.client.directory);
    }
    t.stick = true;
    this.subscribe(t);
    this.update();
  }

  protected subscribe(t: Tab): void {
    if (t.unsubscribe) { return; }
    // Over Theia's WebSocket, not an EventSource: the edge in front of the cluster caps plain HTTP responses
    // at 15 s, which cut an SSE stream every 15 s (see common/opencode-events.ts).
    t.unsubscribe = this.events.follow(t.client.directory, ev => this.onEvent(t, ev), s => {
      if (s === t.stream) { return; }
      const wasError = t.stream === 'error';
      t.stream = s;
      this.update();
      // The stream came back after a drop: whatever happened in the gap (blocks, the turn ending, a question)
      // never reached us. Reload the session from the server.
      if (s === 'open' && wasError) { void this.resync(t); }
    });
  }

  /** Re-read a tab's session from the server after the event stream was interrupted. */
  protected async resync(t: Tab): Promise<void> {
    const id = t.sessionId; const chat = t.chat;
    if (!id || !chat) { return; }
    try {
      const messages = await t.client.messages(id);
      if (t.sessionId !== id || t.chat !== chat) { return; }
      chat.loadHistory(messages);
      try { for (const q of await t.client.questions()) { if (q.sessionID === id) { chat.attachQuestion(q); } } } catch { /* older server */ }
      try { for (const p of await t.client.permissions()) { if (p.sessionID === id) { chat.attachPermission(p); } } } catch { /* older server */ }
      try { const busy = await t.client.sessionStatus(); if (busy[id]?.type === 'busy') { chat.status = 'busy'; } else { chat.settle(); } } catch { /* older server */ }
      this.update();
    } catch (e) { this.fail(t, e, 'Could not reload the conversation'); }
  }

  protected onEvent(t: Tab, ev: OCEvent): void {
    if (ev.type === 'session.created' || ev.type === 'session.updated' || ev.type === 'session.deleted') {
      const info = ev.properties.info;
      if (info.parentID) { return; }
      t.sessions = t.sessions.filter(s => s.id !== info.id);
      if (ev.type !== 'session.deleted') { t.sessions.unshift(info); }
      if (info.id === t.sessionId && t.chat && ev.type === 'session.updated') { t.chat.setRevert(info.revert?.messageID); }
      this.update();
      return;
    }
    t.chat?.handleEvent(ev);
  }

  protected onChatChange(t: Tab, chat: OpenCodeChat): void {
    if (t.chat !== chat) { return; }   // a session this tab has since left
    const busy = chat.status !== 'idle';
    if (t.wasBusy && !busy) {
      const next = t.queue.shift();
      if (next) { void this.send(t, next.text, next.images); }
      else {
        if (t !== this.tab) { t.unseen = true; }
        if (t !== this.tab || document.hidden || Date.now() - this.lastInput > 5000) { this.raiseAttention(); }
      }
    }
    if (busy && !t.wasBusy && t === this.tab) { this.clearAttention(); }
    t.wasBusy = busy;
    this.update();
  }

  // ── actions (on the tab in front unless a tab is passed) ──────────────────

  protected async ensureSession(t: Tab): Promise<void> {
    if (t.sessionId) { return; }
    const s = await t.client.createSession();
    t.sessions.unshift(s);
    await this.openSession(t, s.id);
  }

  /**
   * OpenCode connects MCP servers once per folder, when it first opens that folder, and never retries. A sign-in
   * that completes later (in another folder) left a project tab opened before it with a dead server: no tools, and
   * the model went looking for them through `claude mcp` and `opencode run`. Before a message, retry the servers that failed or wanted a sign-in — at most every 30 s per tab, and
   * never holding the message up for more than a few seconds.
   */
  protected async reconnectMcp(t: Tab): Promise<void> {
    if (t.mcpTried && Date.now() - t.mcpTried < 30000) { return; }
    t.mcpTried = Date.now();
    const work = (async () => {
      const st = await t.client.mcpStatus();
      await Promise.all(Object.entries(st || {})
        .filter(([, v]) => v && (v.status === 'failed' || v.status === 'needs_auth'))
        .map(([name]) => t.client.mcpConnect(name).catch(() => undefined)));
    })().catch(() => undefined);
    await Promise.race([work, new Promise(r => setTimeout(r, 4000))]);
  }

  protected async send(t: Tab, text: string, images: Attachment[] = []): Promise<void> {
    text = text.trim();
    if (!text && !images.length) { return; }
    // busy: one more in line (it used to replace the one already waiting)
    if (t.chat && t.chat.status !== 'idle') { t.queue.push({ id: `q-${Date.now()}-${t.queue.length}`, text, images }); this.update(); return; }
    t.notes = [];   // /help, "Model: …" and friends are about the moment before; a real message moves on
    t.sending = true; this.update();
    try {
      await this.reconnectMcp(t);
      await this.ensureSession(t);
      const m = this.models.find(x => x.id === this.modelId);
      t.stick = true;
      const variant = this.effort && m?.efforts.includes(this.effort) ? this.effort : undefined;
      await t.client.prompt(t.sessionId!, text || 'What is in this image?', m ? { providerID: m.providerID, modelID: m.modelID } : undefined, this.mode, m?.images ? images : [], variant);
      t.wasBusy = true;   // the busy status is on its way; a queued follow-up must wait for the idle after it
    } catch (e) { this.fail(t, e, 'Could not send'); }
    finally { t.sending = false; this.update(); }
  }

  /** Images from paste, drop or the picker → data URLs on the tab, up to MAX_IMAGES of at most MAX_IMAGE_BYTES. */
  protected async attach(files: File[]): Promise<void> {
    const t = this.tab;
    for (const f of files) {
      if (t.attachments.length >= MAX_IMAGES) { this.fail(t, new Error(`At most ${MAX_IMAGES} images per message`), 'Image not added'); break; }
      if (f.size > MAX_IMAGE_BYTES) { this.fail(t, new Error(`${f.name || 'The image'} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`), 'Image not added'); continue; }
      const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
      t.attachments.push({ id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: f.name || 'pasted image', mime: f.type || 'image/png', url });
    }
    this.update();
    this.inputRef.current?.focus();
  }

  /** The vision model to suggest when the chosen one does not take images. */
  protected imageHint(): string {
    const v = this.models.find(x => x.images);
    return v ? `${this.models.find(x => x.id === this.modelId)?.label || 'This model'} can't see images — switch to ${v.label} to send them` : 'None of the models here can see images';
  }

  protected setMode(mode: 'build' | 'plan'): void { this.mode = mode; localStorage.setItem(LS_MODE, mode); this.update(); this.inputRef.current?.focus(); }

  protected submit(): void {
    const t = this.tab;
    const text = this.input.trim();
    if (t.attachments.length && !this.models.find(x => x.id === this.modelId)?.images) { this.fail(t, new Error(this.imageHint()), 'Not sent'); return; }
    if (!text && t.attachments.length) {
      const images = t.attachments; t.attachments = [];
      void this.send(t, '', images); return;
    }
    if (!text) { return; }
    if (text.startsWith('/')) {
      // Enter on the palette picks the highlighted command when the typed name is only a prefix of it
      const [typed] = text.slice(1).split(/\s+/);
      const cands = this.slashCandidates();
      const pick = cands[this.paletteIndex];
      if (pick && pick.name !== typed && cands.length && typed.length < pick.name.length && text.indexOf(' ') === -1) { this.input = `/${pick.name}${pick.args ? ' ' : ''}`; this.paletteIndex = 0; this.update(); if (!pick.args) { void this.runSlash(t, this.input.trim()); this.input = ''; } return; }
      this.input = ''; void this.runSlash(t, text); return;
    }
    if (text.startsWith('!') && text.length > 1) { this.input = ''; void this.runShell(t, text.slice(1).trim()); return; }
    const images = t.attachments; t.attachments = [];
    this.input = ''; void this.send(t, text, images);
  }

  protected allCommands(): SlashCommand[] {
    // Pi has no undo yet: offer only what this assistant does
    const builtin = BUILTIN_COMMANDS.filter(c => !(agentName() === 'Pi' && (c.name === 'undo' || c.name === 'redo')));
    const seen = new Set(builtin.map(c => c.name));
    // Skills load by themselves when they are relevant; as commands they only puzzle (/customize-opencode
    // and friends). OpenCode's own commands (/init, /review, custom ones) stay.
    const server = this.serverCommands.filter(c => c.name && !seen.has(c.name) && c.source !== 'skill')
      .map(c => ({ name: c.name, description: clip(c.description || 'A command', 110), server: true, args: '[arguments]' }));
    return [...builtin, ...server];
  }

  /** Compaction rows in the tab's chat, to tell when the one /compact asked for has arrived. */
  protected compactions(t: Tab): number { return (t.chat?.visibleTurns() || []).reduce((n, x) => n + x.blocks.filter(b => b.type === 'compaction').length, 0); }

  /** Commands matching what is typed so far (the palette shows these). */
  protected slashCandidates(): SlashCommand[] {
    if (!this.input.startsWith('/') || this.input.includes('\n')) { return []; }
    const typed = this.input.slice(1).split(/\s+/)[0].toLowerCase();
    if (this.input.includes(' ')) { const exact = this.allCommands().find(c => c.name === typed); return exact ? [exact] : []; }
    return this.allCommands().filter(c => c.name.startsWith(typed));
  }

  protected onSpecialKey(key: string): boolean {
    const cands = this.slashCandidates();
    if (!cands.length) { return false; }
    if (key === 'ArrowDown') { this.paletteIndex = (this.paletteIndex + 1) % cands.length; this.update(); return true; }
    if (key === 'ArrowUp') { this.paletteIndex = (this.paletteIndex - 1 + cands.length) % cands.length; this.update(); return true; }
    if (key === 'Tab') { const c = cands[this.paletteIndex] || cands[0]; this.input = `/${c.name}${c.args ? ' ' : ''}`; this.paletteIndex = 0; this.update(); return true; }
    if (key === 'Escape') { this.input = ''; this.paletteIndex = 0; this.update(); return true; }
    return false;
  }

  /** Pi only: hand a waiting message to the running work now (it reads it after the current step) instead of after it. */
  protected async steer(t: Tab, q: Queued): Promise<void> {
    t.queue = t.queue.filter(x => x !== q); this.update();
    const m = this.models.find(x => x.id === this.modelId);
    try { await t.client.prompt(t.sessionId!, q.text, m ? { providerID: m.providerID, modelID: m.modelID } : undefined, this.mode, m?.images ? q.images : [], undefined, true); }
    catch (e) { t.queue.unshift(q); this.fail(t, e, 'Could not send it now'); }
  }

  protected note(t: Tab, html: string): void {
    t.notes.push({ id: `note-${Date.now()}`, html, at: Date.now() });
    if (t.notes.length > 5) { t.notes.shift(); }
    t.stick = true; this.update();
  }

  protected async runSlash(t: Tab, text: string): Promise<void> {
    const [nameRaw, ...rest] = text.slice(1).split(/\s+/);
    const name = nameRaw.toLowerCase(); const args = rest.join(' ').trim();
    const m = this.models.find(x => x.id === this.modelId);
    if (agentName() === 'Pi' && (name === 'undo' || name === 'redo')) {
      this.note(t, '<p>Undo isn’t in Pi yet. To go back, ask Pi to change it back, or switch to OpenCode in Settings.</p>'); return;
    }
    switch (name) {
      case 'new': case 'clear': void this.openSession(t, undefined); return;
      case 'sessions': case 'history': case 'resume': this.menu = 'history'; this.update(); return;
      case 'help': case '?':
        this.note(t, '<p><strong>Slash commands</strong></p><ul>' + this.allCommands().map(c => `<li><code>/${c.name}${c.args ? ' ' + c.args : ''}</code> — ${escapeHtml(c.description)}</li>`).join('') + `<li><code>!command</code> — run a shell command here, its output lands in the chat</li></ul><p>Everything else you type goes to ${agentName()} as a message.</p>`);
        return;
      case 'model': case 'models': {
        if (!args) { this.menu = 'models'; this.update(); return; }
        const q = args.toLowerCase();
        const hit = this.models.find(x => x.id.toLowerCase() === q || x.modelID.toLowerCase() === q || x.label.toLowerCase() === q) || this.models.find(x => x.label.toLowerCase().includes(q) || x.modelID.toLowerCase().includes(q));
        if (hit) { this.pickModel(hit.id); this.note(t, `<p>Model: <strong>${escapeHtml(hit.label)}</strong></p>`); } else { this.note(t, `<p>No model called “${escapeHtml(args)}”. ${this.models.map(x => `<code>${escapeHtml(x.label)}</code>`).join(', ')}.</p>`); }
        return;
      }
      case 'compact': case 'summarize': case 'summarise': {
        if (!t.sessionId || !m) { this.note(t, '<p>Nothing to compact yet.</p>'); return; }
        // the placeholder row goes when the compaction itself shows up (render); no note that outlives it
        t.compacting = { since: Date.now(), before: this.compactions(t) }; t.stick = true; this.update();
        try {
          const r = await t.client.summarize(t.sessionId, m.providerID, m.modelID) as unknown as { compacted?: boolean } | boolean | undefined;
          // the summary row arrives over the event stream; give it a moment, then drop the placeholder either way
          setTimeout(() => {
            if (!t.compacting) { return; }
            t.compacting = undefined;
            if (r && typeof r === 'object' && r.compacted === false) { this.note(t, '<p>Nothing to compact yet — the conversation is still short.</p>'); } else { this.update(); }
          }, 2000);
        } catch (e) { t.compacting = undefined; this.fail(t, e, 'Could not compact'); }
        return;
      }
      case 'undo': {
        const users = (t.chat?.visibleTurns() || []).filter(x => x.role === 'user');
        const last = users[users.length - 1];
        if (!t.sessionId || !last) { this.note(t, '<p>Nothing to undo.</p>'); return; }
        try { await t.client.revert(t.sessionId, last.id); t.chat!.setRevert(last.id); this.note(t, '<p>Took back the last message and its changes. <code>/redo</code> brings it back.</p>'); } catch (e) { this.fail(t, e, 'Could not undo'); }
        return;
      }
      case 'redo': {
        if (!t.sessionId || !t.chat?.revertFrom) { this.note(t, '<p>Nothing to redo.</p>'); return; }
        try { await t.client.unrevert(t.sessionId); t.chat.setRevert(undefined); t.notes = []; this.update(); } catch (e) { this.fail(t, e, 'Could not redo'); }
        return;
      }
    }
    const server = this.serverCommands.find(c => c.name === name);
    if (server) {
      try {
        await this.ensureSession(t);
        t.wasBusy = true; t.stick = true;
        await t.client.command(t.sessionId!, server.name, args, this.modelId);
      } catch (e) { this.fail(t, e, `Could not run /${name}`); }
      return;
    }
    this.note(t, `<p>No command called <code>/${escapeHtml(name)}</code>. Type <code>/help</code> for the list, or write it as a message.</p>`);
  }

  protected async runShell(t: Tab, command: string): Promise<void> {
    if (!command) { return; }
    const m = this.models.find(x => x.id === this.modelId);
    try {
      await this.ensureSession(t);
      t.wasBusy = true; t.stick = true;
      await t.client.shell(t.sessionId!, command, m ? { providerID: m.providerID, modelID: m.modelID } : undefined);
    } catch (e) { this.fail(t, e, 'Could not run the command'); }
  }

  protected async abort(): Promise<void> {
    const t = this.tab;
    if (!t.sessionId) { return; }
    try { await t.client.abort(t.sessionId); } catch (e) { this.fail(t, e, 'Could not stop'); }
  }

  protected async respondPermission(permissionId: string, response: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    const t = this.tab;
    if (!t.sessionId || !t.chat) { return; }
    t.chat.markPermission(permissionId, response === 'reject' ? 'rejected' : 'allowed');
    try { await t.client.permission(t.sessionId, permissionId, response, message); } catch (e) { this.fail(t, e, 'Could not answer'); }
  }

  /** Answers go through OpenCode's question API — the turn is blocked on the tool until then. */
  protected async answerQuestion(block: QuestionBlock, answers: string[][]): Promise<void> {
    const t = this.tab;
    if (!t.chat) { return; }
    let requestId = block.requestId;
    if (!requestId) {
      // the request event was missed: ask the server which request belongs to this tool call
      try { requestId = (await t.client.questions()).find(q => q.sessionID === t.sessionId && (!block.callID || q.tool?.callID === block.callID))?.id; } catch { /* below */ }
      if (!requestId) { this.fail(t, new Error('OpenCode is no longer waiting on this question'), 'Could not answer'); return; }
      block.requestId = requestId;
    }
    t.chat.markQuestion(requestId, 'answered', answers);
    try { await t.client.answerQuestion(requestId, answers); } catch (e) { t.chat.markQuestion(requestId, 'pending'); this.fail(t, e, 'Could not answer'); }
  }

  protected async rejectQuestion(block: QuestionBlock): Promise<void> {
    const t = this.tab;
    if (!t.chat || !block.requestId) { return; }
    t.chat.markQuestion(block.requestId, 'rejected');
    try { await t.client.rejectQuestion(block.requestId); } catch (e) { this.fail(t, e, 'Could not skip'); }
  }

  protected newChat(): void { void this.openSession(this.tab, undefined); }

  protected pickModel(id: string): void {
    this.modelId = id; localStorage.setItem(LS_MODEL, id); this.menu = 'none'; this.update();
  }

  protected async deleteSession(id: string, e: React.MouseEvent): Promise<void> {
    e.stopPropagation();
    const t = this.tab;
    try {
      await t.client.deleteSession(id);
      t.sessions = t.sessions.filter(s => s.id !== id);
      if (t.sessionId === id) { await this.openSession(t, t.sessions[0]?.id); } else { this.update(); }
    } catch (err) { this.fail(t, err, 'Could not delete'); }
  }

  // ── "your turn" while the user is away: pulse the card's title dot ────────
  protected attention = false;
  protected raiseAttention(): void { if (this.attention) { return; } this.attention = true; this.node.querySelector('.oc-head-dot')?.classList.add('ws-attn'); }
  protected clearAttention(): void { if (!this.attention) { return; } this.attention = false; this.node.querySelector('.oc-head-dot')?.classList.remove('ws-attn'); }

  // ── rendering ─────────────────────────────────────────────────────────────

  protected onUpdateRequest(msg: Message): void {
    super.onUpdateRequest(msg);
    if (this.raf) { cancelAnimationFrame(this.raf); }
    this.raf = requestAnimationFrame(() => { this.raf = undefined; const el = this.scrollRef.current; if (el && this.tab?.stick) { el.scrollTop = el.scrollHeight; } });
  }

  protected onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.node.querySelector<HTMLTextAreaElement>('.oc-input')?.focus();
  }

  protected onScroll = (): void => {
    const el = this.scrollRef.current; if (!el || !this.tab) { return; }
    this.tab.stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  protected render(): React.ReactNode {
    let card: React.ReactNode;
    try { card = this.renderCard(); } catch (e) { this.reportCrash(e as Error, 'render'); card = this.renderCrash(e as Error); }
    return <CardBoundary key={this.crashKey} onError={(e, stack) => this.reportCrash(e, stack)} fallback={e => this.renderCrash(e)}>{card}</CardBoundary>;
  }

  protected reportCrash(e: Error, where: string): void {
    const tab = this.tab ? `tab "${this.labelOf(this.tab.folder)}" session ${this.tab.sessionId || '(draft)'}` : 'no tab';
    console.error('workspace: assistant card crashed', e, where);
    this.logger.error(`workspace: assistant card crashed (${tab}): ${e?.stack || e} ${where.slice(0, 600)}`);
  }

  /** What a crash looks like to the user: what happened, and two ways forward. */
  protected renderCrash(e: Error): React.ReactNode {
    return (
      <div className="oc-root oc-boot">
        <div className="oc-boot-title">{agentName()} could not show this conversation</div>
        <div className="oc-boot-sub">Something in it confused the panel. Your files are fine, and so is the conversation itself.<br /><code>{String(e?.message || e).slice(0, 200)}</code></div>
        <div className="oc-crash-actions">
          <button className="ws-primary" onClick={() => { this.crashKey++; this.update(); }}>Try again</button>
          <button className="oc-tb-btn" onClick={() => { this.crashKey++; this.newChat(); }}>Start a new conversation</button>
        </div>
      </div>
    );
  }

  protected renderCard(): React.ReactNode {
    if (this.phase === 'boot' || !this.tab) { return this.renderBoot(); }
    const t = this.tab;
    const chat = t.chat;
    const busy = !!chat && chat.status !== 'idle';
    const turns = chat?.visibleTurns() || [];
    // /compact's placeholder: until its compaction row is in the chat (or five minutes, in case it never comes)
    if (t.compacting && (this.compactions(t) > t.compacting.before || Date.now() - t.compacting.since > 300_000)) { t.compacting = undefined; }
    const compacting = !!t.compacting;
    const model = this.models.find(m => m.id === this.modelId);
    const cands = this.slashCandidates();
    return (
      <div className="oc-root">
        {/* the card's title row, like Claude's: name, the project tabs, history + new chat on the right */}
        <div className="oc-head">
          <span className="ws-claude-dot oc-head-dot" aria-hidden="true" /><span className="oc-head-title">{agentName()}</span>
          {this.renderTabs()}
          <div className="oc-head-actions">
            <button className={`oc-tb-btn ${this.menu === 'history' ? 'is-on' : ''}`} title="Previous chats" onClick={() => { this.menu = this.menu === 'history' ? 'none' : 'history'; this.update(); }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" /></svg>
            </button>
            <button className="oc-tb-btn" title="New chat" onClick={() => this.newChat()} disabled={!t.sessionId}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5z" /><path d="M12 8v7" /><path d="M8.5 11.5h7" /></svg>
            </button>
          </div>
          {this.menu === 'history' && this.renderHistory()}
          {this.menu === 'tabs' && this.renderTabsMenu()}
        </div>
        <div className="oc-scroll" ref={this.scrollRef} onScroll={this.onScroll}>
          <div className="oc-col oc-col--scroll">
            {turns.length === 0 && t.notes.length === 0 ? this.renderHero() : (
              <div className="oc-list">
                {/* turns and the card's own notes, in the order they happened */}
                {[...turns.map(x => ({ at: x.createdAt, turn: x, note: undefined })), ...t.notes.map(n => ({ at: n.at, turn: undefined, note: n }))]
                  .sort((a, b) => a.at - b.at)
                  .map(({ turn: x, note: n }) => x
                    ? <TurnView key={x.id} turn={x} dir={t.client.directory} thinking={chat!.thinking} thoughtFor={chat!.thoughtFor[x.id]}
                      onPermission={(id, r, m) => void this.respondPermission(id, r, m)} onAnswer={(b, a) => void this.answerQuestion(b, a)} onReject={b => void this.rejectQuestion(b)} />
                    : <div key={n!.id} className="oc-row oc-turn--assistant oc-note"><span className="oc-dot oc-dot--text" /><div className="oc-row-body oc-bubble" dangerouslySetInnerHTML={{ __html: n!.html }} /></div>)}
                {compacting && <div className="oc-row oc-turn--assistant"><span className="oc-dot oc-dot--run" /><div className="oc-row-body"><span className="oc-shimmer">Compacting the conversation…</span></div></div>}
                {chat && chat.status === 'retry' && <div className="oc-row oc-turn--assistant"><span className="oc-dot oc-dot--run" /><div className="oc-row-body oc-muted">{chat.retryMessage || 'Retrying…'}</div></div>}
                {/* the one status line while OpenCode works — "✻ Cogitating…" under the last row, like the Claude extension */}
                {chat && busy && !chat.thinking && <div className="oc-row oc-turn--assistant oc-row--busy"><span className="oc-dot oc-dot--text" /><div className="oc-row-body"><BusyHint /></div></div>}
                <div className="oc-tail" />
              </div>
            )}
          </div>
        </div>
        <div className="oc-footer">
          <div className="oc-col">
            {t.localErrors.map(e => <div key={e.id} className="oc-error"><span className="oc-error-text">{e.message}</span><button className="oc-queued-cancel" title="Dismiss" onClick={() => { t.localErrors = t.localErrors.filter(x => x !== e); this.update(); }}>×</button></div>)}
            {t.stream === 'error' && <div className="oc-stream-warn">Reconnecting to {agentName()}…</div>}
            {t.queue.map((q, i) => (
              <div key={q.id} className="oc-queued">
                <span className="oc-queued-label">{i === 0 ? 'Next' : `Then`}</span>
                <span className="oc-queued-text">{q.text || (q.images.length ? `${q.images.length} image${q.images.length > 1 ? 's' : ''}` : '')}{q.text && q.images.length ? ` (+${q.images.length} image${q.images.length > 1 ? 's' : ''})` : ''}</span>
                {/* Pi reads a steer after the current step; OpenCode has no such thing, so there it just waits */}
                {agentName() === 'Pi' && busy && <button className="oc-queued-now" title="Give it to Pi now — it reads it after the current step" onClick={() => void this.steer(t, q)}>Send now</button>}
                <button className="oc-queued-cancel" title="Take it back into the box" onClick={() => { t.queue = t.queue.filter(x => x !== q); if (!this.input.trim()) { this.input = q.text; t.attachments = q.images; } this.update(); }}>×</button>
              </div>
            ))}
            {/* keyed by tab: each tab has its own draft (the composer keeps it in local state) */}
            <React.Fragment key={t.folder || '.'}>
            <Composer value={this.input} onChange={v => { this.input = v; this.paletteIndex = 0; this.update(); }} onSubmit={() => this.submit()} onAbort={() => void this.abort()}
              busy={busy} disabled={t.sending} inputRef={this.inputRef} onSpecialKey={k => this.onSpecialKey(k)}
              attachments={t.attachments} onAttach={files => void this.attach(files)}
              onRemoveAttachment={id => { t.attachments = t.attachments.filter(a => a.id !== id); this.update(); }}
              canAttach={!!model?.images} attachHint={this.imageHint()}
              placeholder={this.mode === 'plan' ? `Ask ${agentName()} for a plan — nothing changes until you switch to Build…` : undefined}
              palette={cands.length > 0 && (
                <div className="oc-palette" role="listbox">
                  {cands.map((c, i) => (
                    <button key={c.name} className={`oc-palette-item ${i === this.paletteIndex ? 'is-on' : ''}`} role="option" aria-selected={i === this.paletteIndex}
                      onMouseDown={e => e.preventDefault()} onClick={() => { this.input = `/${c.name}${c.args ? ' ' : ''}`; this.paletteIndex = 0; this.update(); if (!c.args) { this.submit(); } else { this.inputRef.current?.focus(); } }}>
                      <span className="oc-palette-name">/{c.name}{c.args && <span className="oc-palette-args"> {c.args}</span>}</span>
                      <span className="oc-palette-desc">{c.description}</span>
                    </button>
                  ))}
                </div>
              )}
              leading={<>
                <button className="oc-slash-btn" title="Commands" onClick={() => { this.input = '/'; this.paletteIndex = 0; this.update(); this.inputRef.current?.focus(); }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M14 8l-4 8" /></svg>
                </button>
                <div className="oc-mode" role="radiogroup" aria-label="Mode">
                  <button role="radio" aria-checked={this.mode === 'build'} className={this.mode === 'build' ? 'is-on' : ''} title={`Build: ${agentName()} makes the changes`} onClick={() => this.setMode('build')}>Build</button>
                  <button role="radio" aria-checked={this.mode === 'plan'} className={this.mode === 'plan' ? 'is-on' : ''} title={`Plan: ${agentName()} looks around and proposes a plan, changes nothing`} onClick={() => this.setMode('plan')}>Plan</button>
                </div>
                {this.models.length > 0 && (
                <div className="oc-model-wrap">
                  <button className={`oc-model-pill ${this.menu === 'models' ? 'is-on' : ''}`} title="Model" onClick={() => { this.menu = this.menu === 'models' ? 'none' : 'models'; this.update(); }}>
                    {model?.label || 'Model'}
                  </button>
                  {this.menu === 'models' && this.renderModels()}
                </div>
                )}
                {model && model.efforts.length > 0 && (
                <div className="oc-model-wrap">
                  <button className={`oc-model-pill oc-effort-pill ${this.menu === 'effort' ? 'is-on' : ''} ${this.effort === 'high' || this.effort === 'max' ? 'is-deep' : ''}`}
                    title="How hard the model thinks before it answers" onClick={() => { this.menu = this.menu === 'effort' ? 'none' : 'effort'; this.update(); }}>
                    {this.effort ? `Thinking: ${EFFORTS.find(e => e.id === this.effort)?.label}` : 'Thinking'}
                  </button>
                  {this.menu === 'effort' && (
                    <div className="oc-menu oc-menu--models">
                      <div className="oc-menu-cap">Thinking</div>
                      {EFFORTS.filter(e => !e.id || model.efforts.includes(e.id)).map(e => (
                        <button key={e.id || 'default'} className={`oc-menu-item ${e.id === this.effort ? 'is-on' : ''}`}
                          onClick={() => { this.effort = e.id; localStorage.setItem(LS_EFFORT, e.id); this.menu = 'none'; this.update(); this.inputRef.current?.focus(); }}>
                          <span className="oc-menu-main">{e.label}</span><span className="oc-menu-sub">{e.hint}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                )}
              </>} />
            </React.Fragment>
          </div>
        </div>
      </div>
    );
  }

  /** The project tabs: Workspace, the opened folders, "+". A dot per tab: working, needs you, done (unseen). */
  protected renderTabs(): React.ReactNode {
    const hint: Record<TabState, string> = { idle: '', busy: ' — working', needs: ' — needs you', done: ' — done' };
    return (
      <div className="oc-tabs" role="tablist">
        {this.tabs.map(t => {
          const st = this.stateOf(t);
          const on = t === this.tab;
          return (
            <button key={t.folder || '.'} role="tab" aria-selected={on} className={`oc-tab ${on ? 'is-on' : ''}`} title={this.labelOf(t.folder) + hint[st]} onClick={() => void this.activateTab(t.folder)}>
              <span className="oc-tab-label">{this.labelOf(t.folder)}</span>
              {t.folder && <span className="oc-tab-x" role="button" title="Close (the chats stay)" onClick={e => this.closeTab(t.folder, e)}>×</span>}
            </button>
          );
        })}
        <button className={`oc-tab-add ${this.menu === 'tabs' ? 'is-on' : ''}`} title="Open a project" onClick={() => void this.openTabsMenu()}>+</button>
      </div>
    );
  }

  protected renderTabsMenu(): React.ReactNode {
    if (this.tabs.length >= MAX_TABS) {
      return (
        <div className="oc-menu oc-menu--tabs">
          <div className="oc-menu-note">{MAX_TABS} tabs is the most at once. Close one (×) to open another project — its chats stay.</div>
        </div>
      );
    }
    return (
      <div className="oc-menu oc-menu--tabs">
        {this.folderChoices.length > 0 && <div className="oc-menu-cap">Your folders</div>}
        {this.folderChoices.map(f => (
          <button key={f} className="oc-menu-item" onClick={() => void this.openTab(f)}><span className="oc-menu-main">{f}</span></button>
        ))}
        <div className="oc-menu-cap">New folder</div>
        <form className="oc-newfolder" onSubmit={e => { e.preventDefault(); void this.createFolder(); }}>
          <input className="oc-newfolder-input" placeholder="my-app" value={this.newFolder} autoFocus={this.folderChoices.length === 0}
            onChange={e => { this.newFolder = e.target.value; this.update(); }} />
          <button type="submit" className="oc-newfolder-go" disabled={!this.newFolder.trim()}>Create</button>
        </form>
      </div>
    );
  }

  protected renderHero(): React.ReactNode {
    return (
      <div className="oc-hero">
        <div className="oc-hero-mark" aria-hidden="true" />
        <div className="oc-hero-sub">{this.tab?.folder ? `${agentName()} works in ${this.tab.folder}. Ask it to build or change something.` : `${agentName()} edits the files for you. Open one on the left to follow along.`}</div>
      </div>
    );
  }

  protected renderHistory(): React.ReactNode {
    const t = this.tab;
    return (
      <div className="oc-menu oc-menu--history">
        <button className={`oc-menu-item ${!t.sessionId ? 'is-on' : ''}`} onClick={() => this.newChat()}><span className="oc-menu-main">New chat</span></button>
        {t.sessions.length > 0 && <div className="oc-menu-cap">Previous chats{t.folder ? ` in ${t.folder}` : ''}</div>}
        {t.sessions.map(s => (
          <button key={s.id} className={`oc-menu-item ${s.id === t.sessionId ? 'is-on' : ''}`} onClick={() => void this.openSession(t, s.id)}>
            <span className="oc-menu-main">{s.title || 'Untitled'}</span>
            <span className="oc-menu-sub">{relTime(s.time?.updated)}</span>
            <span className="oc-menu-del" role="button" title="Delete" onClick={e => void this.deleteSession(s.id, e)}>×</span>
          </button>
        ))}
      </div>
    );
  }

  protected renderModels(): React.ReactNode {
    const groups = new Map<string, ModelOption[]>();
    for (const m of this.models) { const g = groups.get(m.provider) || []; g.push(m); groups.set(m.provider, g); }
    return (
      <div className="oc-menu oc-menu--models">
        {[...groups.entries()].map(([provider, models]) => (
          <React.Fragment key={provider}>
            {/* grouped by provider name — endpoints sharing an LLM_LABEL get one heading */}
            <div className="oc-menu-cap">{provider}</div>
            {models.map(m => (
              <button key={m.id} className={`oc-menu-item ${m.id === this.modelId ? 'is-on' : ''}`} onClick={() => this.pickModel(m.id)}>
                <span className="oc-menu-main">{m.label}</span>
                {m.label !== m.modelID && <span className="oc-menu-sub">{m.modelID}</span>}
              </button>
            ))}
          </React.Fragment>
        ))}
      </div>
    );
  }

  protected renderBoot(): React.ReactNode {
    const failed = !!this.bootError;
    return (
      <div className="oc-root oc-root--boot">
        <div className="oc-boot">
          <div className={`oc-hero-orb ${failed ? 'is-still' : ''}`} />
          <div className="oc-boot-title">{this.bootMessage}</div>
          {failed
            ? <div className="oc-boot-sub">{this.bootError}. Retrying in the background — a terminal <code>opencode --version</code> tells you whether OpenCode is installed here at all.</div>
            : <div className="oc-boot-sub">First start on a fresh workspace can take a moment.</div>}
          {this.bootLog.length > 0 && <pre className="oc-boot-log">{this.bootLog.slice(-6).join('\n')}</pre>}
        </div>
      </div>
    );
  }
}

/** Skill descriptions are written for the model and run long; one line is enough for a menu. */
function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) { return t; }
  const cut = t.slice(0, n); const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '));
  return (at > 40 ? cut.slice(0, at) : cut).replace(/[\s,.]+$/, '') + '…';
}

function escapeHtml(s: string): string { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)); }

function relTime(ms: number | undefined): string {
  if (!ms) { return ''; }
  const d = Date.now() - ms;
  const m = Math.round(d / 60000);
  if (m < 1) { return 'just now'; }
  if (m < 60) { return `${m} min ago`; }
  const h = Math.round(m / 60);
  if (h < 24) { return `${h} h ago`; }
  const days = Math.round(h / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
