import {
  Block, ErrorBlock, OCAssistantMessage, OCError, OCEvent, OCMessage, OCMessageWithParts, OCPart, OCPermission, OCPermissionRequest, OCQuestionRequest, OCReasoningPart,
  OCTextPart, OCToolPart, OCToolState, PermissionBlock, QuestionBlock, SessionStatus, TextBlock, Thinking, ToolBlock, Turn,
} from './types';
import { agentName } from '../assistant';

/**
 * One OpenCode session as the chat sees it: turns of blocks, built from the stored messages (loadHistory) and kept
 * current from the event stream (handleEvent): an adapter + reducer in one browser-side class — there is no
 * server in between here, the widget subscribes and re-renders.
 *
 * Grouping rule: a user message is its own turn; every assistant message with the same parentID (OpenCode splits a
 * reply into a message per step) lands in one `asst-<parentID>` turn. Events for other sessions are ignored — the
 * project's stream carries them all.
 */
export class OpenCodeChat {
  turns: Turn[] = [];
  status: SessionStatus = 'idle';
  retryMessage = '';
  thinking: Thinking | null = null;
  /** seconds each turn spent reasoning before its first block, for the "Thought for Ns" chip */
  thoughtFor: Record<string, number> = {};
  /** `provider/model` of the last assistant message */
  model?: string;
  /** /undo: the message the session is rewound to; turns from it on are hidden until /redo or a new message */
  revertFrom?: string;

  protected roles = new Map<string, 'user' | 'assistant'>();
  /** messages that are a compaction summary: their text is a CompactionBlock, not a reply */
  protected summaries = new Set<string>();
  protected msgToTurn = new Map<string, string>();
  protected listeners = new Set<() => void>();

  constructor(readonly sessionId: string) {}

  setRevert(messageID: string | undefined): void { this.revertFrom = messageID; this.emit(); }

  /** The turns to show: everything before the revert point (all of them when not rewound). */
  visibleTurns(): Turn[] {
    if (!this.revertFrom) { return this.turns; }
    const turnId = this.msgToTurn.get(this.revertFrom) || this.revertFrom;
    const i = this.turns.findIndex(t => t.id === turnId);
    return i === -1 ? this.turns : this.turns.slice(0, i);
  }

