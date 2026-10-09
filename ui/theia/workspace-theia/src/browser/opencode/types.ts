/**
 * Two vocabularies:
 *   OC*  — OpenCode's wire types (1.18), the subset the card reads. Hand-copied from @opencode-ai/sdk's
 *          types.gen.d.ts so the editor bundle does not depend on the SDK (a generated fetch client we don't need).
 *   Turn / Block — what the chat renders. A user message is a turn; the assistant messages answering it (OpenCode
 *          splits a reply into several messages, all with the same parentID) fold into one assistant turn made of
 *          blocks: text, tool calls, questions, permission asks, errors.
 */

// ── OpenCode wire types ────────────────────────────────────────────────────

export interface OCSession {
  id: string; projectID: string; directory: string; parentID?: string; title: string; version: string;
  time: { created: number; updated: number };
  /** set while the session is rewound to before this message (/undo); cleared by /redo or the next message */
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string };
}
export interface OCError { name: string; data?: { message?: string; [k: string]: unknown } }
export interface OCUserMessage {
  id: string; sessionID: string; role: 'user'; time: { created: number };
  agent?: string; model?: { providerID: string; modelID: string };
}
export interface OCAssistantMessage {
  id: string; sessionID: string; role: 'assistant'; time: { created: number; completed?: number };
  error?: OCError; parentID: string; modelID: string; providerID: string; mode: string; finish?: string;
  /** set on the summary /compact (or an automatic compaction) writes; its mode is `compaction` */
  summary?: boolean;
}
export type OCMessage = OCUserMessage | OCAssistantMessage;

export type OCToolState =
  | { status: 'pending'; input: Record<string, unknown>; raw?: string }
  | { status: 'running'; input: Record<string, unknown>; title?: string; metadata?: Record<string, unknown>; time: { start: number } }
  | { status: 'completed'; input: Record<string, unknown>; output: string; title: string; metadata: Record<string, unknown>; time: { start: number; end: number } }
  | { status: 'error'; input: Record<string, unknown>; error: string; metadata?: Record<string, unknown>; time: { start: number; end: number } };

/** Every part has these; `type` decides the rest (text, reasoning, tool, step-start, step-finish, snapshot, patch,
 *  agent, retry, compaction, subtask, file, permission). The mapper casts per type. */
export interface OCPart { id: string; sessionID: string; messageID: string; type: string; [k: string]: unknown }
export interface OCTextPart extends OCPart { type: 'text'; text: string; synthetic?: boolean; ignored?: boolean; time?: { start: number; end?: number } }
export interface OCReasoningPart extends OCPart { type: 'reasoning'; text: string; time: { start: number; end?: number } }
export interface OCToolPart extends OCPart { type: 'tool'; callID: string; tool: string; state: OCToolState }

export interface OCPermission {
  id: string; type: string; pattern?: string | string[]; sessionID: string; messageID: string; callID?: string;
  title: string; metadata: Record<string, unknown>; time: { created: number };
}
/** OpenCode ≥1.18.30's permission ask (`permission.asked`, GET /permission): what the tool wants to do, the
 *  patterns it covers, `always` = what "always allow" would remember, `metadata.command` for bash. */
export interface OCPermissionRequest {
  id: string; sessionID: string; permission: string; patterns: string[]; metadata: Record<string, unknown>; always: string[];
  tool?: { messageID: string; callID: string };
}
export interface OCQuestionOption { label: string; description?: string }
export interface OCQuestionInfo { question: string; header: string; options: OCQuestionOption[]; multiple?: boolean; custom?: boolean }
/** One `question` tool call waiting for the user; `tool` ties it to the tool part (by callID). */
export interface OCQuestionRequest { id: string; sessionID: string; questions: OCQuestionInfo[]; tool?: { messageID: string; callID: string } }
export type OCSessionStatus = { type: 'idle' } | { type: 'busy' } | { type: 'retry'; attempt: number; message: string; next: number };

