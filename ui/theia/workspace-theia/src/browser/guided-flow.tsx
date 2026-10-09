import React = require('@theia/core/shared/react');

const API = '/workspace-api';

/** Sign-in pages the guided flows may open. `s.url` arrives from the agent over the websocket, so it is checked before it becomes an href. */
const SIGNIN_HOSTS = ['github.com', 'claude.ai', 'claude.com', 'anthropic.com']; // Claude Code 2.1.26x signs in on claude.com
const hostAllowed = (host: string) => SIGNIN_HOSTS.some(h => host === h || host.endsWith('.' + h));
/** Returns a normalised https URL on an allow-listed host, or undefined. */
export function safeUrl(u: string): string | undefined {
  let p: URL;
  try { p = new URL(u); } catch { return undefined; }
  if (p.protocol !== 'https:' || p.username || p.password || !hostAllowed(p.hostname.toLowerCase())) { return undefined; }
  return p.origin + p.pathname + p.search + p.hash;
}
const WS_BASE = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + API + '/term';

export interface Account { key: string; task: string; label: string; done: string; codeEntry?: boolean; hint?: string; desc?: string; }
export const ACCOUNTS: Account[] = [
  { key: 'gh', task: 'gh-login', label: 'GitHub', done: 'GitHub connected', desc: 'So you can save and share your code.' },
  { key: 'claude', task: 'claude-login', label: 'Claude', done: 'Claude connected', codeEntry: true, desc: 'Your AI pair programmer.' },
];

interface Props { key?: string; account: Account; onDone?: (v?: string) => any; onClose?: () => void; }
interface State { stage: string; code: string; url: string; urlBlocked: boolean; msg: string; input: string; detail: string; }

/** One guided sign-in over the agent's hidden-PTY websocket ({t:"code"|"url"|"done"|"exit"|"stuck"|"reset"}). */
const Base: any = React.Component;
export class GuidedFlow extends Base {
  declare props: Props;
  declare state: State;
  declare setState: (s: Partial<State> | ((prev: State) => Partial<State> | null) | null) => void;
  constructor(props: Props) { super(props); this.state = { stage: 'spin', code: '', url: '', urlBlocked: false, msg: '', input: '', detail: '' }; }
  /** Tail of the hidden PTY's output — shown (sanitised) when the sign-in dies, so "didn't finish" has a reason. */
  private tail = '';
  private static readonly ANSI = /\x1b\[[0-9;?>=]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\r\x07]/g;
  private failDetail(): string {
    const lines = this.tail.replace(GuidedFlow.ANSI, '').split('\n').map(l => l.trim()).filter(Boolean);
    const err = [...lines].reverse().find(l => /error|denied|invalid|unauthori[sz]ed|forbidden|failed/i.test(l));
    return err ? err.slice(0, 160) : '';
  }
  private ws?: WebSocket;
  componentDidMount(): void { this.connect(); }
  componentWillUnmount(): void { try { this.ws?.close(); } catch { } }
  private connect(): void {
    try { this.ws?.close(); } catch { }
    const a = this.props.account;
    this.ws = new WebSocket(`${WS_BASE}?task=${a.task}&mode=guided`);
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.t === 'log') { this.tail = (this.tail + m.d).slice(-4000); return; }
      if (m.t === 'code') { this.setState({ code: m.v, stage: 'code' }); }
      if (m.t === 'url') { const url = safeUrl(String(m.v)); this.setState(s => ({ url: url ?? '', urlBlocked: !url, stage: s.stage === 'code' ? 'code' : 'url' })); }
      if (m.t === 'reset') { this.setState({ stage: 'url', input: '', msg: 'That code didn’t work — open the sign-in page again.' }); }
      if (m.t === 'done') { this.setState({ stage: 'done', msg: a.done + (m.v ? ' — ' + m.v : '') }); this.props.onDone?.(m.v); window.dispatchEvent(new CustomEvent('ws:setup-changed')); }
      if (m.t === 'stuck') { this.setState(s => s.stage === 'done' ? null : { msg: 'Taking longer than usual — keep waiting, or try again.' } as any); }
      if (m.t === 'exit') { this.setState(s => s.stage === 'done' ? null : { stage: 'fail', msg: 'That sign-in didn’t finish. Try again.', detail: this.failDetail() } as any); }
    };
  }
  private send(obj: any): void { const raw = JSON.stringify(obj); const ws = this.ws!; ws.readyState === 1 ? ws.send(raw) : ws.addEventListener('open', () => ws.send(raw), { once: true }); }
  private retry(): void { this.tail = ''; this.setState({ stage: 'spin', code: '', url: '', urlBlocked: false, msg: '', input: '', detail: '' }); this.connect(); }
  render(): React.ReactNode {
    const a = this.props.account, s = this.state;
    const url = safeUrl(s.url); // state holds a checked value already; re-check at the point of use
    const blocked = s.urlBlocked && <p className="ws-muted ws-small">Sign-in page blocked — it pointed somewhere unexpected.</p>;
    return <div className="ws-flow">
      {this.props.onClose && <div className="ws-flow-head"><strong>{a.label}</strong><button className="ws-quiet" onClick={this.props.onClose}>Close</button></div>}
      {s.stage === 'spin' && <div className="ws-muted">Getting things ready…</div>}
      {s.stage === 'code' && <div>
        <p className="ws-muted">GitHub will ask for this code:</p>
        <div className="ws-code">{s.code}</div>
        <div><button className="ws-primary" onClick={() => { navigator.clipboard.writeText(s.code); if (url) { window.open(url, '_blank'); } this.setState({ msg: 'Code copied — paste it in the GitHub tab. We’ll wait here.' }); }}>Copy code &amp; open GitHub →</button></div>
        {blocked}
      </div>}
      {s.stage === 'url' && <div>
        <p className="ws-muted">Continue the sign-in in your browser:</p>
        {url ? <a className="ws-primary" href={url} target="_blank" rel="noreferrer" onClick={() => { if (a.codeEntry) { this.setState({ stage: 'enter' }); } }}>Open sign-in page →</a> : blocked}
      </div>}
      {s.stage === 'enter' && <form className="ws-form" onSubmit={e => { e.preventDefault(); if (!s.input.trim()) { return; } this.send({ t: 'creds', v: { code: s.input.trim() } }); this.setState({ stage: 'spin' }); }}>
        {a.hint && <p className="ws-muted">{a.hint}</p>}
        <input placeholder={a.hint ? 'Paste the address here' : 'Paste your code'} value={s.input} onChange={e => this.setState({ input: e.target.value })} />
        <button className="ws-primary" type="submit">Done</button>
        {url && <a className="ws-mini" href={url} target="_blank" rel="noreferrer">Reopen the sign-in page</a>}
      </form>}
      {s.stage === 'done' && <div className="ws-done">✓ {s.msg}</div>}
      {s.stage === 'fail' && <div><div className="ws-fail">{s.msg}</div>{s.detail && <p className="ws-muted ws-small ws-detail">{s.detail}</p>}<button className="ws-primary" onClick={() => this.retry()}>Try again</button></div>}
      {s.msg && !['done', 'fail'].includes(s.stage) && <p className="ws-muted ws-small">{s.msg}</p>}
    </div>;
  }
}
