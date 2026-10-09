import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';
import { WorkspaceLayoutContribution } from './layout-contribution';
import { RunningWidget, RUNNING_WIDGET_ID } from './running-widget';
import { SettingsWidget, SETTINGS_WIDGET_ID } from './settings-widget';
import { WizardWidget, WIZARD_WIDGET_ID } from './wizard-widget';
import { KeybindingContribution } from '@theia/core/lib/browser/keybinding';
import { CommandContribution } from '@theia/core/lib/common/command';
import { WorkspaceKeybindingContribution } from './keybindings';
import { SplitPositionHandler } from '@theia/core/lib/browser/shell/split-panels';
import { SafeSplitPositionHandler } from './split-position-handler';
import { TerminalModal } from './terminal-modal';
import { PreferenceContribution } from '@theia/core/lib/common/preferences/preference-schema';
import { assistantSchema } from './assistant';
import { OpenCodeWidget, OPENCODE_WIDGET_ID } from './opencode/opencode-widget';
import { OpenCodeEvents } from './opencode/events';
import { PreviewWidget, PREVIEW_WIDGET_ID } from './preview-widget';
import '../../src/browser/style/workspace.css';
import '../../src/browser/style/opencode.css';
import '../../src/browser/style/preview.css';

export default new ContainerModule((bind, unbind, isBound, rebind) => {
  rebind(SplitPositionHandler).to(SafeSplitPositionHandler).inSingletonScope();
  bind(TerminalModal).toSelf().inSingletonScope();
  bind(WorkspaceLayoutContribution).toSelf().inSingletonScope();
  // Settings → Assistant (Claude | OpenCode | Pi), see assistant.ts.
  bind(PreferenceContribution).toConstantValue({ schema: assistantSchema });
  // The Preview overlay over the main area (preview-widget.tsx), toggled from the top bar.
  bind(PreviewWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({ id: PREVIEW_WIDGET_ID, createWidget: () => ctx.container.get(PreviewWidget) })).inSingletonScope();
  bind(FrontendApplicationContribution).toService(WorkspaceLayoutContribution);

  bind(RunningWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: RUNNING_WIDGET_ID,
    createWidget: () => ctx.container.get(RunningWidget),
  })).inSingletonScope();

  bind(WorkspaceKeybindingContribution).toSelf().inSingletonScope();
  bind(KeybindingContribution).toService(WorkspaceKeybindingContribution);
  bind(CommandContribution).toService(WorkspaceKeybindingContribution);
  bind(WizardWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({ id: WIZARD_WIDGET_ID, createWidget: () => ctx.container.get(WizardWidget) })).inSingletonScope();
  bind(SettingsWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: SETTINGS_WIDGET_ID,
    createWidget: () => ctx.container.get(SettingsWidget),
  })).inSingletonScope();
  // The OpenCode assistant card (Settings → Assistant → OpenCode), see opencode/.
  bind(OpenCodeEvents).toSelf().inSingletonScope();
  bind(OpenCodeWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: OPENCODE_WIDGET_ID,
    createWidget: () => ctx.container.get(OpenCodeWidget),
  })).inSingletonScope();
});