  onChange(l: () => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  protected emit(): void { for (const l of this.listeners) { l(); } }

  /** Rebuild the chat from OpenCode's stored messages (chronological; history never streams). */
  loadHistory(messages: OCMessageWithParts[]): void {
    const sorted = [...messages].sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0));
    this.turns = [];
    for (const { info, parts } of sorted) {
      const turn = this.turnFor(info);
      for (const part of parts) {
        const block = this.blockOf(part, info.role);
        if (!block) { continue; }
        if (block.type === 'text' || block.type === 'compaction') { block.streaming = false; }
        upsert(turn, block);
      }
    }
    this.emit();
  }

  handleEvent(ev: OCEvent): void {
    switch (ev.type) {
      case 'message.updated': {
        const msg = ev.properties.info;
        if (msg.sessionID !== this.sessionId) { return; }
        if (this.revertFrom && msg.role === 'user' && !this.msgToTurn.has(msg.id)) {
          // a message after /undo: OpenCode has discarded the rewound turns for good
          const turnId = this.msgToTurn.get(this.revertFrom) || this.revertFrom;
          const i = this.turns.findIndex(t => t.id === turnId);
          if (i !== -1) { this.turns.splice(i); }
          this.revertFrom = undefined;
        }
        this.turnFor(msg);
        break;
      }
      case 'message.part.updated': {
        const { part, delta } = ev.properties;
        if (part.sessionID !== this.sessionId) { return; }
        const turnId = this.msgToTurn.get(part.messageID) || 'asst-' + part.messageID;
        if (part.type === 'reasoning') {
          const rp = part as OCReasoningPart;
          const text = (rp.text || '') + (delta || '');
          const same = this.thinking && this.thinking.turnId === turnId ? this.thinking : null;
          if (this.thinking && !same) { this.endThinking(); }
          this.thinking = { turnId, since: same ? same.since : Date.now(), tail: text.length > 600 ? text.slice(-600) : text };
          break;
        }
        const block = this.blockOf(part, this.roles.get(part.messageID) || 'assistant', delta);
        if (!block) { return; }
        const turn = this.turns.find(t => t.id === turnId) || this.ensureTurn(turnId, 'assistant', Date.now());
        if (this.thinking && this.thinking.turnId === turnId) { this.endThinking(); }
        upsert(turn, block);
        break;
      }
      case 'permission.updated': {
        const perm = ev.properties;
        if (perm.sessionID !== this.sessionId) { return; }
        const block = permissionBlock(perm);
        // A permission ask must land somewhere — OpenCode waits for the answer. Unknown message: the latest turn.
        const turn = this.turns.find(t => t.id === (this.msgToTurn.get(perm.messageID) || '')) || this.lastAssistantTurn();
        if (turn) { upsert(turn, block); }
        break;
      }
      case 'permission.asked': {
        if (ev.properties.sessionID !== this.sessionId) { return; }
        this.attachPermission(ev.properties);
        break;
      }
      case 'permission.replied': {
        const p = ev.properties;
        if (p.sessionID !== this.sessionId) { return; }
        const answer = p.reply || p.response || '';
        this.markPermission(p.requestID || p.permissionID || '', answer === 'reject' ? 'rejected' : 'allowed', false);
        break;
      }
      case 'question.asked': {
        if (ev.properties.sessionID !== this.sessionId) { return; }
        this.attachQuestion(ev.properties);
        break;
      }
      case 'question.replied': {
        if (ev.properties.sessionID !== this.sessionId) { return; }
        this.markQuestion(ev.properties.requestID, 'answered', ev.properties.answers, false);
        break;
      }
      case 'question.rejected': {
        if (ev.properties.sessionID !== this.sessionId) { return; }
        this.markQuestion(ev.properties.requestID, 'rejected', undefined, false);
        break;
      }
      case 'session.status': {
        if (ev.properties.sessionID !== this.sessionId) { return; }
        const s = ev.properties.status;
        this.status = s.type === 'busy' ? 'busy' : s.type === 'retry' ? 'retry' : 'idle';
        this.retryMessage = s.type === 'retry' ? s.message : '';
        if (this.status === 'idle') { this.settle(); }
        break;
      }
      case 'session.idle': {
        if (ev.properties.sessionID !== this.sessionId) { return; }
        this.status = 'idle'; this.retryMessage = '';
        this.settle();
        break;
      }
      case 'session.error': {
        if (ev.properties.sessionID && ev.properties.sessionID !== this.sessionId) { return; }
        const turn = this.lastTurn();
        if (turn) { upsert(turn, { type: 'error', id: `err-session-${turn.id}`, message: errorMessage(ev.properties.error) }); }
        this.status = 'idle';
        this.settle();
        break;
      }
      default:
        return;
    }
    this.emit();
  }

  /** The user answered a permission card: show it resolved right away (the replied event confirms). */
  markPermission(permissionId: string, status: 'allowed' | 'rejected', emit = true): void {
    for (const t of this.turns) {
      for (const b of t.blocks) { if (b.type === 'permission' && b.permissionId === permissionId) { b.status = status; } }
    }
    if (emit) { this.emit(); }
  }

  /** A permission ask (live `permission.asked`, or GET /permission after a reload) lands under the tool's turn —
   *  OpenCode waits for the answer, so it must always show somewhere. */
  attachPermission(req: OCPermissionRequest): void {
    const existing = this.turns.flatMap(t => t.blocks).find(b => b.type === 'permission' && b.permissionId === req.id) as PermissionBlock | undefined;
    if (existing) { return; }
    const turnId = req.tool ? this.msgToTurn.get(req.tool.messageID) : undefined;
    const turn = (turnId && this.turns.find(t => t.id === turnId)) || this.lastAssistantTurn() || this.ensureTurn('asst-' + (req.tool?.messageID || req.id), 'assistant', Date.now());
    const command = typeof req.metadata?.command === 'string' ? req.metadata.command as string : undefined;
    const description = typeof req.metadata?.description === 'string' ? (req.metadata.description as string).trim() || undefined : undefined;
    turn.blocks.push({
      type: 'permission', id: `perm-${req.id}`, permissionId: req.id, kind: req.permission, title: permissionTitle(req.permission, req.patterns),
      pattern: req.patterns.join(', '), command, description, status: 'pending',
    });
    this.emit();
  }

  /** A question request (live `question.asked`, or GET /question after a reload) meets its tool part: the block
   *  learns its requestId and the full questions (multiple/custom flags included). No tool part yet → a block of
   *  its own under the message's turn, merged when the part arrives (same callID). */
  attachQuestion(req: OCQuestionRequest): void {
    const callID = req.tool?.callID;
    let block = this.findQuestion(b => (callID && b.callID === callID) || b.requestId === req.id);
    if (!block) {
      const turnId = req.tool ? this.msgToTurn.get(req.tool.messageID) : undefined;
      const turn = (turnId && this.turns.find(t => t.id === turnId)) || this.lastAssistantTurn() || this.ensureTurn('asst-' + (req.tool?.messageID || req.id), 'assistant', Date.now());
      block = { type: 'question', id: `q-${req.id}`, callID, questions: [], status: 'pending' };
      turn.blocks.push(block);
    }
    block.requestId = req.id;
    block.questions = req.questions;
    if (block.status === 'pending' || !block.answers) { block.status = 'pending'; }
    this.emit();
  }

  /** The user answered (optimistic) or OpenCode confirmed (`question.replied` / `.rejected`). */
  markQuestion(requestId: string, status: 'pending' | 'answered' | 'rejected', answers?: string[][], emit = true): void {
    const block = this.findQuestion(b => b.requestId === requestId);
    if (block) { block.status = status; if (answers) { block.answers = answers; } }
    if (emit) { this.emit(); }
  }

  protected findQuestion(pred: (b: QuestionBlock) => boolean): QuestionBlock | undefined {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      for (const b of this.turns[i].blocks) { if (b.type === 'question' && pred(b)) { return b; } }
    }
    return undefined;
  }

  hasPendingQuestion(): boolean {
    return this.turns.some(t => t.blocks.some(b => b.type === 'question' && b.status === 'pending'));
  }

  hasPendingPermission(): boolean {
    return this.turns.some(t => t.blocks.some(b => b.type === 'permission' && b.status === 'pending'));
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** mapPart, except that the text of a compaction summary becomes one CompactionBlock */
  protected blockOf(part: OCPart, role: 'user' | 'assistant', delta?: string): Block | null {
    if (this.summaries.has(part.messageID)) {
      if (part.type !== 'text') { return null; }
      const tp = part as OCTextPart;
      return { type: 'compaction', id: tp.id, text: (tp.text || '') + (delta || ''), streaming: !tp.time?.end };
    }
    return mapPart(part, role, delta);
  }

  protected turnFor(msg: OCMessage): Turn {
    this.roles.set(msg.id, msg.role);
    if (msg.role === 'assistant' && ((msg as OCAssistantMessage).summary === true || (msg as OCAssistantMessage).mode === 'compaction')) { this.summaries.add(msg.id); }
    const turnId = msg.role === 'user' ? msg.id : 'asst-' + ((msg as OCAssistantMessage).parentID || msg.id);
    this.msgToTurn.set(msg.id, turnId);
    const turn = this.ensureTurn(turnId, msg.role, msg.time?.created ?? Date.now());
    if (msg.role === 'assistant') {
      const am = msg as OCAssistantMessage;
      if (am.providerID && am.modelID) { turn.model = `${am.providerID}/${am.modelID}`; this.model = turn.model; }
      if (am.error) { upsert(turn, { type: 'error', id: `err-${msg.id}`, message: errorMessage(am.error) }); }
    }
    return turn;
  }

  protected ensureTurn(id: string, role: 'user' | 'assistant', createdAt: number): Turn {
    let turn = this.turns.find(t => t.id === id);
    if (!turn) { turn = { id, role, blocks: [], createdAt }; this.turns.push(turn); }
    return turn;
  }

  protected lastTurn(): Turn | undefined { return this.turns[this.turns.length - 1]; }
  protected lastAssistantTurn(): Turn | undefined {
    for (let i = this.turns.length - 1; i >= 0; i--) { if (this.turns[i].role === 'assistant') { return this.turns[i]; } }
    return this.lastTurn();
  }

  /** The turn is over: nothing streams any more, the thought is done, and a tool still "running" was interrupted —
   *  OpenCode's server went away mid-call (a pod or editor restart) and never finished the stored part. */
  settle(): void {
    this.endThinking();
    for (const t of this.turns) {
      for (const b of t.blocks) {
        if ((b.type === 'text' || b.type === 'compaction') && b.streaming) { b.streaming = false; }
        if (b.type === 'tool' && (b.status === 'running' || b.status === 'pending')) { b.status = 'error'; b.output = b.output || `Interrupted — ${agentName()} was restarted while this ran.`; }
      }
    }
  }

  protected endThinking(): void {
    if (!this.thinking) { return; }
    const { turnId, since } = this.thinking;
    this.thoughtFor[turnId] = Math.max(1, Math.round((Date.now() - since) / 1000));
    this.thinking = null;
  }
}

