import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import React = require('@theia/core/shared/react');
import ReactDOM = require('@theia/core/shared/react-dom');
import { TerminalModal } from './terminal-modal';
import { PreferenceService, PreferenceScope } from '@theia/core/lib/common/preferences';

/** Theme ids from plugins/workspaces-theme (package.json "workbench.colorTheme" defaults to workspaces-dark). */
const THEMES: { label: string; theme: string }[] = [{ label: 'Light', theme: 'workspaces-light' }, { label: 'Dark', theme: 'workspaces-dark' }, { label: 'Navy', theme: 'workspaces-navy' }];
import { ACCOUNTS, Account, GuidedFlow } from './guided-flow';
import { ASSISTANTS, ASSISTANT_PREF, Assistant, asAssistant, assistantInfo } from './assistant';

// Theia's shared react-dom re-exports react-dom at runtime, but its typing (export * without @types/react-dom) is empty.
const createPortal: (node: React.ReactNode, container: Element) => React.ReactNode = (ReactDOM as any).createPortal;

export const SETTINGS_WIDGET_ID = 'workspace-footer-settings';
const API = '/workspace-api';

type Modal = { kind: 'flow'; account: Account } | { kind: 'env' };

/**
 * Bottom of the sidebar (shell parity): the "Settings ▾" button which expands an inline menu — accounts, Secrets &
 * variables, plain terminal. Picking an item opens a centred modal (portalled
 * onto body: inside the side panel a mousedown raises Theia's drag overlay,
 * which swallows clicks). Sign-ins ride the agent's hidden-PTY websocket.
 */
@injectable()
export class SettingsWidget extends ReactWidget {
  @inject(TerminalModal) protected readonly terminal: TerminalModal;
  @inject(PreferenceService) protected readonly prefs: PreferenceService;
  protected setup: Record<string, { ok: boolean; user?: string }> = {};
  protected open = false;
  protected modal: Modal | null = null;

  @postConstruct()
  protected init(): void {
    this.id = SETTINGS_WIDGET_ID;
    this.title.label = 'Settings';
    this.addClass('workspace-settings');
    this.refresh();
    this.update();
    // Keep "n/4 connected" honest: sign-ins can complete outside this widget (the wizard), and tokens expire.
    window.addEventListener('ws:setup-changed', () => { void this.refresh(); });
    // The profile row (or the Files strip's avatar) opens the accounts half of the menu, the Settings row (or the
    // strip's gear) the preferences. `detail.anchor` is the element that asked: the menu floats next to it.
    window.addEventListener('ws:toggle-accounts', (e: any) => this.toggleMenu('accounts', e.detail?.anchor));
    window.addEventListener('ws:toggle-settings', (e: any) => this.toggleMenu('settings', e.detail?.anchor));
    document.addEventListener('mousedown', e => {
      if (!this.open) { return; }
      const t = e.target as HTMLElement;
      if (t.closest && t.closest('.ws-settings-inline, .ws-settings-btn, .ws-foot-acct, .ws-strip-btn, .ws-modal')) { return; }
      this.open = false; this.update();
    }, true);
    const poll = setInterval(() => { void this.refresh(); }, 15000);
    this.toDispose.push({ dispose: () => clearInterval(poll) });
    // Capture phase: Theia's keybinding dispatcher stops Escape before it bubbles to document.
    window.addEventListener('keydown', e => { if (e.key !== 'Escape') { return; } if (this.modal) { this.closeModal(); } else if (this.open) { this.open = false; this.update(); } }, true);
  }

  protected async refresh(): Promise<void> {
    try { this.setup = await (await fetch(`${API}/api/setup`)).json(); this.update(); } catch { /* agent restarting */ }
  }
  protected openModal(m: Modal): void { this.modal = m; this.update(); }
  protected closeModal(): void { this.modal = null; this.update(); }

