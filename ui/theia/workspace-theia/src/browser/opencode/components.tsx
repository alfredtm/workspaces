import React = require('@theia/core/shared/react');
import MarkdownIt = require('markdown-it');
import DOMPurify = require('dompurify');
import { Attachment, Block, CompactionBlock, ErrorBlock, ImageBlock, PermissionBlock, QuestionBlock, TextBlock, Thinking, ToolBlock, Turn } from './types';
import { agentName } from '../assistant';

/**
 * The card's safety net. React unmounts the whole tree when a render throws, which left users with an empty dark
 * card and no way out (seen in two pods, 2026-10). A throw anywhere below — an unexpected part in a saved
 * conversation, say — now shows what happened and two ways forward; `onError` logs it where we can read it.
 */
interface CardBoundaryProps { onError: (e: Error, stack: string) => void; fallback: (e: Error) => React.ReactNode; children?: React.ReactNode }
export class CardBoundary extends React.Component<CardBoundaryProps, { error?: Error }> {
  declare readonly props: Readonly<CardBoundaryProps>;
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error): { error: Error } { return { error }; }
  componentDidCatch(error: Error, info: { componentStack?: string | null }): void { this.props.onError(error, info.componentStack || ''); }
  render(): React.ReactNode { return this.state.error ? this.props.fallback(this.state.error) : this.props.children; }
}

/**
 * The chat's building blocks — turns, the activity card, tool rows, permission/question cards and the composer —
 * on the editor's own CSS variables (style/opencode.css). OpenCode works on the user's files.
 *
 * `markdown-it` and `dompurify` come with @theia/core (its MarkdownRenderer uses them), so the bundle already has
 * them; the assistant's markdown is rendered and sanitised before it touches the DOM.
 */
const { useState, useEffect, useRef } = React;
/** Theia's bundled React typings do not fold `key` into function-component props: accept it explicitly. */
type Keyed = { key?: React.Key };

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
// links open in a new tab: the editor is the app, navigating it away would lose the session view
const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank'); tokens[idx].attrSet('rel', 'noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};
/**
 * Rendered markdown by source text. The widget re-renders the whole chat on every keystroke in the composer and
 * on every stream event; without this, each one re-parsed and re-sanitised every message, so typing lagged more
 * the longer the conversation got. A streaming reply misses the cache on each delta (new text), finished ones
 * hit it. The same string back also lets React skip the innerHTML write. Map order = insertion, so the oldest
 * entry goes first once the cap is reached; a hit re-inserts to keep hot entries.
 */
const MD_CACHE_MAX = 500;
const mdCache = new Map<string, string>();
export function renderMarkdown(text: string): string {
  const src = text || '';
  const hit = mdCache.get(src);
  if (hit !== undefined) { mdCache.delete(src); mdCache.set(src, hit); return hit; }
  const html = DOMPurify.sanitize(md.render(src), { ADD_ATTR: ['target'] });
  mdCache.set(src, html);
  if (mdCache.size > MD_CACHE_MAX) { mdCache.delete(mdCache.keys().next().value!); }
  return html;
}

// ── tool vocabulary ────────────────────────────────────────────────────────
//
// A row reads like the Claude extension's: **Read** server.js · **Bash** Install npm dependencies · **Edit** app.py.
// The name is the tool, the subject is what it worked on (a path, the model's own description of a command,
// a search pattern, a URL).

