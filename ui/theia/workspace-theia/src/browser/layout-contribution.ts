import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, FrontendApplication, ApplicationShell, WidgetManager, ViewContainer, Widget } from '@theia/core/lib/browser';
import { FileNavigatorContribution } from '@theia/navigator/lib/browser/navigator-contribution';
import { RUNNING_WIDGET_ID } from './running-widget';
import { SETTINGS_WIDGET_ID } from './settings-widget';
import { WIZARD_WIDGET_ID } from './wizard-widget';
import { TerminalModal } from './terminal-modal';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { ConnectionStatus, ConnectionStatusService } from '@theia/core/lib/browser/connection-status-service';
import { ASSISTANT_PREF, Assistant, OPENCODE_WIDGET_ID, asAssistant, assistantInfo, assistantOf, widgetKind } from './assistant';
import { PREVIEW_WIDGET_ID } from './preview-widget';
import { OPENCODE_BASE } from './opencode/client';

/** The favicon's rounded square (src/node/agent-proxy.ts serves it at /favicon.svg) with a green dot: "your turn". */
const BADGE = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect x="10" y="10" width="76" height="76" rx="20" fill="#7c83f7"/><circle cx="78" cy="18" r="16" fill="#46d48a" stroke="#0c0c0e" stroke-width="6"/></svg>');

/** Hidden Files panel, per browser (a view choice, not a workspace setting). */
const LS_FILES_HIDDEN = 'ws-files-hidden';

const EXPLORER_CONTAINER = 'explorer-view-container';

/**
 * The workspace layout: Files (+Running, +Settings sections) on the left, the assistant (Claude Code, or
 * OpenCode when the user picked it in Settings → Assistant; see assistant.ts) next to it, and the main area —
 * open files and the Preview tab (preview-widget.tsx) — on the right. The assistant's side panel is Theia's
 * RIGHT panel, re-inserted second in the split (placeChatSecond). Top bar: Files and Preview toggles. No activity
 * bars, no status bar, no menu — the brand bar on top is ours.
 */
@injectable()
export class WorkspaceLayoutContribution implements FrontendApplicationContribution {
  @inject(ApplicationShell) protected readonly shell: ApplicationShell;
  @inject(WidgetManager) protected readonly widgets: WidgetManager;
  @inject(FileNavigatorContribution) protected readonly navigator: FileNavigatorContribution;
  @inject(TerminalModal) protected readonly terminalModal: TerminalModal;
  @inject(FileService) protected readonly fileService: FileService;
  @inject(PreferenceService) protected readonly prefs: PreferenceService;
  @inject(ConnectionStatusService) protected readonly connection: ConnectionStatusService;

  /** Read once at boot; Settings → Assistant writes the preference and reloads. */
  protected assistant: Assistant = 'claude';

  async onStart(app: FrontendApplication): Promise<void> {
    document.body.classList.add('ws-booting');
    await this.prefs.ready;
    // Pi reuses the OpenCode widget: everything below thinks in widget kinds; the body says which flavour
    const chosen = asAssistant(this.prefs.get(ASSISTANT_PREF));
    this.assistant = widgetKind(chosen);
    document.body.classList.add('ws-assistant-' + this.assistant);
    if (chosen === 'pi') { document.body.classList.add('ws-assistant-pi'); }
    this.syncThemeClass(); this.prefs.onPreferenceChanged(e => { if (e.preferenceName === 'workbench.colorTheme') { this.syncThemeClass(); } });
    // Satoshi (Fontshare stylesheet; degrades to system-ui offline).
    if (!document.querySelector('link[href*="fontshare"]')) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap'; document.head.appendChild(l); }
    // Theia's index.html has no icon; the backend serves one at /favicon.svg (src/node/agent-proxy.ts).
    if (!document.querySelector('link[rel~="icon"]')) { const l = document.createElement('link'); l.rel = 'icon'; l.type = 'image/svg+xml'; l.href = '/favicon.svg'; document.head.appendChild(l); }
    // Theia's expandBottomPanel() animates the (empty, hidden) bottom panel when an editor
    // opens and trips over a missing sash ('reading offsetTop'). With emptySize 0 it skips that.
    try { const opts: any = (this.shell as any).options; if (opts?.bottomPanel) { opts.bottomPanel.emptySize = 0; } } catch { /* option shape changed */ }
    this.guardWebviewServiceWorker();
    this.guardBackendSwap();
    this.nativePaste();
    if (this.assistant === 'claude') { this.watchClaudeTurn(); }
    if (this.assistant === 'opencode') { void this.ensureOpenCodeWidget(); }
    this.mountBrandBar();
    this.mountClaudeHeader();
    this.stripPathTooltips();
    this.setupMobile();
    this.mountAppChip();
    void this.mountWizard();
    await this.arrange();
    void this.mountFooter();
    this.mountViewToggles();
    // Created now (not attached): it polls for apps and pages while its tab is closed and tells the top bar.
    void this.widgets.getOrCreateWidget(PREVIEW_WIDGET_ID);
    this.revealWhenSettled();
    this.lockMainArea();
    // Terminals never live in the bottom panel: whatever opens one (Settings, the Claude
    // extension, ctrl+`), it becomes the popup terminal.
    this.shell.onDidAddWidget(w => { if (w instanceof TerminalWidget) { this.terminalModal.adopt(w); } });
    // Plugin views (Claude) arrive asynchronously — keep Claude on the right,
    // Explorer on the left, whenever new widgets show up.
    this.shell.onDidAddWidget(() => { void this.arrange(); this.keepExplorerLeft(); this.fitClaude(); });
    let ticks = 0; const t = setInterval(() => { this.keepExplorerLeft(); this.keepAssistantRight(); this.fitClaude(); this.scheduleWebviewStyle(); void this.mountFooter(); if (++ticks > 40) { clearInterval(t); } }, 750);
    const right = document.getElementById('theia-right-content-panel');
    if (right) { new MutationObserver(() => this.scheduleWebviewStyle()).observe(right, { childList: true, subtree: true }); }
    document.querySelectorAll('iframe').forEach(f => f.addEventListener('load', () => this.scheduleWebviewStyle()));
    // The Claude extension activates its own left view after we lay out; keep
    // Explorer as the left panel's current widget (Claude lives on the right).
    this.shell.onDidChangeCurrentWidget(() => { this.keepExplorerLeft(); this.keepAssistantRight(); });
    try { (this.shell.leftPanelHandler as any).tabBar?.currentChanged?.connect?.(() => this.keepExplorerLeft()); } catch { /* no tab bar signal */ }
    // Claude fills the whole right side when nothing is open; splits with the editor otherwise.
    const refit = () => { requestAnimationFrame(() => this.fitClaude()); for (const ms of [150, 400, 900, 1800]) { setTimeout(() => this.fitClaude(), ms); } };
    const mp: any = this.shell.mainPanel;
    try { mp.widgetAdded?.connect?.(refit); mp.widgetRemoved?.connect?.(refit); mp.layoutModified?.connect?.(refit); } catch { /* signals vary by version */ }
    this.shell.onDidRemoveWidget(refit);
    this.shell.onDidAddWidget(w => {
      const inMain = Array.from(this.shell.mainPanel.widgets()).includes(w);
      if (document.body.classList.contains('ws-mobile') && inMain) {
        this.mobileView = 'editor'; document.body.classList.remove('ws-sidebar-open');
      }
      // Theia's tab hover shows title.caption — the absolute fs path. Not useful to our users: keep it empty.
      if (inMain) {
        const clear = () => { if (w.title.caption) { w.title.caption = ''; } };
        clear(); w.title.changed.connect(clear);
      }
    });
    this.shell.onDidAddWidget(refit);
    window.addEventListener('resize', () => this.fitClaude());
  }

