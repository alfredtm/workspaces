import { injectable } from '@theia/core/shared/inversify';
import { SplitPositionHandler } from '@theia/core/lib/browser/shell/split-panels';

/**
 * Theia's sash animation dereferences `layout.handles[move.index]`; when a side panel
 * (e.g. the empty bottom panel) has no live sash this throws 'reading offsetTop' once
 * per session. Bail out cleanly instead — the move then just ends at its target.
 */
@injectable()
export class SafeSplitPositionHandler extends SplitPositionHandler {
  /** Skip animating panels that aren't visible (Theia would reject with 'Panel is not visible.'). */
  override setSidePanelSize(sidePanel: any, targetSize: number, options: any): Promise<number> {
    if (!sidePanel || !sidePanel.parent || sidePanel.isHidden || !sidePanel.isVisible || options?.referenceWidget?.isHidden) { return Promise.resolve(targetSize); }
    return super.setSidePanelSize(sidePanel, targetSize, options);
  }

  /** The move can be rejected later ('Panel is not visible.') if the panel hides mid-animation;
   *  Theia's callers handle it, but the bare promise still surfaces as an unhandled rejection. */
  override moveSplitPos(move: any): Promise<number> {
    const p = super.moveSplitPos(move);
    p.catch(() => { /* handled: panel hidden during animation */ });
    return p;
  }

  protected override getCurrentPosition(move: any): number | undefined {
    const layout: any = move?.parent?.layout;
    if (!layout || !layout.handles || !layout.handles[move.index]) { return undefined; }
    return super.getCurrentPosition(move);
  }
}