export type IconKind = 'edit' | 'view' | 'run' | 'other';
export function iconKind(tool: string): IconKind {
  if (['edit', 'write', 'apply_patch', 'multiedit'].includes(tool)) { return 'edit'; }
  if (['read', 'glob', 'grep', 'list', 'ls'].includes(tool)) { return 'view'; }
  if (tool === 'bash') { return 'run'; }
  return 'other';
}
const TOOL_LABELS: Record<string, string> = {
  read: 'Read', bash: 'Bash', edit: 'Edit', multiedit: 'Edit', write: 'Write', apply_patch: 'Patch', glob: 'Glob', grep: 'Grep', list: 'List', ls: 'List',
  webfetch: 'Fetch', websearch: 'Search', todowrite: 'Plan', todoread: 'Plan', task: 'Task', question: 'Question', skill: 'Skill',
};
export function toolLabel(tool: string): string { return TOOL_LABELS[tool] || tool.replace(/[_-]+/g, ' ').replace(/^\w/, c => c.toUpperCase()); }
function inputOf(block: ToolBlock): Record<string, unknown> { try { return block.input ? JSON.parse(block.input) : {}; } catch { return {}; } }
/** The shell command inside a bash tool's JSON input. */
export function bashCommand(input: string | undefined, firstLine = true): string {
  if (!input) { return ''; }
  try { const p = JSON.parse(input) as { command?: unknown }; if (typeof p.command === 'string') { return firstLine ? p.command.split('\n', 1)[0] : p.command; } } catch { /* partial */ }
  return '';
}
/** A path as the user knows it: relative to the workspace folder, or just the file name. */
export function relPath(p: string, dir: string): string {
  const d = (dir || '').replace(/\/+$/, '');
  if (d && p.startsWith(d + '/')) { return p.slice(d.length + 1); }
  return p.replace(/^.*\//, '');
}
/** "Install packages", "Start something in the background", "Look around the files"… from the first command of a
 *  chain; empty when nothing sensible can be said (the IN block shows the command anyway). */
export function runLabel(cmd: string): string {
  const s = cmd.trim().replace(/^cd\s+\S+\s*(&&|;)\s*/, '');
  const first = (s.split(/\s*(?:&&|\|\||;|\|)\s*/)[0] || s).replace(/^(nohup|sudo|runuser\s+-u\s+\S+\s+--|env(\s+\w+=\S+)*|time)\s+/, '');
  const w = first.split(/\s+/); const cmd0 = w[0] || ''; const sub = w[1] || '';
  if (/^(npm|pnpm|yarn|bun)$/.test(cmd0)) {
    if (/^(install|i|add|ci)$/.test(sub)) { return 'Install packages'; }
    if (/^(run|start|test|build|dev)$/.test(sub)) { return sub === 'run' ? `Run ${w[2] || 'a script'}` : sub === 'start' || sub === 'dev' ? 'Start the app' : sub === 'test' ? 'Run the tests' : 'Build'; }
    return 'Check packages';
  }
  if (/^(npx|node|python3?|go|bun|deno)$/.test(cmd0)) { return /(^|\/)(start|server|app|main|index)\.(js|mjs|ts|py)$/.test(sub) || /^run$/.test(sub) ? 'Start the app' : `Run ${cmd0}`; }
  if (/^(ls|cat|head|tail|find|tree|pwd|wc|file|stat|du|df)$/.test(cmd0)) { return 'Look around the files'; }
  if (/^(grep|rg|ag)$/.test(cmd0)) { return 'Search the files'; }
  if (/^(mkdir|touch|cp|mv|rm|chmod|chown|ln)$/.test(cmd0)) { return 'Tidy up files'; }
  if (/^(curl|wget|http)$/.test(cmd0)) { return 'Check a URL'; }
  if (/^(kill|pkill|killall|fuser)$/.test(cmd0)) { return 'Stop a process'; }
  if (/^(ps|lsof|ss|netstat|top|pgrep|which|command|type|echo|printf|env|export|uname|whoami|id|date)$/.test(cmd0)) { return 'Check the machine'; }
  if (/^(git)$/.test(cmd0)) { return `git ${sub}`.trim(); }
  if (/^(pg_isready|psql|pg_ctl|initdb|createdb|redis-cli|mysql|sqlite3)$/.test(cmd0)) { return 'Check the database'; }
  if (/^(apt|apt-get|brew|pip3?|pipx|gem|cargo|go)$/.test(cmd0)) { return 'Install something'; }
  if (/^(make|cmake|tsc|vite|webpack|esbuild|docker)$/.test(cmd0)) { return `Run ${cmd0}`; }
  if (/^(sleep|true|test|\[)$/.test(cmd0)) { return 'Wait a moment'; }
  return cmd0 ? `Run ${cmd0}` : '';
}
export function toolSubject(block: ToolBlock, dir: string): { text: string; mono: boolean } {
  const inp = inputOf(block); const t = block.tool; const kind = iconKind(t);
  const titled = block.title && block.title !== t ? block.title : '';
  const file = block.files?.[0];
  if (kind === 'edit' || t === 'read') { return { text: file ? relPath(file, dir) : titled, mono: true }; }
  if (t === 'bash') {
    // the model's own description when it gives one (Claude's tool requires it, OpenCode's does not); otherwise a
    // short label for what the command does — the command itself is in the IN block right below
    const desc = typeof inp.description === 'string' ? inp.description.trim() : '';
    return { text: desc || runLabel(bashCommand(block.input)), mono: false };
  }
  if (t === 'glob' || t === 'grep') { return { text: String(inp.pattern || titled || ''), mono: true }; }
  if (t === 'list' || t === 'ls') { return { text: typeof inp.path === 'string' ? relPath(inp.path, dir) || '.' : titled, mono: true }; }
  if (t === 'webfetch') { return { text: String(inp.url || titled || ''), mono: true }; }
  if (t === 'task') { return { text: String(inp.description || titled || ''), mono: false }; }
  if (t === 'todowrite' || t === 'todoread') { return { text: 'Updated the plan', mono: false }; }
  if (t === 'skill') { return { text: String(inp.name || titled || ''), mono: false }; }
  return { text: titled, mono: false };
}

// ── atoms ──────────────────────────────────────────────────────────────────

const svg = { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

/** The dot every row starts with: green = done, orange (breathing) = running, red = failed, grey = prose. */
export function Dot({ state }: { state: 'done' | 'run' | 'err' | 'text' }) {
  return <span className={`oc-dot oc-dot--${state}`} aria-hidden="true" />;
}
function dotFor(status: ToolBlock['status']): 'done' | 'run' | 'err' {
  return status === 'completed' ? 'done' : status === 'error' ? 'err' : 'run';
}

function Chevron({ open }: { open: boolean }) {
  return <svg className={`oc-chev ${open ? 'is-open' : ''}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>;
}

// ── blocks ─────────────────────────────────────────────────────────────────

export function UserBox({ block }: { block: TextBlock } & Keyed) {
  return <div className="oc-user">{block.text}</div>;
}

export function TextRow({ block }: { block: TextBlock } & Keyed) {
  if (!block.text.trim()) { return null; }
  return (
    <div className="oc-row">
      <Dot state="text" />
      <div className={`oc-row-body oc-bubble ${block.streaming ? 'is-streaming' : ''}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }} />
    </div>
  );
}

/** Memoised on the diff string: every edit's diff is in the DOM even while collapsed (the collapse is CSS), and
 *  the chat re-renders on each keystroke — without memo every diff line of the whole chat re-rendered with it. */
const DiffView = React.memo(function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n'); if (lines[lines.length - 1] === '') { lines.pop(); }
  return (
    <pre className="oc-tool-detail oc-diff">
      {lines.map((line, i) => {
        if (line.startsWith('+++') || line.startsWith('---')) { return null; }
        const cls = line.startsWith('@@') ? 'oc-diff-line oc-diff-line--hunk' : line.startsWith('+') ? 'oc-diff-line oc-diff-line--add' : line.startsWith('-') ? 'oc-diff-line oc-diff-line--del' : 'oc-diff-line';
        return <span key={i} className={cls}>{line}</span>;
      })}
    </pre>
  );
});

