import { injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import React = require('@theia/core/shared/react');

export const RUNNING_WIDGET_ID = 'workspace-footer-running';
const API = '/workspace-api';

/** "Running" — the shell's Open-your-app section, fed by the agent's /api/ports. */
@injectable()
export class RunningWidget extends ReactWidget {
  protected ports: any[] = [];
  protected timer: any;

  @postConstruct()
  protected init(): void {
    this.id = RUNNING_WIDGET_ID;
    this.title.label = 'Running';
    this.title.caption = 'Apps listening in your workspace';
    this.addClass('workspace-running');
    this.poll();
    this.timer = setInterval(() => this.poll(), 3000);
    this.toDispose.push({ dispose: () => clearInterval(this.timer) });
    this.update();
  }

  protected async poll(): Promise<void> {
    try {
      const r = await fetch(`${API}/api/ports`);
      const all = await r.json();
      this.ports = (Array.isArray(all) ? all : []).filter((p: any) => p.reachable);
      this.update();
      // the "Open app" pill (layout contribution) and the Preview listen; keeps one poller for all of them.
      // Cached on window for listeners that mount after a poll (the Preview widget).
      const detail = this.ports.map((p: any) => ({ port: p.port, url: p.openUrl || `${API}/proxy/${p.port}/`, folder: p.folder, name: p.name }));
      (window as any).__wsPorts = detail;
      window.dispatchEvent(new CustomEvent('ws:ports', { detail }));
    } catch { /* agent restarting */ }
  }

  protected render(): React.ReactNode {
    if (!this.ports.length) {
      return <div className="ws-empty">Nothing running yet — ask Claude to start your app.</div>;
    }
    return <div className="ws-list">
      {this.ports.map((p: any) => (
        <a key={p.port} className="ws-row ws-app" target="_blank" rel="noreferrer"
           href={p.openUrl || `${API}/proxy/${p.port}/`}>
          <span className="ws-dot" />
          <span className="ws-label">Open your app{this.ports.length > 1 ? ` (${p.port})` : ''}</span>
          <span className="ws-ext">↗</span>
        </a>
      ))}
    </div>;
  }
}