  // ---------- secrets & variables ----------
  protected env: Record<string, string> | null = null;
  protected envMsg = '';
  protected async openEnv(): Promise<void> {
    try { this.env = await (await fetch(`${API}/api/env`)).json(); } catch { this.env = {}; }
    if (!Object.keys(this.env!).length) { this.env = { '': '' }; }
    this.envMsg = ''; this.openModal({ kind: 'env' });
  }
  protected async saveEnv(): Promise<void> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.env || {})) {
      const key = k.trim().toUpperCase(); if (!key) { continue; }
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) { this.envMsg = `“${key}” isn’t a valid name (letters, numbers, _).`; this.update(); return; }
      out[key] = v;
    }
    try {
      const r = await fetch(`${API}/api/env`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) });
      if (!r.ok) { throw new Error((await r.json()).error || 'save failed'); }
      this.envMsg = 'Saved ✓';
    } catch (e: any) { this.envMsg = e.message; }
    this.update();
  }
  protected renderEnv(): React.ReactNode {
    const entries = Object.entries(this.env || {});
    const rekey = (oldK: string, newK: string) => { const n: Record<string, string> = {}; for (const [k, v] of entries) { n[k === oldK ? newK.toUpperCase() : k] = v; } this.env = n; this.update(); };
    return <div className="ws-flow">
      <p className="ws-muted ws-small">Stored as environment variables for your apps. Changes apply right away.</p>
      {entries.map(([k, v], i) => <div className="ws-envrow" key={i}>
        <input className="ws-envk" placeholder="NAME" value={k} onChange={e => rekey(k, e.target.value)} />
        <input className="ws-envv" type="password" placeholder="value" value={v} onChange={e => { this.env![k] = e.target.value; this.update(); }} />
        <button className="ws-quiet" title="Remove" onClick={() => { delete this.env![k]; this.update(); }}>✕</button>
      </div>)}
      <button className="ws-add" onClick={() => { this.env![''] = ''; this.update(); }}>+ Add variable</button>
      <div className="ws-envfoot"><button className="ws-primary" onClick={() => this.saveEnv()}>Save</button><span className="ws-small">{this.envMsg}</span></div>
    </div>;
  }

  protected mode: 'settings' | 'accounts' = 'settings';
  /** Where the open menu hangs: the rect of the row / strip button that opened it. */
  protected anchor?: DOMRect;
  protected toggleMenu(mode: 'settings' | 'accounts', anchorEl?: HTMLElement): void {
    const was = this.open && this.mode === mode;
    this.mode = mode; this.open = !was;
    this.anchor = (anchorEl || this.node).getBoundingClientRect();
    if (this.open) { void this.refresh(); }
    this.update();
  }
  /** The menu floats on the page, not inside the sidebar: the side panel clips its children, and while Files is the
   *  56px strip the footer is out of sight. Above the anchor when it sits low (the footer), beside it in the strip. */
  protected floatStyle(): React.CSSProperties {
    const r = this.anchor;
    if (!r) { return { left: 12, bottom: 80 }; }
    const narrow = r.width < 100;   // a strip button: open to its right
    return narrow
      ? { left: Math.round(r.right + 10), bottom: Math.max(8, Math.round(window.innerHeight - r.bottom)), width: 300 }
      : { left: Math.round(r.left), bottom: Math.round(window.innerHeight - r.top + 6), width: Math.max(Math.round(r.width), 260) };
  }

  protected async openTerminal(): Promise<void> {
    this.open = false; this.update();
    await this.terminal.open();
  }

  /** Accounts: opened from the profile row, rendered above it in the sidebar footer. */
  protected renderAccountsMenu(): React.ReactNode {
    return <div className="ws-settings-inline ws-accounts-menu">
      {ACCOUNTS.map(a => {
        const s = this.setup[a.key];
        return <button key={a.key} className="ws-row ws-acct" onClick={() => this.openModal({ kind: 'flow', account: a })}>
          <span className="ws-label">{a.label}</span>
          <small className={s?.ok ? 'ws-ok' : 'ws-muted'}>{s?.ok ? `✓ Connected${s.user ? ' as ' + s.user : ''}` : 'Not connected — click to sign in'}</small>
        </button>;
      })}
    </div>;
  }

  // ---------- assistant (Claude | OpenCode) ----------
  protected switching = false;
  /** Persist the pick (User scope → ~/.theia/settings.json) and reload: both extensions activate at start, and
   *  the layout reads the preference once while booting. */
  protected pickAssistant(a: Assistant): void {
    if (this.switching || asAssistant(this.prefs.get(ASSISTANT_PREF)) === a) { return; }
    this.switching = true; this.update();
    void this.prefs.set(ASSISTANT_PREF, a, PreferenceScope.User)
      .then(() => new Promise(r => setTimeout(r, 400)))   // let the preference file land before the reload
      .finally(() => location.reload());
  }

  /** Preferences: opened from the gear in the top bar. */
  protected renderSettingsMenu(): React.ReactNode {
    const assistant = asAssistant(this.prefs.get(ASSISTANT_PREF));
    return <div className="ws-settings-inline">
      <div className="ws-menu-cap">Theme</div>
      <div className="ws-theme-row" role="radiogroup" aria-label="Theme">
        {THEMES.map(t => <button key={t.theme} role="radio" aria-checked={this.prefs.get('workbench.colorTheme') === t.theme}
          className={'ws-theme-pick' + (this.prefs.get('workbench.colorTheme') === t.theme ? ' on' : '')}
          onClick={() => { void this.prefs.set('workbench.colorTheme', t.theme, PreferenceScope.User).then(() => this.update()); }}>{t.label}</button>)}
      </div>
      <div className="ws-menu-cap">Assistant</div>
      <div className="ws-theme-row ws-assist-row" role="radiogroup" aria-label="Assistant">
        {ASSISTANTS.map(a => <button key={a.id} role="radio" aria-checked={assistant === a.id} disabled={this.switching}
          className={'ws-theme-pick' + (assistant === a.id ? ' on' : '')}
          onClick={() => this.pickAssistant(a.id)}>{a.label}</button>)}
      </div>
      <p className="ws-muted ws-small ws-assist-hint">{this.switching ? 'Switching — the workspace reloads…' : assistantInfo(assistant).desc}</p>
      <hr />
      <button className="ws-row ws-acct" onClick={() => this.openEnv()}><span className="ws-label">Secrets &amp; variables</span><small className="ws-muted">API keys and environment variables</small></button>
      {/* The plain terminal lives here, not in the sidebar footer: it is for advanced use, the assistant is the terminal */}
      <button className="ws-row ws-acct" onClick={() => this.openTerminal()}><span className="ws-label">Terminal</span><small className="ws-muted">A plain shell, for advanced use</small></button>

    </div>;
  }

  protected renderModal(m: Modal): React.ReactNode {
    const title = m.kind === 'flow' ? m.account.label : 'Secrets & variables';
    return <div className="ws-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) { this.closeModal(); } }}>
      <div className="ws-modal" role="dialog" aria-label={title}>
        <div className="ws-modal-head"><strong>{title}</strong><button className="ws-quiet" onClick={() => this.closeModal()}>Close</button></div>
        <div className="ws-modal-body">
          {m.kind === 'flow' && <div>
            {m.account.desc && <p className="ws-muted ws-flow-desc">{m.account.desc}</p>}
            <GuidedFlow key={m.account.key} account={m.account} onDone={() => {
              this.refresh();
              // The Claude extension reads credentials only at activation: one reload connects it.
              if (m.account.key === 'claude') { setTimeout(() => location.reload(), 1500); }
            }} />
          </div>}
          {m.kind === 'env' && this.renderEnv()}
        </div>
      </div>
    </div>;
  }

  protected render(): React.ReactNode {
    return <div className="ws-settings">
      {/* a footer row like the profile row below it; the menus float on the page (floatStyle) */}
      <button className="ws-foot-row ws-settings-btn" onClick={e => this.toggleMenu('settings', e.currentTarget)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
        <span>Settings</span>
      </button>
      {this.open && createPortal(<div className="ws-settings-float" style={this.floatStyle()}>
        {this.mode === 'settings' ? this.renderSettingsMenu() : this.renderAccountsMenu()}
      </div>, document.body)}
      {this.modal && createPortal(this.renderModal(this.modal), document.body)}
    </div>;
  }
}
