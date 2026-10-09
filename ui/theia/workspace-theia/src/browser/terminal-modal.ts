import { injectable, inject } from '@theia/core/shared/inversify';
import { Widget } from '@theia/core/shared/@lumino/widgets';
import { MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';

/**
 * The "plain terminal": one terminal in a popup above everything, opened
 * on demand and hidden (not killed) on Close. Nothing terminal-shaped ever lands
 * in Theia's bottom panel — any TerminalWidget the shell adds is adopted here.
 */
@injectable()
export class TerminalModal {
  @inject(TerminalService) protected readonly terminals: TerminalService;
  protected root?: HTMLElement;
  protected body?: HTMLElement;
  protected current?: TerminalWidget;
  protected readonly startedAt = Date.now();
  protected pendingOpen = false;

  /** Open the popup with the existing terminal, or a fresh one if none is alive. */
  async open(): Promise<void> {
    if (!this.current || this.current.isDisposed) {
      this.pendingOpen = true;
      const t = await this.terminals.newTerminal({ title: 'Terminal' });
      await t.start();
      this.adopt(t);
    }
    this.show();
  }

  /** Take a terminal widget out of wherever Theia put it (bottom panel) and show it here. */
  adopt(widget: TerminalWidget): void {
    // Theia restores last session's terminals at boot (and reconnects a fresh shell for each);
    // a popup nobody asked for must not appear on every reload — drop those.
    if (!this.pendingOpen && Date.now() - this.startedAt < 15000) { widget.dispose(); return; }
    this.pendingOpen = false;
    if (this.current && this.current !== widget && !this.current.isDisposed) { this.current.dispose(); }
    this.current = widget;
    this.ensureDom();
    if (widget.parent) { widget.parent = null; } // detach from the dock layout without disposing
    else if (widget.isAttached) { Widget.detach(widget); }
    Widget.attach(widget, this.body!);
    widget.addClass('ws-term-widget');
    widget.onTerminalDidClose(() => { if (this.current === widget) { this.current = undefined; this.hide(); } });
    widget.disposed.connect(() => { if (this.current === widget) { this.current = undefined; this.hide(); } });
    this.show();
  }

  show(): void {
    this.ensureDom();
    this.root!.classList.add('open');
    document.body.classList.add('ws-term-open');
    this.fit();
    requestAnimationFrame(() => { this.fit(); this.current?.activate(); });
  }

  hide(): void {
    this.root?.classList.remove('open');
    document.body.classList.remove('ws-term-open');
  }

  toggle(): void { this.root?.classList.contains('open') ? this.hide() : void this.open(); }

  protected fit(): void {
    if (this.current && !this.current.isDisposed) { MessageLoop.sendMessage(this.current, Widget.ResizeMessage.UnknownSize); }
  }

  protected ensureDom(): void {
    if (this.root) { return; }
    const root = document.createElement('div'); root.id = 'workspace-terminal-modal'; root.className = 'ws-term-backdrop';
    root.innerHTML = '<div class="ws-term-modal" role="dialog" aria-label="Terminal"><div class="ws-term-head"><strong>Terminal</strong>'
      + '<span class="ws-muted ws-small">Close keeps it running</span><button class="ws-quiet ws-term-close">Close</button></div><div class="ws-term-body"></div></div>';
    root.addEventListener('mousedown', e => { if (e.target === root) { this.hide(); } });
    root.querySelector('.ws-term-close')!.addEventListener('click', () => this.hide());
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && root.classList.contains('open') && !e.defaultPrevented) { this.hide(); } }, true);
    window.addEventListener('resize', () => { if (root.classList.contains('open')) { this.fit(); } });
    document.body.appendChild(root);
    this.root = root; this.body = root.querySelector('.ws-term-body') as HTMLElement;
  }
}
