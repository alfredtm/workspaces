import { Widget } from '@theia/core/lib/browser';
import { PreferenceSchema } from '@theia/core/lib/common/preferences/preference-schema';

/**
 * The assistant card (next to Your files) is one of these:
 *   - OpenCode (the default) — our own chat widget (opencode/opencode-widget.tsx) over a headless `opencode serve`
 *     the editor backend runs (src/node/opencode-server.ts). Models come from the inference providers the pod
 *     gets as LLM_* env from the optional `workspace-inference` Secret (images/workspace/opencode-config.sh →
 *     OPENCODE_CONFIG). No extension is involved: the only OpenCode VS Code extensions are a dead "Beta" iframe
 *     wrapper and a terminal launcher, and the TUI in a Theia terminal (the previous approach) fought the terminal
 *     at every turn.
 *   - Claude Code — the VS Code extension in plugins/claude-code; the user signs in with their Claude seat (the
 *     profile's accounts menu; the first-run wizard only asks when Claude is the chosen assistant).
 *   - Pi (beta) — see below.
 * The choice is the ASSISTANT_PREF preference (User scope → ~/.theia/settings.json, so it follows the
 * PVC), picked in Settings → Assistant; switching reloads. Claude's extension stays loaded either way; the
 * layout shows the chosen assistant on the right and keeps the other out of sight.
 */
/** 'pi' (beta): the OpenCode widget over Pi's server (services/pi: OpenCode's API on Pi Durable) — the editor backend
 *  starts it and routes the OpenCode proxy to it while this is the pick (src/node/opencode-server.ts). */
export type Assistant = 'claude' | 'opencode' | 'pi';
/** What the OpenCode widget calls its assistant in the UI: "Pi" while Pi drives it (body.ws-assistant-pi). */
export function agentName(): string { return document.body.classList.contains('ws-assistant-pi') ? 'Pi' : 'OpenCode'; }
/** The assistant whose widget shows: Pi reuses the OpenCode widget. */
export function widgetKind(a: Assistant): 'claude' | 'opencode' { return a === 'claude' ? 'claude' : 'opencode'; }
/** Also read by src/node/opencode-server.ts (piChosen) and services/shell/agent.js. */
export const ASSISTANT_PREF = 'workspace.assistant';
/** OpenCode on your inference provider's models is the default: no sign-in needed. Claude stays one switch away
 *  (Settings → Assistant), with its sign-in under the profile. An explicit choice in settings.json is kept. */
export const DEFAULT_ASSISTANT: Assistant = 'opencode';

export interface AssistantInfo { id: Assistant; label: string; desc: string; }
export const ASSISTANTS: AssistantInfo[] = [
  { id: 'opencode', label: 'OpenCode', desc: 'OpenCode on your inference provider’s models. No sign-in needed.' },
  { id: 'claude', label: 'Claude', desc: 'Claude Code, on your own Claude seat (sign in under your profile).' },
  { id: 'pi', label: 'Pi', desc: 'Pi (beta) on your inference provider’s models. Fast, and picks up where it stopped after a restart.' },
];

/** Widget id of the OpenCode chat (opencode/opencode-widget.tsx; created by the layout, never by the user). */
export const OPENCODE_WIDGET_ID = 'workspace-opencode';

export const assistantSchema: PreferenceSchema = {
  properties: {
    [ASSISTANT_PREF]: {
      type: 'string',
      enum: ['claude', 'opencode', 'pi'],
      default: DEFAULT_ASSISTANT,
      description: 'The AI assistant shown on the right of the workspace: Claude Code, OpenCode or Pi.',
    },
  },
};

export function asAssistant(v: unknown): Assistant {
  // an explicit choice either way wins; anything else (unset, garbage) is the default
  return v === 'claude' || v === 'opencode' || v === 'pi' ? v : DEFAULT_ASSISTANT;
}

export function assistantInfo(a: Assistant): AssistantInfo {
  return ASSISTANTS.find(x => x.id === a) || ASSISTANTS[0];
}

/**
 * Which assistant a shell widget belongs to, if any. Claude's views carry "claude" in their ids
 * (plugin-view-container:claude-sidebar, plugin-view:claudeVSCodeSidebar…); OpenCode is our own widget,
 * recognised by id.
 */
export function assistantOf(w: Widget): Assistant | undefined {
  const id = w.id || '';
  const viewType = String((w as any).viewType || '');
  if (/claude/i.test(id) || /claude/i.test(viewType)) { return 'claude'; }
  if (id === OPENCODE_WIDGET_ID) { return 'opencode'; }
  return undefined;
}