  async initializeLayout(app: FrontendApplication): Promise<void> {
    await this.arrange();
  }

  /** After the saved layout is restored (it replaces the split's contents): chat second, Files as the user left it. */
  async onDidInitializeLayout(app: FrontendApplication): Promise<void> {
    // A Preview TAB restored from a layout saved by an earlier build: the Preview is an overlay now (setPreview).
    for (const w of Array.from(this.shell.mainPanel.widgets())) { if (w.id === PREVIEW_WIDGET_ID) { try { w.close(); } catch { /* gone */ } } }
    this.placeChatSecond();
    this.applyFilesHidden();
  }

  protected arranging = false;
  protected async arrange(): Promise<void> {
    if (this.arranging) { return; }
    this.arranging = true;
    try {
      // Hide the activity bars through Lumino so the box layout reclaims their 48px
      // (CSS display:none leaves the slot allocated — content sits 48px in).
      try { this.shell.leftPanelHandler.tabBar.hide(); this.shell.rightPanelHandler.tabBar.hide(); } catch { /* not ready */ }
      // Same for the status bar and menu/top panel: CSS display:none leaves Lumino's 22px slot (a dead strip under the sidebar).
      try { (this.shell as any).statusBar?.hide?.(); (this.shell as any).topPanel?.hide?.(); } catch { /* not ready */ }
      // Files on the left. Running + Settings live in the footer (mountFooter), NOT as container parts:
      // re-adding them here on every layout pass made them flash each time a file was opened.
      await this.navigator.openView({ activate: false });
      const container = await this.widgets.getOrCreateWidget<ViewContainer>(EXPLORER_CONTAINER).catch(() => undefined);
      if (container) {
        // Saved layouts from before these parts existed can leave them hidden/collapsed.
        for (const part of container.getParts()) {
          if (/^workspace-|files|navigator/i.test(part.wrapped.id)) { part.setHidden(false); part.collapsed = false; }
          if (/files|navigator/i.test(part.wrapped.id) && !(part.wrapped as any).__wsTitled) {
            (part.wrapped as any).__wsTitled = true;
            const title = part.wrapped.title;
            const pin = () => { if (title.label !== 'Your files') { title.label = 'Your files'; title.caption = 'Your files'; } };
            pin();
            title.changed.connect(pin); // the navigator re-labels itself with the workspace name later
          }
        }
        this.shell.activateWidget(container.id);
        // Files gets the room; Running and Settings stay compact.
        // Weights by part id (hidden stock parts get undefined). Retry: parts mount async.
        const applySizes = () => {
          const weights = container.getParts().map(p => /files|navigator/i.test(p.wrapped.id) ? 50 : /^workspace-footer-running/.test(p.wrapped.id) ? 12 : /^workspace-footer-settings/.test(p.wrapped.id) ? 38 : undefined);
          try {
            (container as any).containerLayout.setPartSizes(weights);
          } catch { /* not laid out yet */ }
        };
        applySizes(); for (const ms of [300, 1200, 3000]) { setTimeout(applySizes, ms); }
      }
      // Stock parts we don't want in the Files panel (Open Editors, Test Explorer, extension views such as NPM Scripts…).
      if (container) { this.evictStockParts(container); }
      // The chosen assistant belongs on the right. Claude's extension shares ONE webview between
      // its left-activity-bar view and its right-sidebar view, so never close a copy
      // (that disposes the webview and blanks the other). Move it right instead. Our OpenCode
      // widget can be restored anywhere by a saved layout — same move. The assistant NOT chosen
      // stays out of sight: Claude's views are hidden (never closed, see above), a stray OpenCode
      // widget is closed (it is cheap to recreate).
      const mine = (w: Widget) => assistantOf(w) === this.assistant;
      const rightHasAssistant = this.shell.getWidgets('right').some(mine);
      for (const w of [...this.shell.getWidgets('left'), ...Array.from(this.shell.mainPanel.widgets())]) {
        if (mine(w) && !rightHasAssistant) {
          try { await this.shell.addWidget(w, { area: 'right' }); console.info('workspace: moved assistant widget right', w.id, w.title.label); } catch (e) { console.warn('workspace: could not move assistant widget right', w.id, e); }
        }
      }
      for (const w of [...this.shell.getWidgets('left'), ...this.shell.getWidgets('right'), ...Array.from(this.shell.mainPanel.widgets())]) {
        const a = assistantOf(w);
        if (!a || a === this.assistant) { continue; }
        if (a === 'opencode') { try { w.close(); } catch { /* gone */ } } else { w.hide(); }
      }
      const explorer = this.shell.getWidgets('left').find((w: Widget) => /explorer/i.test(w.id));
      if (explorer) { this.shell.activateWidget(explorer.id); }
      const assistant = this.shell.getWidgets('right').find(mine);
      if (assistant) { this.shell.activateWidget(assistant.id); }
      this.fitClaude();
    } finally { this.arranging = false; }
  }

  /** One tab strip, no splits: our users open a file or two, they don't arrange panes. Tabs can't be
   *  dragged, and Lumino's drag-and-drop events (tab → split, tree file → editor area) never reach the dock. */
  protected lockMainArea(): void {
    const mp: any = this.shell.mainPanel;
    try { mp.tabsMovable = false; } catch { /* older Lumino */ }
    for (const type of ['lm-dragenter', 'lm-dragover', 'lm-dragleave', 'lm-drop']) {
      mp.node.addEventListener(type, (e: Event) => { e.preventDefault(); e.stopPropagation(); }, true);
    }
  }

  /** Our CSS variables follow the Monaco theme the user picked (Settings → Theme): body.ws-theme-{dark|navy|light}. */
  protected syncThemeClass(): void {
    const name = String(this.prefs.get('workbench.colorTheme') || '');
    const cls = /light/i.test(name) ? 'ws-theme-light' : /navy/i.test(name) ? 'ws-theme-navy' : 'ws-theme-dark';
    document.body.classList.remove('ws-theme-dark', 'ws-theme-navy', 'ws-theme-light');
    document.body.classList.add(cls);
  }