// ── part → block mapping (module scope: history and live share it) ───────────

function upsert(turn: Turn, block: Block): void {
  // a question block may already exist under the request's own id (question.asked before the tool part)
  const i = turn.blocks.findIndex(b => b.id === block.id || (block.type === 'question' && b.type === 'question' && !!block.callID && b.callID === block.callID));
  if (i === -1) { turn.blocks.push(block); return; }
  const old = turn.blocks[i];
  if (old.type === 'question' && block.type === 'question') {
    // the tool part knows the status; the request knows the id and the answers
    turn.blocks[i] = { ...block, id: old.id, requestId: block.requestId ?? old.requestId, answers: block.answers ?? old.answers,
      questions: block.questions.length ? block.questions : old.questions, status: block.status === 'pending' && old.status !== 'pending' ? old.status : block.status };
    return;
  }
  turn.blocks[i] = block;
}

export function errorMessage(err: OCError | undefined): string {
  if (!err) { return 'Something went wrong'; }
  if (err.name === 'MessageAbortedError') { return 'Stopped'; }
  if (err.name === 'ProviderAuthError') { return 'The model provider refused the request (authentication)'; }
  if (err.name === 'MessageOutputLengthError') { return 'The reply hit the output length limit'; }
  return String(err.data?.message || err.name || 'Something went wrong');
}