const OUT_LINES = 6;

/** One tool call as a row. Bash shows its command and output inline (the output clipped to a few lines, click for
 *  all of it); edits open their diff on click; reads and searches open their output on click. */
export function ToolLine({ block, dir }: { block: ToolBlock; dir: string } & Keyed) {
  const [open, setOpen] = useState(false);
  const isBash = block.tool === 'bash';
  const { text, mono } = toolSubject(block, dir);
  const command = isBash ? bashCommand(block.input, false) : '';
  const out = block.output || '';
  const clipped = out.split('\n').length > OUT_LINES || out.length > 600;
  const hasDetail = !isBash && Boolean(block.output || block.diff);
  return (
    <div className="oc-row oc-row--tool">
      <Dot state={dotFor(block.status)} />
      <div className="oc-row-body">
        <button className={`oc-tool-head ${hasDetail ? 'is-clickable' : ''}`} onClick={() => hasDetail && setOpen(o => !o)} disabled={!hasDetail}>
          <span className="oc-tool-name">{toolLabel(block.tool)}</span>
          {text && <span className={`oc-tool-subject ${mono ? 'is-mono' : ''}`}>{text}</span>}
          {hasDetail && <Chevron open={open} />}
        </button>
        {isBash && command && (
          <div className={`oc-io ${open ? 'is-open' : ''}`} onClick={() => setOpen(o => !o)} title={open ? 'Show less' : clipped ? 'Show everything' : undefined}>
            <div className="oc-io-line"><span className="oc-io-tag">IN</span><pre className="oc-io-pre">{command}</pre></div>
            {(out || block.status === 'error') && (
              <div className="oc-io-line"><span className="oc-io-tag">OUT</span><pre className={`oc-io-pre ${clipped && !open ? 'is-clipped' : ''}`}>{out || 'failed'}</pre></div>
            )}
          </div>
        )}
        {!isBash && hasDetail && (
          <div className={`oc-collapse ${open ? 'is-open' : ''}`}>
            <div className="oc-collapse-inner">{block.diff ? <DiffView diff={block.diff} /> : <pre className="oc-tool-detail">{block.output}</pre>}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export type PermissionResponse = 'once' | 'always' | 'reject';

/** "Allow this bash command?" — the question the card asks, per permission kind. */
function permissionQuestion(block: PermissionBlock): string {
  switch (block.kind) {
    case 'bash': return 'Allow this bash command?';
    case 'edit': case 'write': return block.pattern && !block.pattern.includes(',') ? `Allow this edit to ${block.pattern.replace(/^.*\//, '')}?` : 'Allow these edits?';
    case 'read': return 'Allow reading this file?';
    case 'webfetch': case 'websearch': return 'Allow this web request?';
    case 'external_directory': return 'Allow working outside your workspace folder?';
    default: return `Allow this? (${block.title})`;
  }
}

/**
 * A permission ask, shaped like the Claude Code extension's: the question, the command, the model's own
 * description, then numbered options — 1 Yes, 2 Yes and remember the pattern for this project, 3 No — and a
 * box to say what to do instead (sent to the model with the rejection). Keys 1/2/3 pick, Enter in the box
 * sends the text (or Yes when empty), Esc says No. Only the newest pending card listens to the keyboard.
 */
export function PermissionCard({ block, onRespond, live }: { block: PermissionBlock; onRespond: (id: string, response: PermissionResponse, message?: string) => void; live?: boolean } & Keyed) {
  const resolved = block.status !== 'pending';
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const patterns = block.pattern ? block.pattern.split(', ').filter(Boolean) : [];
  const respond = (r: PermissionResponse, message?: string) => { if (!resolved) { onRespond(block.permissionId, r, message); } };
  const instead = () => { const t = text.trim(); if (t) { respond('reject', t); } else { respond('once'); } };
  useEffect(() => {
    if (resolved || !live) { return; }
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const inOwnBox = el === input.current;
      const inOtherField = !inOwnBox && !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === 'Escape') { e.preventDefault(); respond('reject'); return; }
      if (inOtherField || (inOwnBox && text.trim())) { return; }
      if (e.key === '1') { e.preventDefault(); respond('once'); }
      else if (e.key === '2' && patterns.length) { e.preventDefault(); respond('always'); }
      else if (e.key === '3') { e.preventDefault(); respond('reject'); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [resolved, live, text, patterns.length]);
  return (
    <div className={`oc-perm ${resolved ? 'is-resolved' : ''}`}>
      <div className="oc-perm-question">{permissionQuestion(block)}</div>
      {(block.command || block.pattern) && <pre className="oc-perm-cmd">{block.command || block.pattern}</pre>}
      {block.description && <div className="oc-perm-desc">{block.description}</div>}
      {resolved
        ? <div className={`oc-perm-resolved is-${block.status}`}>{block.status === 'allowed' ? 'Allowed' : 'Declined'}</div>
        : <>
            <div className="oc-perm-options" role="listbox">
              <button className="oc-perm-option is-primary" role="option" onClick={() => respond('once')}><span className="oc-perm-num">1</span>Yes</button>
              {patterns.length > 0 && (
                <button className="oc-perm-option" role="option" onClick={() => respond('always')}>
                  <span className="oc-perm-num">2</span><span>Yes, allow {patterns.map((p, i) => <React.Fragment key={p}>{i > 0 && (i === patterns.length - 1 ? ' and ' : ', ')}<code>{p}</code></React.Fragment>)} for this project <span className="oc-perm-dim">(just you)</span></span>
                </button>
              )}
              <button className="oc-perm-option" role="option" onClick={() => respond('reject')}><span className="oc-perm-num">{patterns.length ? 3 : 2}</span>No</button>
            </div>
            <input ref={input} className="oc-perm-instead" value={text} placeholder={`Tell ${agentName()} what to do instead`} onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) { e.preventDefault(); instead(); } }} />
            <div className="oc-perm-foot">Esc to cancel</div>
          </>}
    </div>
  );
}

/** The `question` tool's card: every question in the request, options to pick (one, several, or a typed answer),
 *  sent together through OpenCode's question API. A lone single-choice question sends on click. */
export function QuestionCard({ block, onAnswer, onReject }: { block: QuestionBlock; onAnswer: (block: QuestionBlock, answers: string[][]) => void; onReject: (block: QuestionBlock) => void } & Keyed) {
  const [sel, setSel] = useState<string[][]>(() => block.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => block.questions.map(() => ''));
  useEffect(() => { if (sel.length !== block.questions.length) { setSel(block.questions.map(() => [])); setCustom(block.questions.map(() => '')); } }, [block.questions.length]);
  const pending = block.status === 'pending';
  if (block.questions.length === 0) {
    return pending
      ? <div className="oc-question is-loading"><span className="oc-spinner" /><span className="oc-shimmer">{agentName()} has a question…</span></div>
      : null;
  }
  const single = block.questions.length === 1 && !block.questions[0].multiple && !block.questions[0].custom;
  const chosen = (i: number) => block.answers?.[i] ?? sel[i] ?? [];
  const pick = (i: number, label: string) => {
    if (!pending) { return; }
    if (single) { onAnswer(block, [[label]]); return; }
    setSel(prev => prev.map((s, j) => j !== i ? s : block.questions[i].multiple ? (s.includes(label) ? s.filter(x => x !== label) : [...s, label]) : [label]));
  };
  const complete = block.questions.every((_, i) => (sel[i] || []).length > 0 || (custom[i] || '').trim().length > 0);
  const submit = () => onAnswer(block, block.questions.map((_, i) => { const c = (custom[i] || '').trim(); return c ? [...(sel[i] || []), c] : (sel[i] || []); }));
  return (
    <div className={`oc-question ${pending ? '' : 'is-resolved'}`}>
      {block.questions.map((q, i) => (
        <div key={i} className="oc-question-one">
          {q.header && <div className="oc-question-eyebrow">{q.header}</div>}
          <div className="oc-question-text">{q.question}</div>
          <div className="oc-question-options">
            {q.options.map((opt, j) => {
              const picked = chosen(i).includes(opt.label); const dim = !pending && !picked;
              return (
                <button key={opt.label} className={`oc-question-option ${picked ? 'is-picked' : ''} ${dim ? 'is-dim' : ''}`} style={{ '--i': j } as React.CSSProperties}
                  onClick={() => pick(i, opt.label)} disabled={!pending}>
                  <span className="oc-question-label">{opt.label}</span>
                  {opt.description && <span className="oc-question-desc">{opt.description}</span>}
                  {picked && <svg className="oc-question-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}
                </button>
              );
            })}
            {q.custom && pending && (
              <input className="oc-question-custom" placeholder="Or type your own answer…" value={custom[i] || ''}
                onChange={e => { const v = e.target.value; setCustom(prev => prev.map((c, j) => j === i ? v : c)); }}
                onKeyDown={e => { if (e.key === 'Enter' && complete) { e.preventDefault(); submit(); } }} />
            )}
            {q.custom && !pending && (block.answers?.[i] || []).filter(a => !q.options.some(o => o.label === a)).map(a => (
              <div key={a} className="oc-question-option is-picked"><span className="oc-question-label">{a}</span></div>
            ))}
          </div>
        </div>
      ))}
      {pending && !single && (
        <div className="oc-question-foot">
          <button className="oc-btn oc-btn--primary" disabled={!complete} onClick={submit}>{block.questions.length > 1 ? 'Send answers' : 'Send answer'}</button>
          <button className="oc-btn oc-btn--text" onClick={() => onReject(block)}>Skip</button>
        </div>
      )}
      {pending && single && <div className="oc-question-foot"><button className="oc-btn oc-btn--text" onClick={() => onReject(block)}>Skip</button></div>}
      {block.status === 'rejected' && <div className="oc-question-resolved">Skipped</div>}
    </div>
  );
}

export function ErrorRow({ block }: { block: ErrorBlock } & Keyed) {
  const soft = block.message === 'Stopped';
  return <div className="oc-row"><Dot state={soft ? 'text' : 'err'} /><div className={`oc-row-body oc-error-text ${soft ? 'is-soft' : ''}`}>{block.message}</div></div>;
}

/** The live thought: "Thinking…" with the tail of the reasoning under it, so a long think never looks like a hang. */
export function ThinkingRow({ thinking }: { thinking: Thinking }) {
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { const el = bodyRef.current; if (el) { el.scrollTop = el.scrollHeight; } }, [thinking.tail, open]);
  const seconds = Math.max(0, Math.round((Date.now() - thinking.since) / 1000));
  const text = (thinking.tail || '').trim();
  return (
    <div className="oc-row">
      <Dot state="run" />
      <div className="oc-row-body">
        {/* calm by default: a timer only; the thinking itself is a click away (it used to stream as a faded tail) */}
        <button className={`oc-think-head ${text ? 'is-clickable' : ''}`} onClick={() => text && setOpen(o => !o)} disabled={!text} title={text ? (open ? 'Hide the thinking' : 'Peek at the thinking') : undefined}>
          <span className="oc-shimmer">{`Thinking… ${seconds}s`}</span>
          {text && <Chevron open={open} />}
        </button>
        {text && open && <div className="oc-think-body is-open" ref={bodyRef}><p className="oc-think-text">{text}</p></div>}
      </div>
    </div>
  );
}

/** A compaction: "Compacting the conversation…" while the summary is written, then one quiet line with the summary
 *  a click away (it used to land in the chat as a long reply full of "(none)"). */
export function CompactionRow({ block }: { block: CompactionBlock } & Keyed) {
  const [open, setOpen] = useState(false);
  if (block.streaming) {
    return <div className="oc-row"><Dot state="run" /><div className="oc-row-body"><span className="oc-shimmer">Compacting the conversation…</span></div></div>;
  }
  return (
    <div className="oc-row">
      <Dot state="text" />
      <div className="oc-row-body">
        <button className="oc-think-head is-clickable" onClick={() => setOpen(o => !o)} title={open ? 'Hide the summary' : 'What it kept'}>
          <span className="oc-muted">Conversation compacted — older messages are summarised to free up room</span>
          <Chevron open={open} />
        </button>
        {open && <div className="oc-row-body oc-bubble oc-compaction-summary" dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }} />}
      </div>
    </div>
  );
}