  /** Drop the boot veil once Claude has its final width and the footer is mounted (or after 2.5s regardless). */
  protected revealWhenSettled(): void {
    const t0 = Date.now();
    const tick = () => {
      const right = document.getElementById('theia-right-content-panel')?.getBoundingClientRect().width || 0;
      const settled = this.footerMounted && right > 200;
      if (settled || Date.now() - t0 > 2500) {
        this.fitClaude();
        requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('ws-booting')));
        return;
      }
      setTimeout(tick, 80);
    };
    tick();
  }

  protected styleTimer: any;
  /** Coalesce webview restyling: the MutationObserver on the right panel fires on every DOM change there. */
  protected scheduleWebviewStyle(): void {
    if (this.styleTimer) { return; }
    this.styleTimer = setTimeout(() => { this.styleTimer = undefined; this.styleClaudeWebview(); }, 150);
  }

  protected mobileView: 'editor' | 'claude' = 'claude';
  protected appChip?: HTMLElement;
  /** Phones: a floating "Open app" chip next to the hamburger while something is listening (drawer stays closed). */
  protected mountAppChip(): void {
    const chip = document.createElement('a'); chip.id = 'workspace-app-chip'; chip.hidden = true; chip.target = '_blank'; chip.rel = 'noreferrer';
    chip.innerHTML = '<span class="ws-dot"></span><span class="ws-chip-label">Open app</span><span class="ws-ext">↗</span>';
    this.topBar().querySelector('#workspace-tb-chip')!.appendChild(chip); this.appChip = chip;
    window.addEventListener('ws:ports', (e: any) => {
      const ports: { port: number; url: string }[] = e.detail || [];
      chip.hidden = ports.length === 0; document.body.classList.toggle('ws-has-app', ports.length > 0);
      if (!ports.length) { return; }
      chip.querySelector('.ws-chip-label')!.textContent = ports.length === 1 ? 'Open app' : `Open app (${ports.length})`;
      if (ports.length === 1) { chip.href = ports[0].url; chip.onclick = null; menu.hidden = true; }
      else {
        // several apps: a small list under the pill, one link per port
        chip.removeAttribute('href');
        menu.innerHTML = ports.map(p => `<a href="${p.url}" target="_blank" rel="noreferrer"><span class="ws-dot"></span>Port ${p.port}<span class="ws-ext">↗</span></a>`).join('');
        chip.onclick = ev => { ev.preventDefault(); menu.hidden = !menu.hidden; };
      }
    });
    const menu = document.createElement('div'); menu.id = 'workspace-app-menu'; menu.hidden = true;
    chip.parentElement!.appendChild(menu);
    window.addEventListener('click', ev => { if (!menu.hidden && !(ev.target as HTMLElement).closest('#workspace-tb-chip')) { menu.hidden = true; } }, true);
    window.addEventListener('keydown', ev => { if (ev.key === 'Escape') { menu.hidden = true; } }, true);
    menu.addEventListener('click', () => { menu.hidden = true; });
  }
  protected switchEl?: HTMLElement;
  /** Small Editor | Claude switch at the top on phones, only while a file is open. */
  protected updateMobileSwitch(visible: boolean): void {
    if (!this.switchEl) {
      const el = document.createElement('div'); el.id = 'workspace-mobile-switch'; el.setAttribute('role', 'tablist');
      el.innerHTML = '<button type="button" data-view="editor" role="tab">Editor</button><button type="button" data-view="claude" role="tab"></button>';
      el.querySelector<HTMLElement>('[data-view="claude"]')!.textContent = assistantInfo(this.assistant).label;
      el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { this.mobileView = b.dataset.view as any; document.body.classList.remove('ws-sidebar-open'); this.fitClaude(); }));
      this.topBar().querySelector('#workspace-tb-switch')!.appendChild(el); this.switchEl = el;
    }
    this.switchEl.hidden = !visible;
    this.switchEl.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.view === this.mobileView));
  }

  protected fitting = false;
  /** Mobile: the main dock is display:none while Claude is shown, so Lumino laid its children out at 0×0 (tab bar 0px,
   *  editor at its 100px minimum). Once the pane is visible again, make the dock measure and lay out afresh —
   *  a window resize alone does not recover it. */
  protected relayoutMain(): void {
    requestAnimationFrame(() => {
      const mp: any = this.shell.mainPanel;
      if (typeof mp.fit === 'function') { mp.fit(); }
      MessageLoop.sendMessage(mp, Widget.ResizeMessage.UnknownSize);
      for (const w of mp.widgets()) { MessageLoop.sendMessage(w, Widget.ResizeMessage.UnknownSize); }
    });
  }

  /** No native path tooltips: Theia puts the full fs path in `title` on tree rows and editor tabs. Keep the path
   *  on tree rows as data-ws-path (the delete affordance needs it) and drop the attribute. */
  protected stripPathTooltips(): void {
    const isPath = (t: string | null) => !!t && /^(\/|~\/|[A-Za-z]:\\)/.test(t);
    const strip = (el: Element) => {
      const rows = el.matches('.theia-TreeNode, .lm-TabBar-tab, .theia-view-container-part-header .label') ? [el] : Array.from(el.querySelectorAll('.theia-TreeNode[title], .lm-TabBar-tab[title], .theia-view-container-part-header .label[title]'));
      for (const r of rows) { const t = r.getAttribute('title'); if (!isPath(t)) { continue; } if (r.classList.contains('theia-TreeNode')) { (r as HTMLElement).dataset.wsPath = t!; } r.removeAttribute('title'); }
    };
    const obs = new MutationObserver(ms => { for (const m of ms) { if (m.type === 'attributes') { strip(m.target as Element); } else { m.addedNodes.forEach(n => { if (n instanceof Element) { strip(n); } }); } } });
    const shell = document.getElementById('theia-app-shell');
    if (!shell) { setTimeout(() => this.stripPathTooltips(), 200); return; }
    obs.observe(shell, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
    strip(shell);
  }

  protected fitClaude(): void {
    if (this.fitting) { return; }
    this.fitting = true;
    try {
      const mainWidgets = Array.from(this.shell.mainPanel.widgets());
      // the Preview overlay needs the main area as much as an open file does
      const hasEditors = this.previewShown || mainWidgets.some((w: Widget) => !w.isHidden && !w.isDisposed && !assistantOf(w));
      const mobile = document.body.classList.contains('ws-mobile');
      const left = mobile ? 0 : this.filesHidden ? 56 : 280; // fixed tree; off-canvas on mobile; the slim strip while hidden
      const total = window.innerWidth;
      // Mobile: one pane at a time — the editor (when a file is open and chosen) or Claude; a top switch flips.
      if (mobile && !hasEditors) { this.mobileView = 'claude'; }
      const showEditor = hasEditors && (!mobile || this.mobileView === 'editor');
      const target = !hasEditors ? Math.max(0, Math.round(total - left - 2)) : mobile ? (showEditor ? 0 : total) : Math.round(total * 0.4);
      document.body.classList.toggle('ws-no-editor', !hasEditors);
      document.body.classList.toggle('ws-mobile-editor', mobile && showEditor);
      document.body.classList.toggle('ws-mobile-claude', mobile && hasEditors && !showEditor);
      this.updateMobileSwitch(mobile && hasEditors);
      if (mobile && showEditor) { this.relayoutMain(); }
      const right = document.getElementById('theia-right-content-panel')?.getBoundingClientRect().width || 0;
      const mainW = document.getElementById('theia-main-content-panel')?.getBoundingClientRect().width || 0;
      const wantMain = Math.max(0, total - left - target);
      const leftW = document.getElementById('theia-left-content-panel')?.getBoundingClientRect().width || 0;
      // compare every pane: on mobile one of them is display:none (width 0) and would otherwise look "already right";
      // the Files column changes on its own (full ↔ strip) while the other two may already be right
      if (Math.abs(right - target) > 4 || (hasEditors && Math.abs(mainW - wantMain) > 4) || (!mobile && Math.abs(leftW - left) > 4)) {
        // Set the left/main/right fractions directly on the Lumino split panel: the handler's
        // animated sash move can be refused when the main panel is at zero width.
        const split: any = (this.shell.rightPanelHandler as any).container?.parent;
        if (split && typeof split.setRelativeSizes === 'function' && split.widgets?.length === 3) {
          // By widget, not by index: the assistant's panel sits second (placeChatSecond).
          const leftC = (this.shell.leftPanelHandler as any).container, rightC = (this.shell.rightPanelHandler as any).container;
          split.setRelativeSizes(split.widgets.map((w: Widget) => w === leftC ? left : w === rightC ? target : wantMain));
          this.relayoutSplit(split);
        }
      }
    } catch { /* not laid out yet */ } finally { this.fitting = false; }
  }

  /** The right panel shows one widget at a time. Claude's extension reveals its own view whenever it activates
   *  (a second or two after our layout) — with OpenCode chosen that would push the TUI terminal behind it. Keep
   *  the chosen assistant current and the other one hidden. */
  protected keepAssistantRight(): void {
    try {
      const right = this.shell.getWidgets('right');
      const mine = right.find(w => assistantOf(w) === this.assistant && !w.isDisposed);
      if (!mine) { return; }
      for (const w of right) { const a = assistantOf(w); if (a && a !== this.assistant && !w.isHidden) { w.hide(); } }
      const handler: any = this.shell.rightPanelHandler;
      const current: Widget | undefined = handler.tabBar?.currentTitle?.owner || handler.state?.currentTitle?.owner;
      if (current !== mine || mine.isHidden) {
        if (typeof handler.activate === 'function') { handler.activate(mine.id); } else { this.shell.activateWidget(mine.id); }
      }
    } catch { /* shell not ready */ }
  }

  /** After the split's sizes change (reorder, Files/Preview toggles), make every panel in it lay its children out
   *  again at the new width: the side panels' inner widgets otherwise keep a stale width (the chat ended 54px short of
   *  its card; Files was cut off on the left). Next frame, once the split has applied the sizes. */
  protected relayoutSplit(split: any): void {
    requestAnimationFrame(() => {
      try {
        for (const w of split.widgets as Widget[]) {
          MessageLoop.sendMessage(w, Widget.ResizeMessage.UnknownSize);
          for (const c of Array.from((w as any).children?.() || []) as Widget[]) { MessageLoop.sendMessage(c, Widget.ResizeMessage.UnknownSize); }
        }
      } catch { /* not laid out yet */ }
    });
  }

  /** The chat next to Files, the code and the Preview to its right. The assistant stays in Theia's RIGHT side panel
   *  (its styling, the Claude header and webview handling key on #theia-right-content-panel, and Claude's webview must
   *  not change hosts); that whole panel is re-inserted second in the left/main/right split instead. */
  protected placeChatSecond(): void {
    try {
      const split: any = (this.shell.rightPanelHandler as any).container?.parent;
      const rightC = (this.shell.rightPanelHandler as any).container;
      if (split && typeof split.insertWidget === 'function' && split.widgets.indexOf(rightC) > 1) {
        split.insertWidget(1, rightC);
        this.fitClaude();
        this.relayoutSplit(split);
      }
      document.body.classList.toggle('ws-chat-second', split?.widgets?.indexOf(rightC) === 1);
    } catch (e) { console.warn('workspace: could not put the chat next to Files', e); }
  }

  // ---------- Files: full column, or a slim strip ----------
  protected filesHidden = localStorage.getItem(LS_FILES_HIDDEN) === '1';
  protected filesStrip?: HTMLElement;
  /** Hidden Files is a 56px strip, not nothing: the way back (a folder button) and the accounts (the avatar) stay
   *  exactly where the files and the profile row were. The column keeps its Lumino slot (fitClaude sizes it 56px);
   *  the strip is an overlay inside it that covers the tree and the footer while Files is hidden. */
  protected applyFilesHidden(): void {
    try {
      const mobile = document.body.classList.contains('ws-mobile');
      const c: any = (this.shell.leftPanelHandler as any).container;
      if (c?.isHidden) { c.show(); }   // a layout from an earlier build hid the column outright
      this.mountFilesStrip();
      document.body.classList.toggle('ws-files-hidden', this.filesHidden && !mobile);
      if (!this.filesHidden) { this.keepExplorerLeft(); }
      // Lumino reads each pane's min-width when it measures (the column is pinned to 280px, the strip to 56px):
      // re-measure the split so the new limit applies before sizing, or the slot stays 280px wide around the strip.
      const split: any = c?.parent;
      if (split) { MessageLoop.sendMessage(split, Widget.Msg.FitRequest); }
      this.fitClaude();
      requestAnimationFrame(() => this.fitClaude());
    } catch { /* not ready */ }
  }
  protected mountFilesStrip(): void {
    const host = document.getElementById('theia-left-content-panel');
    if (!host || (this.filesStrip && this.filesStrip.isConnected)) { return; }
    const strip = document.createElement('div'); strip.id = 'workspace-files-strip';
    strip.innerHTML = '<button type="button" class="ws-strip-btn ws-strip-files" title="Show your files (⌘B)" aria-label="Show your files">'
      + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></button>'
      + '<div class="ws-strip-spacer"></div>'
      + '<button type="button" class="ws-strip-btn ws-strip-settings" title="Settings" aria-label="Settings">'
      + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>'
      + '<button type="button" class="ws-strip-btn ws-strip-acct" title="Your accounts" aria-label="Your accounts"><span class="ws-avatar"></span></button>';
    strip.querySelector<HTMLElement>('.ws-strip-files')!.onclick = () => { if (this.filesHidden) { this.toggleFiles(); } };
    // the menus float next to the strip button that opened them (settings-widget.tsx floatStyle)
    const gear = strip.querySelector<HTMLElement>('.ws-strip-settings')!, acct = strip.querySelector<HTMLElement>('.ws-strip-acct')!;
    gear.onclick = () => window.dispatchEvent(new CustomEvent('ws:toggle-settings', { detail: { anchor: gear } }));
    acct.onclick = () => window.dispatchEvent(new CustomEvent('ws:toggle-accounts', { detail: { anchor: acct } }));
    const setName = (name: string) => { strip.querySelector('.ws-avatar')!.textContent = name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(); };
    setName(this.info.displayName || 'You');
    void fetch('/workspace-api/api/info').then(r => r.json()).then(i => { if (i?.displayName) { setName(i.displayName); } }).catch(() => { /* agent restarting */ });
    host.appendChild(strip); this.filesStrip = strip;
  }
  protected toggleFiles(): void {
    this.filesHidden = !this.filesHidden;
    localStorage.setItem(LS_FILES_HIDDEN, this.filesHidden ? '1' : '0');
    this.applyFilesHidden();
  }

  /** The Preview is not a tab: it is a mode of the main area. On, it covers the whole area (the file tabs included);
   *  off — or as soon as a file is opened — the files and their tabs are back, untouched underneath. The widget is
   *  attached to an overlay host inside the main dock's node, outside the dock's own layout. */
  protected previewShown = false;
  protected previewHost?: HTMLElement;
  protected async setPreview(show: boolean): Promise<void> {
    if (show === this.previewShown && (!show || this.previewHost?.isConnected)) { return; }
    this.previewShown = show;
    document.body.classList.toggle('ws-preview-on', show);
    if (show) {
      try {
        const w = await this.widgets.getOrCreateWidget(PREVIEW_WIDGET_ID);
        const dock = this.shell.mainPanel.node;
        if (!this.previewHost || !this.previewHost.isConnected) {
          this.previewHost = document.createElement('div'); this.previewHost.id = 'workspace-preview-host';
          dock.appendChild(this.previewHost);
        }
        if (!w.isAttached) { Widget.attach(w, this.previewHost); }
        w.show(); w.update();
      } catch (e) { console.warn('workspace: could not show the preview', e); }
    }
    this.previewBtn?.classList.toggle('is-on', show);
    if (show) { this.previewBtn?.classList.remove('has-news'); }
    this.fitClaude();
  }
  protected mainHasFiles(): boolean {
    return Array.from(this.shell.mainPanel.widgets()).some(w => !w.isDisposed && !assistantOf(w));
  }

  protected previewBtn?: HTMLElement;
  protected previewNewest = '';
  /** Top bar: [brand] … [Preview] (the Open app pill on phones) [gear]. Files hides from its own header and comes back
   *  from its strip (applyFilesHidden); ⌘B / Ctrl+B toggles it too. A new app or page opens the Preview by itself when
   *  no file is open, else the button lights up. */
  protected mountViewToggles(): void {
    const bar = this.topBar();
    const icon = (d: string) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
    const preview = document.createElement('button'); preview.type = 'button'; preview.id = 'workspace-tb-preview'; preview.className = 'ws-tb-toggle ws-tb-toggle--label'; preview.title = 'Show or hide the preview of your app';
    preview.innerHTML = icon('M3 5h18v14H3zM3 9h18') + '<span>Preview</span>';
    preview.addEventListener('click', () => { void this.setPreview(!this.previewShown); });
    bar.insertBefore(preview, bar.querySelector('#workspace-tb-chip'));
    this.previewBtn = preview;
    // ⌘B / Ctrl+B: Files full ↔ strip (capture: before Theia's own "toggle left panel", which would fight the strip)
    window.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b' && !document.body.classList.contains('ws-mobile')) {
        e.preventDefault(); e.stopPropagation(); this.toggleFiles();
      }
    }, true);
    window.addEventListener('ws:preview-sources', (e: any) => {
      const { count, apps, newest } = e.detail || {};
      preview.classList.toggle('has-sources', count > 0);
      // Preview replaces the Open app pill on desktop: an app running = the green dot the pill used to show
      preview.classList.toggle('has-app', apps > 0);
      preview.title = apps > 1 ? `${apps} apps running — show the preview (pick one at its top left)` : apps === 1 ? 'Your app is running — show the preview' : 'Show or hide the preview of your app';
      if (!newest || newest === this.previewNewest) { return; }
      const first = !this.previewNewest; this.previewNewest = newest;
      if (first && document.body.classList.contains('ws-booting')) { return; }   // what was already there at boot
      if (this.previewShown) { return; }
      if (!this.mainHasFiles() && !document.body.classList.contains('ws-mobile')) { void this.setPreview(true); } else { preview.classList.add('has-news'); }
    });
    // Opening a file (a new tab, or switching to one) brings the files back.
    this.shell.onDidAddWidget(w => { if (this.previewShown && Array.from(this.shell.mainPanel.widgets()).includes(w) && !assistantOf(w)) { void this.setPreview(false); } });
    this.shell.onDidChangeActiveWidget(e => { const w = e.newValue; if (this.previewShown && w && Array.from(this.shell.mainPanel.widgets()).includes(w) && !assistantOf(w)) { void this.setPreview(false); } });
  }

  protected keepExplorerLeft(): void {
    if (this.filesHidden && !document.body.classList.contains('ws-mobile')) { return; }
    try {
      const handler: any = this.shell.leftPanelHandler;
      const left = this.shell.getWidgets('left');
      const explorer = left.find((w: Widget) => /explorer/i.test(w.id));
      const current: Widget | undefined = handler.tabBar?.currentTitle?.owner || handler.state?.currentTitle?.owner;
      if (!explorer) { return; }
      for (const w of left) { if (w !== explorer && !w.isHidden && (assistantOf(w) || /plugin-view-container/i.test(w.id))) { w.hide(); } }
      if (!current || current !== explorer || explorer.isHidden) {
        // Switch the side panel's current widget through its own handler API.
        if (typeof handler.activate === 'function') { handler.activate(explorer.id); }
        else { this.shell.activateWidget(explorer.id); }
      }
    } catch { /* shell not ready */ }
  }

  /**
   * Claude renders its own session header ("Untitled", history, new chat) inside
   * its webview. The webview is same-origin here, so we can hide it from within.
   */
  protected styleClaudeWebview(): void {
    const visit = (doc: Document, depth: number) => {
      if (!doc || depth > 4) { return; }
      try {
        if (doc.head && /\/webview\//.test(doc.location.href) && !doc.getElementById('ws-webview')) {
          const st = doc.createElement('style'); st.id = 'ws-webview';
          st.textContent = '#root > [class^="root_"] > [class^="header_"] [class^="titleGroup_"] { visibility: hidden !important; } #root > [class^="root_"] > [class^="header_"] { height: 34px !important; }';
          doc.head.appendChild(st);
        }
      } catch { /* not ready */ }
      doc.querySelectorAll('iframe').forEach(f => {
        try { const d = (f as HTMLIFrameElement).contentDocument; if (d) { visit(d, depth + 1); } } catch { /* cross-origin */ }
      });
    };
    visit(document, 0);
  }

  protected footerMounted = false;
  /** Running + Settings pinned to the bottom of the left panel, outside the split layout. */
  /** Files shows the tree and nothing else: stock Theia views and any extension-contributed view (e.g. the npm
   *  extension's "NPM Scripts", which appears once a package.json with scripts exists) are closed. */
  protected evictStockParts(container: ViewContainer): void {
    for (const part of container.getParts()) {
      const id = part.wrapped.id || '';
      if (/open-editors|test|outline|timeline|search|plugin-view:/i.test(id) && !/^workspace-/.test(id)) { try { part.wrapped.close(); } catch { /* already gone */ } }
    }
  }

  protected async mountFooter(): Promise<void> {
    try {
      const host = document.getElementById('theia-left-content-panel');
      if (!host) { return; }
      // Restored layouts may have re-created our widgets as container parts: evict them.
      const container = await this.widgets.getOrCreateWidget<ViewContainer>(EXPLORER_CONTAINER).catch(() => undefined);
      if (container) {
        for (const part of container.getParts()) {
          if (/^workspace-(footer-)?(running|settings)/.test(part.wrapped.id)) { try { container.removeWidget(part.wrapped); } catch { /* already gone */ } }
        }
      }
      if (container && !(container as any).__wsEvict) {
        (container as any).__wsEvict = true;
        try { (container as any).onDidChangeTrackableWidgets?.(() => { this.evictStockParts(container); void this.mountFooter(); }); } catch { /* older API */ }
      }
      let footer = document.getElementById('workspace-footer');
      if (!footer) { footer = document.createElement('div'); footer.id = 'workspace-footer'; host.appendChild(footer); }
      // Both live in the sidebar footer: Running (hidden on desktop, it feeds the Preview), then the Settings row right
      // above the profile row (ensureFooterRows appends that last). Settings' menus float on the page (settings-widget).
      for (const [id, target] of [[RUNNING_WIDGET_ID, footer], [SETTINGS_WIDGET_ID, footer]] as [string, HTMLElement][]) {
        const w = await this.widgets.getOrCreateWidget(id);
        if (w.node.parentElement === target) { continue; }
        if (w.isAttached) { Widget.detach(w); }
        Widget.attach(w, target);
      }
      this.ensureFooterRows(footer);
      if (!this.footerMounted) {
        this.footerMounted = true;
        const sync = () => host.style.setProperty('--ws-footer-h', footer!.offsetHeight + 'px');
        new ResizeObserver(sync).observe(footer); sync();
      }
      this.ensureFilesHeader();
    } catch { /* shell not ready */ }
  }

  /** Files is a fixed, always-open section with upload buttons in its header.
   *  Uploads go to the agent (it creates nested dirs, auto-renames clashes); Theia's watcher refreshes the tree. */
  protected ensureFilesHeader(): void {
    const header = document.querySelector<HTMLElement>('#explorer-view-container--files > .theia-view-container-part-header');
    if (!header || header.querySelector('.ws-files-actions')) { return; }
    const actions = document.createElement('div'); actions.className = 'ws-files-actions';
    // [+][hide]: hide-files sits where the files are, at the column's edge; the strip brings them back
    actions.innerHTML = '<button class="ws-add-btn" type="button" title="Add files" aria-label="Add files">+</button>'
      + '<button class="ws-add-btn ws-files-hide" type="button" title="Hide your files" aria-label="Hide your files"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18v14H3zM9 5v14"/></svg></button>'
      + '<div class="ws-add-menu" hidden><button type="button" data-kind="files">Upload files</button><button type="button" data-kind="folder">Upload a folder</button></div>';
    const files = document.createElement('input'); files.type = 'file'; files.multiple = true; files.hidden = true;
    const folder = document.createElement('input'); folder.type = 'file'; folder.multiple = true; folder.hidden = true; folder.setAttribute('webkitdirectory', '');
    for (const input of [files, folder]) { input.onchange = () => { void this.uploadFiles(Array.from(input.files || [])); input.value = ''; }; actions.appendChild(input); }
    const menu = actions.querySelector<HTMLElement>('.ws-add-menu')!;
    const btn = actions.querySelector<HTMLElement>('.ws-add-btn:not(.ws-files-hide)')!;
    actions.querySelector<HTMLElement>('.ws-files-hide')!.onclick = e => { e.preventDefault(); e.stopPropagation(); if (!this.filesHidden) { this.toggleFiles(); } };
    actions.querySelector<HTMLElement>('.ws-files-hide')!.title = 'Hide your files (⌘B)';
    btn.onclick = e => {
      e.preventDefault(); e.stopPropagation();
      menu.hidden = !menu.hidden;
      // fixed, anchored under the button: the header clips overflow
      if (!menu.hidden) { const r = btn.getBoundingClientRect(); menu.style.top = `${Math.round(r.bottom + 6)}px`; menu.style.right = `${Math.round(window.innerWidth - r.right)}px`; }
    };
    menu.querySelectorAll('button').forEach(b => { b.onclick = e => { e.stopPropagation(); menu.hidden = true; (b.dataset.kind === 'folder' ? folder : files).click(); }; });
    document.addEventListener('mousedown', e => { if (!actions.contains(e.target as Node)) { menu.hidden = true; } }, true);
    header.appendChild(actions);
    this.ensureTreeDelete();
  }

  /** A × appears on the hovered row; first click arms it ("Delete?"), second deletes.
   *  Driven by mousemove, not mouseenter/leave: the virtualized tree re-renders rows under the pointer. */
  protected ensureTreeDelete(): void {
    const part = document.querySelector<HTMLElement>('#explorer-view-container--files');
    if (!part || part.querySelector('.ws-tree-del')) { return; }
    const del = document.createElement('button'); del.className = 'ws-tree-del'; del.type = 'button'; del.textContent = '×'; del.title = 'Delete';
    part.appendChild(del);
    let path: string | undefined; let disarm: any;
    const reset = () => { del.classList.remove('armed'); del.textContent = '×'; };
    const hide = () => { if (del.classList.contains('armed')) { return; } del.classList.remove('show'); path = undefined; };
    part.addEventListener('mousemove', e => {
      if ((e.target as HTMLElement).closest('.ws-tree-del')) { return; }
      const row = (e.target as HTMLElement).closest<HTMLElement>('.theia-TreeNode');
      if (!row) { return; }
      const p = row.dataset.wsPath || row.title; // Theia puts the fs path on the row (moved to data-ws-path by stripPathTooltips)
      if (!p) { return; }
      if (p !== path) { reset(); path = p; }
      const r = row.getBoundingClientRect(); const pr = part.getBoundingClientRect();
      del.style.top = `${Math.round(r.top - pr.top + (r.height - 22) / 2)}px`;
      del.setAttribute('aria-label', 'Delete ' + p.split('/').pop());
      del.classList.add('show');
    });
    document.addEventListener('mousemove', e => {
      const pr = part.getBoundingClientRect();
      if (e.clientX < pr.left || e.clientX > pr.right || e.clientY < pr.top || e.clientY > pr.bottom) { hide(); }
    });
    del.addEventListener('click', async e => {
      e.stopPropagation(); e.preventDefault();
      if (!path) { return; }
      if (!del.classList.contains('armed')) { del.classList.add('armed'); del.textContent = 'Delete?'; clearTimeout(disarm); disarm = setTimeout(reset, 2500); return; }
      clearTimeout(disarm);
      const uri = FileUri.create(path);
      try { await this.fileService.delete(uri, { recursive: true, useTrash: false }); } catch { /* gone already or refused */ }
      reset(); del.classList.remove('show'); path = undefined;
    });
  }

  protected async uploadFiles(files: File[]): Promise<void> {
    for (const f of files) {
      const rel = (f as any).webkitRelativePath || f.name;
      try { await fetch('/workspace-api/api/files/upload?path=' + encodeURIComponent(rel), { method: 'POST', body: f }); } catch { /* agent restarting */ }
    }
  }

  /** Below 768px the sidebar is an off-canvas drawer toggled by a ≡ button; desktop is unchanged. */
  protected setupMobile(): void {
    const mq = window.matchMedia('(max-width: 768px)');
    const apply = () => {
      document.body.classList.toggle('ws-mobile', mq.matches);
      if (!mq.matches) { document.body.classList.remove('ws-sidebar-open'); }
      this.fitClaude(); for (const ms of [200, 600]) { setTimeout(() => this.fitClaude(), ms); }
    };
    mq.addEventListener ? mq.addEventListener('change', apply) : (mq as any).addListener(apply);
    if (!document.getElementById('workspace-menu-btn')) {
      const btn = document.createElement('button'); btn.id = 'workspace-menu-btn'; btn.title = 'Files & settings';
      btn.innerHTML = '<span></span><span></span><span></span>';
      btn.onclick = () => document.body.classList.toggle('ws-sidebar-open');
      this.topBar().querySelector('#workspace-tb-menu')!.appendChild(btn);
      const backdrop = document.createElement('div'); backdrop.id = 'workspace-backdrop';
      backdrop.onclick = () => document.body.classList.remove('ws-sidebar-open');
      document.body.appendChild(backdrop);
    }
    apply();
  }

  protected async mountWizard(): Promise<void> {
    try {
      if (localStorage.getItem('ws.wizardDone')) { return; }
      const setup = await (await fetch('/workspace-api/api/setup')).json();
      const pending = Object.values(setup || {}).some((v: any) => !v?.ok);
      if (!pending) { localStorage.setItem('ws.wizardDone', '1'); return; }
      const w = await this.widgets.getOrCreateWidget(WIZARD_WIDGET_ID);
      if (!w.isAttached) { Widget.attach(w, document.body); }
    } catch { /* agent unreachable: skip wizard */ }
  }

  /** Direction A: the assistant card gets its own title row (Claude's extension only shows its logo on the
   *  empty state; OpenCode's panel has its own toolbar, which the row overlays). */
  protected mountClaudeHeader(): void {
    if (this.assistant === 'opencode') { return; }   // our widget paints its own title row (opencode-widget.tsx)
    const host = document.getElementById('theia-right-content-panel');
    if (!host) { setTimeout(() => this.mountClaudeHeader(), 200); return; }
    if (document.getElementById('workspace-claude-head')) { return; }
    const head = document.createElement('div');
    head.id = 'workspace-claude-head';
    head.innerHTML = '<span class="ws-claude-dot" aria-hidden="true"></span><span class="ws-claude-title"></span>';
    head.querySelector('.ws-claude-title')!.textContent = assistantInfo(this.assistant).label;
    host.appendChild(head);
  }

  /** OpenCode: our chat widget (opencode/opencode-widget.tsx), docked into the right card. Created through the
   *  WidgetManager, so a saved layout restores it on reload and `arrange()` moves it right if it landed elsewhere;
   *  re-created if it ever goes away. The widget starts OpenCode's server (through the backend) by itself. */
  protected openCodeStarting = false;
  protected async ensureOpenCodeWidget(): Promise<void> {
    if (this.assistant !== 'opencode' || this.openCodeStarting) { return; }
    this.openCodeStarting = true;
    try {
      const w = await this.widgets.getOrCreateWidget(OPENCODE_WIDGET_ID);
      w.title.closable = false;
      const placed = [...this.shell.getWidgets('right'), ...this.shell.getWidgets('main'), ...this.shell.getWidgets('left')].some(x => x.id === w.id);
      if (!placed) { await this.shell.addWidget(w, { area: 'right' }); }
      this.shell.activateWidget(w.id);
      const again = () => { if (this.assistant === 'opencode') { setTimeout(() => void this.ensureOpenCodeWidget(), 800); } };
      if (!(w as any).__wsWatched) { (w as any).__wsWatched = true; w.disposed.connect(again); }
      await this.arrange();
      for (const ms of [500, 1500, 3000]) { setTimeout(() => { this.keepAssistantRight(); this.fitClaude(); }, ms); }
    } catch (e) {
      console.warn('workspace: could not open the OpenCode widget', e);
    } finally { this.openCodeStarting = false; }
  }

  /** Direction A: one 56px bar across the top on every screen size. Fixed slots so the pieces always land in the
   *  same order: [menu (mobile)] [brand] [Editor|Claude switch (mobile, centred)] … [Open app] [settings]. */
  protected topBar(): HTMLElement {
    let bar = document.getElementById('workspace-topbar');
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'workspace-topbar';
      bar.innerHTML = '<div id="workspace-tb-menu"></div><div id="workspace-tb-brand"></div><div id="workspace-tb-switch"></div>'
        + '<div class="ws-tb-spacer"></div><div id="workspace-tb-chip"></div><div id="workspace-tb-settings"></div>';
      document.body.appendChild(bar);
    }
    return bar;
  }

  /** A shift-reload loads the page with service workers bypassed. Theia serves webview resources through one, so the
   *  Claude pane stays blank (its css/js 404) until a normal reload. The webview frames are same-origin here: if one
   *  has finished loading without a controlling worker, reload once — a plain reload restores the worker. */
  protected guardWebviewServiceWorker(): void {
    const KEY = 'ws.swReload'; let strikes = 0; let ticks = 0;
    const t = setInterval(() => {
      ticks++;
      let controlled = false, uncontrolled = false;
      for (const f of Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe.webview'))) {
        try {
          const w = f.contentWindow; if (!w || !w.location.pathname.includes('/webview/') || !w.navigator.serviceWorker) { continue; }
          if (w.navigator.serviceWorker.controller) { controlled = true; } else if (w.document.readyState === 'complete') { uncontrolled = true; }
        } catch { /* cross-origin endpoint: nothing we can check */ }
      }
      if (controlled) { clearInterval(t); try { sessionStorage.removeItem(KEY); } catch { /* storage off */ } return; }
      if (uncontrolled && ++strikes >= 3) {
        clearInterval(t);
        try { if (sessionStorage.getItem(KEY)) { console.warn('workspace: webview still has no service worker after a reload — giving up'); return; } sessionStorage.setItem(KEY, '1'); } catch { /* storage off */ }
        console.warn('workspace: webview loaded without its service worker (hard refresh?) — reloading once');
        location.reload();
      }
      if (ticks > 45) { clearInterval(t); }
    }, 1000);
  }

  /** The page came back to a *different* backend — the workspace was paused and resumed (auto-pause after 30 quiet
   *  minutes: a locked laptop, lunch), or the pod restarted. Theia's own reconnect then talks to a fresh backend
   *  and plugin host, but the Claude webview keeps showing the old session with no process behind it: the next
   *  message spins on "Synthesizing…" forever and Stop does nothing (user reports 2026-09-15 and 2026-09-23). The
   *  backend's `_status` carries a boot id; when it changes across a reconnect, reload — the conversation is on
   *  disk and Claude resumes it. */
  protected guardBackendSwap(): void {
    let known: string | undefined; let wasOffline = false;
    const bootId = async () => { try { const r = await fetch(`${OPENCODE_BASE}/_status`, { cache: 'no-store' }); return (await r.json()).bootId as string | undefined; } catch { return undefined; } };
    void bootId().then(id => { known = id; });
    this.connection.onStatusChange(s => {
      if (s === ConnectionStatus.OFFLINE) { wasOffline = true; return; }
      if (s !== ConnectionStatus.ONLINE || !wasOffline) { return; }
      wasOffline = false;
      void bootId().then(id => {
        if (!id) { return; }
        if (!known) { known = id; return; }
        if (id === known) { return; }
        console.warn('workspace: reconnected to a different backend (workspace resumed or restarted) — reloading');
        location.reload();
      });
    });
  }

  protected info: { workspace?: string; owner?: string; displayName?: string } = {};
  /** Workspace slug + owner from the agent (WORKSPACE_NAME/OWNER in the pod; folder name in the lab). */
  protected async loadInfo(): Promise<void> {
    try { this.info = await (await fetch('/workspace-api/api/info')).json(); } catch { return; }
    // the brand is plain text: the workspace's name once the agent told us, "Workspaces" until then
    const word = document.querySelector('#workspace-brand-bar .ws-word');
    if (word && this.info.workspace) { word.textContent = this.info.workspace; }
    this.refreshAccountRow();
  }

  /** Sidebar footer below Running: a Terminal row and the account row (opens Settings). */
  protected ensureFooterRows(footer: HTMLElement): void {
    let extra = document.getElementById('workspace-footer-extra');
    if (!extra) {
      extra = document.createElement('div'); extra.id = 'workspace-footer-extra';
      extra.innerHTML = '<button type="button" class="ws-foot-row ws-foot-term"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17l6-6-6-6M12 19h8"/></svg>Terminal</button>'
        + '<button type="button" class="ws-foot-row ws-foot-acct"><span class="ws-avatar"></span><span class="ws-acct-text"><span class="ws-acct-name"></span><span class="ws-acct-sub"></span></span></button>';
      extra.querySelector('.ws-foot-term')!.addEventListener('click', () => { void this.terminalModal.open(); });
      const acctRow = extra.querySelector<HTMLElement>('.ws-foot-acct')!;
      acctRow.addEventListener('click', () => { window.dispatchEvent(new CustomEvent('ws:toggle-accounts', { detail: { anchor: acctRow } })); });
      window.addEventListener('ws:setup-changed', () => this.refreshAccountRow());
      setInterval(() => this.refreshAccountRow(), 15000);
      footer.appendChild(extra);         // attach BEFORE the first refresh: it looks the row up in the document
      void this.refreshAccountRow();
    }
    footer.appendChild(extra); // keep it last (Running is re-attached above it)
  }

  protected async refreshAccountRow(): Promise<void> {
    const row = document.querySelector('#workspace-footer-extra .ws-foot-acct'); if (!row) { return; }
    const setName = (name: string) => {
      row.querySelector('.ws-avatar')!.textContent = name.split(/\s+/).map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();
      row.querySelector('.ws-acct-name')!.textContent = name;
    };
    setName(this.info.displayName || 'You');   // immediately — the account check below can take seconds
    if (!row.querySelector('.ws-acct-sub')!.textContent) { row.querySelector('.ws-acct-sub')!.textContent = 'Checking accounts…'; }
    let setup: any = {}; try { setup = await (await fetch('/workspace-api/api/setup')).json(); } catch { return; /* agent restarting */ }
    const labels: [string, string][] = [['claude', 'Claude'], ['gh', 'GitHub']];
    const on = labels.filter(([k]) => setup[k]?.ok).map(([, l]) => l);
    if (!this.info.displayName && setup.gh?.user) { setName(setup.gh.user); }
    row.querySelector('.ws-acct-sub')!.textContent = on.length ? on.join(' · ') + ' connected' : 'Not signed in yet';
  }

  /** Theia binds ctrl/cmd+V to its own paste command, which in a browser runs document.execCommand('paste') — Chrome
   *  treats that as a scripted clipboard read and shows a "Paste" confirmation bubble the user has to click. When the
   *  focus is in something editable (inputs, Monaco's textarea, xterm) or inside a webview, the browser's native paste
   *  does the job: keep the key away from Theia's dispatcher (window capture runs before document capture). */
  protected nativePaste(): void {
    window.addEventListener('keydown', e => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || (e.key || '').toLowerCase() !== 'v') { return; }
      const t = document.activeElement as HTMLElement | null;
      if (!t) { return; }
      const editable = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable || t instanceof HTMLIFrameElement;
      if (editable) { e.stopImmediatePropagation(); }   // not preventDefault: the native paste is the default action
    }, true);
  }

  /** "Your turn" (#43): when a Claude turn ends (or Claude stops to ask) while the user is away — tab in the
   *  background, or no input for a few seconds — badge the tab title and favicon and pulse the Claude title dot.
   *  Any interaction, or the tab becoming visible, clears it. Busy is read from the (same-origin) webview: the
   *  extension's prompt placeholder says "Queue another message…" while a turn is running. */
  protected watchClaudeTurn(): void {
    let busy = false, attention = false, lastInput = Date.now(), baseTitle = '';
    const favicon = () => document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    const clear = () => {
      if (!attention) { return; }
      attention = false;
      if (baseTitle) { document.title = baseTitle; }
      const l = favicon(); if (l) { l.href = '/favicon.svg'; }
      document.querySelector('.ws-claude-dot')?.classList.remove('ws-attn');
    };
    const raise = () => {
      if (attention) { return; }
      attention = true;
      baseTitle = document.title.replace(/^● /, '');
      document.title = '● ' + baseTitle;
      const l = favicon(); if (l) { l.href = BADGE; }
      document.querySelector('.ws-claude-dot')?.classList.add('ws-attn');
    };
    // The prompt is a contenteditable div two frames deep; its placeholder is an attribute.
    const placeholders = (d: Document, depth: number, out: string[]) => {
      if (depth > 3) { return; }
      for (const e of Array.from(d.querySelectorAll('[placeholder],[aria-placeholder],[data-placeholder]'))) {
        out.push(e.getAttribute('placeholder') || e.getAttribute('aria-placeholder') || e.getAttribute('data-placeholder') || '');
      }
      for (const i of Array.from(d.querySelectorAll('iframe'))) { try { if (i.contentDocument) { placeholders(i.contentDocument, depth + 1, out); } } catch { /* cross-origin */ } }
    };
    const isBusy = (): boolean | undefined => {
      const found: string[] = [];
      for (const f of Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe.webview'))) {
        try { if (f.contentDocument) { placeholders(f.contentDocument, 1, found); } } catch { /* cross-origin */ }
      }
      const prompt = found.filter(t => /Ask Claude|Queue another message|Describe a change/i.test(t));
      if (!prompt.length) { return undefined; }
      return prompt.some(t => /Queue another message/i.test(t));
    };
    const touch = () => { lastInput = Date.now(); clear(); };
    window.addEventListener('pointerdown', touch, true); window.addEventListener('keydown', touch, true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { clear(); } });
    setInterval(() => {
      const b = isBusy(); if (b === undefined) { return; }
      if (busy && !b && (document.hidden || Date.now() - lastInput > 5000)) { raise(); }
      busy = b;
    }, 1000);
  }

  protected mountBrandBar(): void {
    // Top-left of the top bar: no logo, just text — the workspace's name (loadInfo), "Workspaces" until it is known.
    const host = this.topBar().querySelector<HTMLElement>('#workspace-tb-brand')!;
    if (document.getElementById('workspace-brand-bar')) { return; }
    const bar = document.createElement('div');
    bar.id = 'workspace-brand-bar';
    bar.innerHTML = '<span class="ws-word">Workspaces</span>';
    host.appendChild(bar);
    void this.loadInfo();
  }
}