function mapPart(part: OCPart, role: 'user' | 'assistant', delta?: string): Block | null {
  switch (part.type) {
    case 'text': {
      const tp = part as OCTextPart;
      if (tp.synthetic || tp.ignored) { return null; }   // injected context, not something either side typed
      const block: TextBlock = { type: 'text', id: tp.id, text: (tp.text || '') + (delta || ''), streaming: role === 'assistant' && !tp.time?.end };
      return block;
    }
    case 'tool': {
      const tp = part as OCToolPart;
      return tp.tool === 'question' ? mapQuestion(tp) : mapTool(tp);
    }
    case 'permission':
      return mapStoredPermission(part as any);
    case 'file': {
      // an image the user sent (data URL) shows in their turn; other files are context, not shown
      const fp = part as OCPart & { mime?: string; url?: string; filename?: string };
      return /^image\//.test(fp.mime || '') && fp.url ? { type: 'image', id: fp.id, url: fp.url, name: fp.filename || 'image' } : null;
    }
    default:
      return null;   // reasoning (shown live, never a block), step-start/finish, snapshot, patch, agent, retry, compaction, subtask
  }
}

/** A tool part's state; history from other OpenCode versions may lack it or its input — never let that throw. */
const stateOf = (part: OCToolPart): OCToolState => (part.state && typeof part.state === 'object' ? { ...part.state, input: (part.state as any).input || {} } : { status: 'pending', input: {} }) as OCToolState;