export function ThoughtRow({ seconds }: { seconds: number }) {
  return <div className="oc-row"><Dot state="text" /><div className="oc-row-body oc-muted">Thought for {seconds}s</div></div>;
}

// ── a turn ─────────────────────────────────────────────────────────────────

export interface TurnViewProps {
  key?: React.Key;
  turn: Turn;
  /** the workspace folder, to show paths the user recognises */
  dir: string;
  thinking: Thinking | null;
  thoughtFor?: number;
  onPermission: (id: string, response: PermissionResponse, message?: string) => void;
  onAnswer: (block: QuestionBlock, answers: string[][]) => void;
  onReject: (block: QuestionBlock) => void;
}

/** A user turn is its box; an assistant turn is a flat list of rows — tools, prose, questions, asks — in order. */
export function TurnView({ turn, dir, thinking, thoughtFor, onPermission, onAnswer, onReject }: TurnViewProps) {
  const live = thinking && thinking.turnId === turn.id ? thinking : null;
  // only the newest open ask takes the keyboard (1/2/3, Esc) — OpenCode asks one thing at a time anyway
  const lastPendingPermission = [...turn.blocks].reverse().find(b => b.type === 'permission' && b.status === 'pending');
  if (turn.role === 'user') {
    const images = turn.blocks.filter((b): b is ImageBlock => b.type === 'image');
    // OpenCode's /compact request is a user message with no text: nothing to show
    if (!images.length && !turn.blocks.some(b => b.type === 'text' && b.text.trim())) { return null; }
    return (
      <div className="oc-turn oc-turn--user">
        {turn.blocks.map(b => b.type === 'text' && b.text.trim() ? <UserBox key={b.id} block={b} /> : null)}
        {images.length > 0 && <div className="oc-user-images">{images.map(b => <a key={b.id} href={b.url} target="_blank" rel="noreferrer" title={b.name}><img src={b.url} alt={b.name} /></a>)}</div>}
      </div>
    );
  }
  return (
    <div className="oc-turn oc-turn--assistant">
      {thoughtFor !== undefined && !live && <ThoughtRow seconds={thoughtFor} />}
      {turn.blocks.map(b => {
        switch (b.type) {
          case 'text': return <TextRow key={b.id} block={b} />;
          case 'tool': return <ToolLine key={b.id} block={b} dir={dir} />;
          case 'question': return <div key={b.id} className="oc-row"><Dot state={b.status === 'pending' ? 'run' : 'done'} /><div className="oc-row-body"><QuestionCard block={b} onAnswer={onAnswer} onReject={onReject} /></div></div>;
          case 'permission': return <div key={b.id} className="oc-row"><Dot state={b.status === 'pending' ? 'run' : b.status === 'allowed' ? 'done' : 'text'} /><div className="oc-row-body"><PermissionCard block={b} onRespond={onPermission} live={b === lastPendingPermission} /></div></div>;
          case 'error': return <ErrorRow key={b.id} block={b} />;
          case 'compaction': return <CompactionRow key={b.id} block={b} />;
          default: return null;
        }
      })}
      {live && <ThinkingRow thinking={live} />}
    </div>
  );
}

