import { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

/**
 * OpenCode's event bus, delivered over Theia's own WebSocket instead of a browser EventSource.
 *
 * Why: the editor is reached through an edge proxy that caps every plain HTTP response at 15 s. A
 * server-sent-events stream is one long response, so the OpenCode card's `/event` subscription was cut
 * every 15 s (measured: OpenCode logged "event connected" every ~21 s for the life of a session) and
 * whatever OpenCode emitted while the browser reconnected never arrived. WebSockets are exempt from
 * that cap — Theia's own RPC connection runs on one for hours — so the backend follows OpenCode's SSE
 * on localhost, where nothing cuts it, and relays each event to the browser as an RPC notification.
 *
 * One server instance per frontend connection (Theia creates it in the connection handler); it follows one
 * stream per project folder the card has a tab for. When Theia's connection drops and comes back, the
 * frontend re-subscribes every folder.
 */
export const OPENCODE_EVENTS_PATH = '/services/workspace-opencode-events';

export const OpenCodeEventsServer = Symbol('OpenCodeEventsServer');
export interface OpenCodeEventsServer extends RpcServer<OpenCodeEventsClient> {
  /** Also follow this project folder's event bus (following it already is a no-op). */
  subscribe(directory: string): Promise<void>;
  /** Stop following one folder — or all of them without an argument. */
  unsubscribe(directory?: string): Promise<void>;
}

export type OpenCodeStreamState = 'open' | 'error';

export interface OpenCodeEventsClient {
  onEvent(directory: string, event: unknown): void;
  /** `open` once the backend is attached to OpenCode's stream, `error` when it lost it (it retries by itself). */
  onState(directory: string, state: OpenCodeStreamState): void;
}