function mapTool(part: OCToolPart): ToolBlock {
  const state = stateOf(part);
  const status = state.status === 'pending' ? 'pending' : state.status === 'running' ? 'running' : state.status === 'completed' ? 'completed' : 'error';
  const title = state.status === 'completed' ? state.title : state.status === 'running' ? state.title || part.tool : part.tool;
  const input = state.input && Object.keys(state.input).length ? JSON.stringify(state.input, null, 2) : undefined;
  const output = state.status === 'completed' ? state.output : state.status === 'error' ? state.error : undefined;
  const meta = (state.status !== 'pending' && state.metadata) || {};
  const diff = typeof (meta as any).diff === 'string' ? (meta as any).diff as string : undefined;
  return { type: 'tool', id: part.id, tool: part.tool, title, status, input, output, diff, files: extractFiles(part) };
}

function mapQuestion(part: OCToolPart): QuestionBlock {
  const state = stateOf(part);
  const questions = ((state.input as any)?.questions as QuestionBlock['questions'] | undefined) || [];
  const status = state.status === 'completed' ? 'answered' : state.status === 'error' ? 'rejected' : 'pending';
  return { type: 'question', id: part.id, callID: part.callID, questions, status, ...(state.status === 'completed' ? { note: state.output } : {}) };
}

/** Plain words for what the tool wants (the request itself only names the permission kind). */
export function permissionTitle(kind: string, patterns: string[]): string {
  switch (kind) {
    case 'bash': return 'Run a command';
    case 'edit': case 'write': return patterns.length === 1 ? `Edit ${patterns[0].replace(/^.*\//, '')}` : 'Edit files';
    case 'read': return 'Read a file';
    case 'webfetch': case 'websearch': return 'Fetch something from the web';
    case 'external_directory': return 'Work outside your workspace folder';
    case 'doom_loop': return 'Keep going after repeating itself';
    default: return kind.replace(/[_-]+/g, ' ').replace(/^\w/, c => c.toUpperCase());
  }
}

function permissionBlock(perm: OCPermission): PermissionBlock {
  return {
    type: 'permission', id: `perm-${perm.id}`, permissionId: perm.id, kind: perm.type, title: perm.title,
    pattern: Array.isArray(perm.pattern) ? perm.pattern.join(', ') : perm.pattern, status: 'pending',
  };
}

/** A permission OpenCode stored on the message (already answered). Shapes have shifted between versions: tolerant. */
function mapStoredPermission(raw: { id: string; permission?: { id?: string; type?: string; title?: string; pattern?: string | string[]; response?: string } }): PermissionBlock | null {
  const perm = raw.permission;
  if (!perm) { return null; }
  const response = String(perm.response || '').toLowerCase();
  return {
    type: 'permission', id: `perm-${perm.id || raw.id}`, permissionId: String(perm.id || raw.id), kind: perm.type || '', title: perm.title || '',
    pattern: Array.isArray(perm.pattern) ? perm.pattern.join(', ') : perm.pattern, status: response.startsWith('reject') ? 'rejected' : 'allowed',
  };
}

function extractFiles(part: OCToolPart): string[] {
  const state = stateOf(part);
  if (state.status !== 'pending' && state.metadata) {
    const files = (state.metadata as any).files as string[] | undefined;
    if (Array.isArray(files) && files.length) { return files; }
  }
  const input = (state.input || {}) as Record<string, unknown>;
  for (const key of ['filePath', 'file', 'path']) { if (typeof input[key] === 'string') { return [input[key] as string]; } }
  return [];
}

/** For the widget: an error block it can add itself (a failed request, say). */
export function localError(id: string, message: string): ErrorBlock { return { type: 'error', id, message }; }
