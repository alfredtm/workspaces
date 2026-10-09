import { injectable } from '@theia/core/shared/inversify';
import { KeybindingContribution, KeybindingRegistry, KeybindingScope } from '@theia/core/lib/browser/keybinding';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { CommonCommands } from '@theia/core/lib/browser/common-frontend-contribution';

const NOOP = 'workspace.noop';
/** Shell users don't get the command palette / quick open / explorer focus chords. */
const LOCKED = ['f1', 'ctrlcmd+shift+p', 'ctrlcmd+p', 'ctrlcmd+shift+e'];

/**
 * Shadow the chords, don't unregister them: Theia's quick-open contributions look up
 * their default keybinding at startup (file-search getKeyCommand → acceleratorFor) and
 * crash with "reading 'resolved'" when it's gone, which logs "Could not start
 * contribution". A USER-scope binding to a no-op wins dispatch and leaves the
 * DEFAULT-scope bindings intact for those lookups.
 */
@injectable()
export class WorkspaceKeybindingContribution implements KeybindingContribution, CommandContribution {
  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand({ id: NOOP }, { execute: () => { /* swallowed on purpose */ } });
    // Ctrl/⌘+A inside the Claude webview: the iframe selects its own textarea natively, then Theia's webview
    // re-dispatches the key to the keybinding registry, which runs core.selectAll = document.execCommand('selectAll')
    // on the *outer* page — prompt, transcript and sidebar all lit up (user report). While focus is inside an
    // iframe the outer select-all has nothing legitimate to do, so this handler takes the command and does nothing.
    // Later-registered handlers win in Theia's CommandRegistry; when focus is not in an iframe it is disabled and
    // the core handler runs as before.
    commands.registerHandler(CommonCommands.SELECT_ALL.id, {
      isEnabled: () => document.activeElement instanceof HTMLIFrameElement,
      execute: () => { /* the webview already selected within itself */ },
    });
  }
  registerKeybindings(registry: KeybindingRegistry): void {
    registry.setKeymap(KeybindingScope.USER, LOCKED.map(keybinding => ({ command: NOOP, keybinding })));
  }
}