export type OCEvent =
  | { type: 'message.updated'; properties: { info: OCMessage } }
  | { type: 'message.part.updated'; properties: { part: OCPart; delta?: string } }
  | { type: 'message.removed'; properties: { sessionID: string; messageID: string } }
  | { type: 'permission.updated'; properties: OCPermission }
  | { type: 'permission.replied'; properties: { sessionID: string; permissionID?: string; requestID?: string; response?: string; reply?: string } }
  | { type: 'permission.asked'; properties: OCPermissionRequest }
  | { type: 'session.status'; properties: { sessionID: string; status: OCSessionStatus } }
  | { type: 'session.idle'; properties: { sessionID: string } }
  | { type: 'session.error'; properties: { sessionID?: string; error?: OCError } }
  | { type: 'session.created' | 'session.updated' | 'session.deleted'; properties: { info: OCSession } }
  | { type: 'question.asked'; properties: OCQuestionRequest }
  | { type: 'question.replied'; properties: { sessionID: string; requestID: string; answers: string[][] } }
  | { type: 'question.rejected'; properties: { sessionID: string; requestID: string } }
  | { type: 'server.connected'; properties?: unknown };

/** A slash command the server knows: custom commands (opencode.json / .opencode/command) and skills. */
export interface OCCommand { name: string; description?: string; agent?: string; model?: string; source?: string }
export interface OCMessageWithParts { info: OCMessage; parts: OCPart[] }
/** `capabilities.input.image` (OpenCode ≥1.18; the config's `modalities` / `attachment`) is what decides whether
 *  the card offers attaching images for this model. */
export interface OCModel {
  id: string; name: string; capabilities?: { attachment?: boolean; input?: { image?: boolean } };
  /** OpenCode's model variants (opencode-config.sh writes low | medium | high | max); the card's Thinking choice */
  variants?: Record<string, unknown>;
}
/** An image the user attaches; sent to OpenCode as a `file` part with a data URL. */
export interface Attachment { id: string; name: string; mime: string; url: string }
export interface OCProvider { id: string; name: string; models: Record<string, OCModel> }
export interface OCProvidersResponse { providers: OCProvider[]; default: Record<string, string> }

// ── The chat's own vocabulary ──────────────────────────────────────────────

export type SessionStatus = 'idle' | 'busy' | 'retry';

export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  blocks: Block[];
  /** ms since epoch (OpenCode's `time.created`) */
  createdAt: number;
  /** the model that answered, `provider/model`, on assistant turns */
  model?: string;
}

export type Block = TextBlock | ToolBlock | QuestionBlock | PermissionBlock | ErrorBlock | ImageBlock | CompactionBlock;
/** The summary a compaction wrote: one quiet "Conversation compacted" line, the summary a click away. */
export interface CompactionBlock { type: 'compaction'; id: string; text: string; streaming: boolean }
/** An image in a user turn (an OpenCode `file` part with an image mime). */
export interface ImageBlock { type: 'image'; id: string; url: string; name: string }

export interface TextBlock { type: 'text'; id: string; text: string; streaming?: boolean }
export type ToolStatus = 'pending' | 'running' | 'completed' | 'error';
export interface ToolBlock {
  type: 'tool'; id: string; tool: string; title: string; status: ToolStatus;
  input?: string; output?: string; diff?: string; files?: string[];
}
/** The `question` tool: one card, one or more questions, answered through OpenCode's question API (not as a
 *  chat message — the turn is blocked until the tool gets its answer). `requestId` arrives with `question.asked`
 *  (or GET /question after a reload); `callID` is how the tool part and the request find each other. */
export interface QuestionBlock {
  type: 'question'; id: string; callID?: string; requestId?: string; questions: OCQuestionInfo[];
  status: 'pending' | 'answered' | 'rejected';
  /** selected labels per question, once answered */
  answers?: string[][];
  /** history only: what the tool recorded as its output */
  note?: string;
}
export interface PermissionBlock {
  type: 'permission'; id: string; permissionId: string; kind: string; title: string; pattern?: string;
  /** bash: the command waiting to run */
  command?: string;
  /** bash: the model's own one-line description of the command, when it gave one */
  description?: string;
  status: 'pending' | 'allowed' | 'rejected';
}
export interface ErrorBlock { type: 'error'; id: string; message: string }

export interface Thinking { turnId: string; since: number; tail: string }

export interface ModelOption {
  /** `<providerID>/<modelID>` */
  id: string;
  label: string;
  provider: string;
  providerID: string;
  modelID: string;
  /** takes images (the model reports image input, or matches the provider's LLM_IMAGES) */
  images: boolean;
  /** the Thinking levels this model offers (its variants, in EFFORTS order) */
  efforts: string[];
}