// ── the busy hint ──────────────────────────────────────────────────────────

/** What the card says while OpenCode works: a turning asterisk and a word that changes now and then. */
const BUSY_WORDS = [
  'Thinking', 'Pondering', 'Puzzling', 'Wrangling', 'Cogitating', 'Musing', 'Noodling', 'Brewing', 'Simmering', 'Percolating',
  'Tinkering', 'Scheming', 'Conjuring', 'Crafting', 'Ruminating', 'Mulling', 'Marinating', 'Combobulating', 'Whirring', 'Hatching',
  'Untangling', 'Sketching', 'Assembling', 'Deliberating', 'Considering', 'Weaving', 'Plotting', 'Composing',
];
function pickWord(not?: string): string {
  let w = BUSY_WORDS[Math.floor(Math.random() * BUSY_WORDS.length)];
  if (w === not) { w = BUSY_WORDS[(BUSY_WORDS.indexOf(w) + 1) % BUSY_WORDS.length]; }
  return w;
}
export function BusyHint() {
  const [word, setWord] = useState(() => pickWord());
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const next = () => { t = setTimeout(() => { setWord(w => pickWord(w)); next(); }, 4000 + Math.random() * 4000); };
    next();
    return () => clearTimeout(t);
  }, []);
  return <span className="oc-composer-hint oc-busy"><span className="oc-busy-glyph" aria-hidden="true">✻</span><span key={word} className="oc-busy-word">{word}…</span></span>;
}

