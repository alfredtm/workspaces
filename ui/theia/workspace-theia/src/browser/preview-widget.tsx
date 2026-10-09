import { injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import React = require('@theia/core/shared/react');

export const PREVIEW_WIDGET_ID = 'workspace-preview';
const API = '/workspace-api';

/** Something the pane can show: a running app (a listening port) or an HTML file served by the agent. */
type Source = { kind: 'port'; port: number; url: string; folder?: string; name?: string } | { kind: 'page'; path: string; mtime: number; title?: string };
const keyOf = (s: Source) => s.kind === 'port' ? `port:${s.port}` : `page:${s.path}`;
/** What the user calls it: the app's page title or folder (the agent's `name`), a page's <title>; else the port / file. */
const labelOf = (s: Source) => s.kind === 'port' ? (s.name || `Port ${s.port}`) : (s.title || s.path);
/** The quiet second part after the name: the port, or the file a titled page lives in. */
const subOf = (s: Source) => s.kind === 'port' ? (s.name ? `:${s.port}` : '') : (s.title ? s.path : '');
/** Where pages load from: the agent's page server at its own address in a pod (a real origin — localStorage works,
 *  the editor is out of reach), or null → the sandboxed /preview/ route on the editor's origin (the lab). */
let pagesBase: string | null = null;
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const srcOf = (s: Source) => s.kind === 'port' ? s.url : pagesBase ? `${pagesBase.replace(/\/?$/, '/')}${encPath(s.path)}` : `${API}/preview/${encPath(s.path)}`;

/** Toolbar icons: 16px line icons in currentColor, the same stroke as the OpenCode card's toolbar. */
const svg = (d: string) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const ICON = {
  refresh: svg('M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7'),
  phone: svg('M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2'),
  desktop: svg('M3 5h18v11H3zM8 20h8M12 16v4'),
  external: svg('M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'),
  expand: svg('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'),
  chevron: svg('M6 9l6 6 6-6'),
  more: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>,
};

/**
 * Preview — the running app (or an HTML file the assistant wrote) inside the editor: a thin toolbar
 * (what is shown, refresh, phone/desktop width, open in a new tab, full screen) over an iframe. Not a tab: an
 * overlay over the whole main area, switched with the top bar's Preview button (layout-contribution.ts
 * setPreview); opening a file switches back to the files.
 *
 * Ports come from the Running widget's poll (`ws:ports`, cached on window.__wsPorts for late mounts); pages from
 * the agent's /api/preview/pages every few seconds — also while the tab is closed: the widget is created at boot
 * and announces what it could show (`ws:preview-sources`), so the top bar can light the button up or open the tab.
 * Until the user picks a source, the pane follows the newest thing: an app when one is running, else the most
 * recently written HTML page — and it reloads a shown page when the file changes, so edits appear on their own
 * (a dev server does that itself through HMR).
 *
 * Projects: the OpenCode card's tabs are top-level folders (`ws:project`, detail.folder; '' = the whole
 * workspace). In a project the pane offers only that folder's apps (the agent reports each port's folder) and
 * pages; a project with nothing of its own falls back to everything, like the workspace tab.
 */
@injectable()
export class PreviewWidget extends ReactWidget {
  protected ports: Source[] = [];
  protected pages: Source[] = [];
  protected current?: Source;
  protected picked = false;          // the user chose a source: stop following the newest
  protected device: 'desktop' | 'phone' = 'desktop';
  protected menu = false;
  protected more = false;            // the ⋯ menu (width, new tab, full screen)
  protected nonce = 0;               // bump → the iframe remounts (refresh)
  protected frame = React.createRef<HTMLIFrameElement>();
  protected pane = React.createRef<HTMLDivElement>();

  @postConstruct()
  protected init(): void {
    this.id = PREVIEW_WIDGET_ID;
    this.title.label = 'Preview';
    this.title.caption = '';
    this.title.closable = true;
    this.addClass('workspace-preview');
    const onPorts = (list: { port: number; url: string; folder?: string; name?: string }[]) => {
      this.ports = (list || []).map(p => ({ kind: 'port' as const, port: p.port, url: p.url, folder: p.folder, name: p.name }));
      this.follow();
    };
    const handler = (e: any) => onPorts(e.detail);
    window.addEventListener('ws:ports', handler);
    this.toDispose.push({ dispose: () => window.removeEventListener('ws:ports', handler) });
    onPorts((window as any).__wsPorts || []);
    const onProject = (folder: string) => {
      if (folder === this.project) { return; }
      this.project = folder; this.picked = false; this.current = undefined; this.follow();
    };
    const projectHandler = (e: any) => onProject(String(e.detail?.folder || ''));
    window.addEventListener('ws:project', projectHandler);
    this.toDispose.push({ dispose: () => window.removeEventListener('ws:project', projectHandler) });
    onProject(String((window as any).__wsProject || ''));
    void this.pollPages();
    const t = setInterval(() => { void this.pollPages(); }, 4000);
    this.toDispose.push({ dispose: () => clearInterval(t) });
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (this.menu && !t.closest?.('.ws-pv-pick')) { this.menu = false; this.update(); }
      if (this.more && !t.closest?.('.ws-pv-more')) { this.more = false; this.update(); }
    };
    document.addEventListener('mousedown', close, true);
    this.toDispose.push({ dispose: () => document.removeEventListener('mousedown', close, true) });
    this.update();
  }

  protected async pollPages(): Promise<void> {
    try {
      const body: { base?: string | null; pages?: { path: string; mtime: number; title?: string }[] } | { path: string; mtime: number; title?: string }[] =
        await (await fetch(`${API}/api/preview/pages`)).json();
      // older agents answered with the bare list
      const list = Array.isArray(body) ? body : (body.pages || []);
      pagesBase = Array.isArray(body) ? null : (body.base || null);
      const prev = this.current?.kind === 'page' ? this.pages.find(p => keyOf(p) === keyOf(this.current!)) : undefined;
      this.pages = (Array.isArray(list) ? list : []).map(p => ({ kind: 'page' as const, path: p.path, mtime: p.mtime, title: p.title }));
      // the shown page was rewritten → reload it
      const now = prev && this.pages.find(p => keyOf(p) === keyOf(prev));
      if (prev && now && now.kind === 'page' && prev.kind === 'page' && now.mtime !== prev.mtime) { this.current = now; this.nonce++; }
      this.follow();
    } catch { /* agent restarting */ }
  }

  /** The OpenCode tab's project (a top-level folder), '' = the whole workspace. */
  protected project = '';

  /** What the current project can show: its own apps and pages, or everything when it has none (or is ''). */
  protected get scoped(): { ports: Source[]; pages: Source[] } {
    if (!this.project) { return { ports: this.ports, pages: this.pages }; }
    const ports = this.ports.filter(p => p.kind === 'port' && p.folder === this.project);
    const pages = this.pages.filter(p => p.kind === 'page' && p.path.startsWith(this.project + '/'));
    return ports.length || pages.length ? { ports, pages } : { ports: this.ports, pages: this.pages };
  }

  protected get sources(): Source[] { const s = this.scoped; return [...s.ports, ...s.pages]; }

  /** Keep the shown source valid; until the user picks, show the newest app, else the newest page. */
  protected follow(): void {
    const { ports, pages } = this.scoped;
    const all = [...ports, ...pages];
    // `newest` changes when a new app starts or a page is (re)written: the top bar may open the tab for it.
    const newest = ports[0] ? keyOf(ports[0]) : pages[0] ? `${keyOf(pages[0])}@${(pages[0] as any).mtime}` : '';
    window.dispatchEvent(new CustomEvent('ws:preview-sources', { detail: { count: all.length, apps: ports.length, newest } }));
    const still = this.current && all.find(s => keyOf(s) === keyOf(this.current!));
    if (this.picked && still) { this.update(); return; }
    const next = ports[0] || pages[0];
    if (!next) { this.current = undefined; this.picked = false; this.update(); return; }
    if (!this.current || keyOf(next) !== keyOf(this.current)) { this.current = next; this.picked = false; this.nonce++; }
    this.update();
  }

  protected pick(s: Source): void {
    this.current = s; this.picked = true; this.menu = false; this.nonce++; this.update();
  }

  protected refresh(): void { this.nonce++; this.update(); }

  /** Tell the page (the script the agent / authproxy add to Preview pages) to draw its scrollbar in the editor's
   *  colours: the track in the Preview header's, the thumb in the chat's (var(--ws-border), .oc-scroll). The page
   *  checks the message comes from us and holds plain colours; '*' is fine as a target, nothing here is secret. */
  protected sendScrollbarColours(): void {
    const win = this.frame.current?.contentWindow;
    const pane = this.pane.current;
    if (!win || !pane) { return; }
    const track = getComputedStyle(pane).backgroundColor;
    const thumb = getComputedStyle(document.body).getPropertyValue('--ws-border').trim();
    const rgb = (track.match(/[\d.]+/g) || []).map(Number);
    const dark = rgb.length >= 3 ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.5 : true;
    if (!track || !thumb) { return; }
    try { win.postMessage({ workspacePreviewScrollbar: { track, thumb, dark } }, '*'); } catch { /* frame gone */ }
  }

  protected fullscreen(): void {
    const el = this.pane.current;
    if (!el) { return; }
    if (document.fullscreenElement) { void document.exitFullscreen(); } else { void el.requestFullscreen?.(); }
  }

  protected render(): React.ReactNode {
    const cur = this.current;
    const all = this.sources;
    return <div className="ws-pv" ref={this.pane}>
      <div className="ws-pv-bar">
        <div className="ws-pv-pick">
          <button className="ws-pv-src" disabled={all.length < 2} title={all.length > 1 ? 'Show something else' : undefined}
            onClick={() => { this.menu = !this.menu; this.update(); }}>
            {cur && <span className={`ws-dot ${cur.kind === 'page' ? 'is-file' : ''}`} />}
            <span className="ws-pv-label">{cur ? labelOf(cur) : 'Preview'}</span>
            {cur && subOf(cur) && <span className="ws-pv-sub">{subOf(cur)}</span>}
            {all.length > 1 && <span className="ws-pv-caret">{ICON.chevron}</span>}
          </button>
          {this.menu && <div className="ws-pv-menu">
            {all.map(s => <button key={keyOf(s)} className={cur && keyOf(s) === keyOf(cur) ? 'is-on' : ''} onClick={() => this.pick(s)}>
              <span className={`ws-dot ${s.kind === 'page' ? 'is-file' : ''}`} /><span className="ws-pv-label">{labelOf(s)}</span>
              {subOf(s) && <span className="ws-pv-sub">{subOf(s)}</span>}
            </button>)}
          </div>}
        </div>
        {/* One visible action (refresh); the rest in a ⋯ menu — the header stays quiet */}
        <div className="ws-pv-actions">
          <button className="ws-pv-btn" title="Refresh" disabled={!cur} onClick={() => this.refresh()}>{ICON.refresh}</button>
          <div className="ws-pv-more">
            <button className={`ws-pv-btn ${this.more ? 'is-on' : ''}`} title="More" disabled={!cur} onClick={() => { this.more = !this.more; this.update(); }}>{ICON.more}</button>
            {this.more && cur && <div className="ws-pv-menu ws-pv-menu--right">
              <button onClick={() => { this.device = this.device === 'phone' ? 'desktop' : 'phone'; this.more = false; this.update(); }}>
                {this.device === 'phone' ? ICON.desktop : ICON.phone}{this.device === 'phone' ? 'Desktop width' : 'Phone width'}</button>
              <a href={srcOf(cur)} target="_blank" rel="noreferrer" onClick={() => { this.more = false; this.update(); }}>{ICON.external}Open in a new tab</a>
              <button onClick={() => { this.more = false; this.update(); this.fullscreen(); }}>{ICON.expand}Full screen</button>
            </div>}
          </div>
        </div>
      </div>
      <div className={`ws-pv-stage ${this.device === 'phone' ? 'is-phone' : ''}`}>
        {cur
          ? <iframe key={`${keyOf(cur)}#${this.nonce}`} ref={this.frame} className="ws-pv-frame" src={srcOf(cur)} title="Preview"
              // pages on the editor's origin (the lab's /preview/ fallback): an opaque origin on top of the agent's CSP
              // sandbox header. Pages from the page server's own address, and apps: their own origin, untouched.
              {...(cur.kind === 'page' && !pagesBase ? { sandbox: 'allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock' } : {})}
              onLoad={() => this.sendScrollbarColours()}
              allow="clipboard-read; clipboard-write; fullscreen" />
          : <div className="ws-pv-empty">
              <div className="ws-pv-empty-title">Nothing to show yet</div>
              <p>Ask the assistant to build something. Your app appears here as soon as it runs.</p>
            </div>}
      </div>
    </div>;
  }
}
