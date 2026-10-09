import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import React = require('@theia/core/shared/react');
import { ACCOUNTS, Account, GuidedFlow } from './guided-flow';
import { ASSISTANT_PREF, Assistant, asAssistant, assistantInfo } from './assistant';

export const WIZARD_WIDGET_ID = 'workspace-wizard';
const API = '/workspace-api';

/** First-run wizard: one guided sign-in per unconnected account, then "Meet <assistant>". The Claude
 *  sign-in is only a step when Claude is the chosen assistant (OpenCode, the default, needs none); it stays in the
 *  profile's accounts menu for anyone who wants it later. */
@injectable()
export class WizardWidget extends ReactWidget {
  @inject(PreferenceService) protected readonly prefs: PreferenceService;
  protected steps: Account[] = [];
  protected idx = 0;
  protected ready = false;
  protected assistant: Assistant = 'opencode';

  @postConstruct()
  protected init(): void {
    this.id = WIZARD_WIDGET_ID; this.addClass('workspace-wizard');
    void this.load();
  }
  protected async load(): Promise<void> {
    await this.prefs.ready;
    this.assistant = asAssistant(this.prefs.get(ASSISTANT_PREF));
    try {
      const setup = await (await fetch(`${API}/api/setup`)).json();
      this.steps = ACCOUNTS.filter(a => !(setup[a.key] && setup[a.key].ok)).filter(a => a.key !== 'claude' || this.assistant === 'claude');
    } catch { this.steps = []; }
    this.ready = true; this.update();
  }
  /** Always reload at the end: the Claude extension only reads ~/.claude credentials at activation, and the
   *  Settings state was captured before the sign-ins — a fresh page is the only state we can trust. */
  protected finish(): void { localStorage.setItem('ws.wizardDone', '1'); location.reload(); }
  protected next(): void { this.idx++; this.update(); }

  protected render(): React.ReactNode {
    if (!this.ready) { return <div className="ws-wizard-card" />; }
    const done = this.idx >= this.steps.length;
    const step = this.steps[this.idx];
    return <div className="ws-wizard-card">
      <h2 className="ws-wizard-title">Welcome to your <span className="g">workspace</span></h2>
      <div className="ws-wizard-steps">
        {this.steps.map((s, i) => <span key={s.key} className={'ws-wizard-step' + (i < this.idx ? ' done' : i === this.idx ? ' active' : '')}>{i < this.idx ? '✓ ' : (i + 1) + '. '}{s.label}</span>)}
        <span className={'ws-wizard-step' + (done ? ' active' : '')}>{this.steps.length + 1}. Meet {assistantInfo(this.assistant).label}</span>
      </div>
      <div className="ws-wizard-body">
        {done
          ? <div className="ws-wizard-done"><div className="ws-wizard-emoji">🎉</div><p className="ws-done">You’re all set!</p><p className="ws-muted">One quick refresh and {assistantInfo(this.assistant).label} is ready in the chat, next to your files.</p></div>
          : <div><p className="ws-wizard-desc">{step.desc}</p><GuidedFlow key={step.key} account={step} onDone={() => setTimeout(() => this.next(), 1200)} /></div>}
      </div>
      <div className="ws-wizard-foot">
        {done ? <button className="ws-primary" onClick={() => this.finish()}>Start building →</button>
              : <button className="ws-quiet" onClick={() => this.next()}>Skip for now</button>}
      </div>
    </div>;
  }
}