// ── the composer ───────────────────────────────────────────────────────────

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onAbort: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** what sits at the left of the bottom row (the / button, the model pill) */
  leading?: React.ReactNode;
  /** the slash-command list, shown above the input while the text starts with "/" */
  palette?: React.ReactNode;
  /** Up/Down/Tab/Escape while the palette is open; return true to swallow the key */
  onSpecialKey?: (key: string) => boolean;
  onEnter?: () => boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement>;
  /** images waiting to go with the next message (pasted, dropped or picked) */
  attachments?: Attachment[];
  /** files the user pasted, dropped or picked; the widget keeps the images */
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  /** the chosen model takes images; otherwise `attachHint` says which one does */
  canAttach?: boolean;
  attachHint?: string;
}

export function Composer({ value, onChange, onSubmit, onAbort, busy, disabled, placeholder, leading, palette, onSpecialKey, inputRef, attachments = [], onAttach, onRemoveAttachment, canAttach, attachHint }: ComposerProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const imagesOf = (list: FileList | null | undefined) => Array.from(list || []).filter(f => /^image\//.test(f.type));
  const onPaste = (e: React.ClipboardEvent) => { const files = imagesOf(e.clipboardData?.files); if (files.length && onAttach) { e.preventDefault(); onAttach(files); } };
  const onDrop = (e: React.DragEvent) => { setDragging(false); const files = imagesOf(e.dataTransfer?.files); if (files.length && onAttach) { e.preventDefault(); onAttach(files); } };
  const [focused, setFocused] = useState(false);
  const [aborting, setAborting] = useState(false);
  // The draft lives in React state here, not only in the widget. The widget's
  // `update()` renders on a later tick, and a controlled textarea whose value
  // does not change synchronously in its own change event is snapped back to
  // the old value by React and rewritten by that late render — which drops the
  // caret at the end after every keystroke made mid-sentence. Local state
  // keeps the caret; `reported` tells a widget-side write (submit clears,
  // palette completion, "/" button) apart from an echo of our own change.
  const [draft, setDraft] = useState(value);
  const reported = useRef(value);
  useEffect(() => { if (value !== reported.current) { reported.current = value; setDraft(value); } }, [value]);
  const change = (v: string) => { reported.current = v; setDraft(v); onChange(v); };
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef || own;
  const ready = draft.trim().length > 0 || attachments.length > 0;
  useEffect(() => { if (!busy) { setAborting(false); } }, [busy]);
  useEffect(() => { const el = ref.current; if (!el) { return; } el.style.height = '0px'; el.style.height = Math.min(el.scrollHeight, 180) + 'px'; }, [draft]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (onSpecialKey && ['ArrowUp', 'ArrowDown', 'Tab', 'Escape'].includes(e.key) && onSpecialKey(e.key)) { e.preventDefault(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) { e.preventDefault(); onSubmit(); }
  };
  return (
    <div className={`oc-composer ${focused ? 'is-focused' : ''} ${busy ? 'is-busy' : ''} ${disabled ? 'is-disabled' : ''} ${dragging ? 'is-dragging' : ''}`}
      onDragOver={e => { if (onAttach && Array.from(e.dataTransfer?.items || [] as ArrayLike<DataTransferItem>).some((i: DataTransferItem) => i.kind === 'file')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      {palette}
      {attachments.length > 0 && (
        <div className="oc-attachments">
          {attachments.map(a => (
            <div key={a.id} className="oc-attachment" title={a.name}>
              <img src={a.url} alt={a.name} />
              <button className="oc-attachment-x" title="Remove" onClick={() => onRemoveAttachment?.(a.id)}>×</button>
            </div>
          ))}
          {!canAttach && <div className="oc-attach-hint">{attachHint}</div>}
        </div>
      )}
      <textarea ref={ref} className="oc-input" rows={1} value={draft} disabled={disabled}
        placeholder={placeholder || (busy ? `Add a follow-up while ${agentName()} works…` : `Ask ${agentName()} to change something…`)}
        onChange={e => change(e.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
      <div className="oc-composer-bar">
        <div className="oc-composer-lead">
          {leading}
        </div>
        <div className="oc-composer-actions">
          {onAttach && (
            <>
              <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={e => { const files = imagesOf(e.target.files); if (files.length) { onAttach(files); } e.target.value = ''; }} />
              <button className={`oc-iconbtn oc-iconbtn--attach ${canAttach ? '' : 'is-off'}`} onClick={() => fileInput.current?.click()}
                title={canAttach ? 'Add an image (or paste / drop one)' : attachHint}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="m21 16-5-5-8 8" /></svg>
              </button>
            </>
          )}
          {busy && (
            <button className={`oc-iconbtn oc-iconbtn--stop ${aborting ? 'is-aborting' : ''}`} onClick={() => { onAbort(); setAborting(true); }} disabled={aborting} title={aborting ? 'Stopping…' : 'Stop'}>
              {aborting ? <span className="oc-spinner oc-spinner--light" /> : <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="3" /></svg>}
            </button>
          )}
          <button className={`oc-iconbtn oc-iconbtn--send ${ready ? 'is-ready' : ''}`} onClick={onSubmit} disabled={!ready || disabled} title={busy ? 'Queue message' : 'Send'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}
