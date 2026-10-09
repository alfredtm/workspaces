import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { RpcProxy } from '@theia/core/lib/common/messaging/proxy-factory';
import { OPENCODE_EVENTS_PATH, OpenCodeEventsClient, OpenCodeEventsServer, OpenCodeStreamState } from '../../common/opencode-events';
import { OCEvent } from './types';

interface Follower { onEvent: (ev: OCEvent) => void; onState: (s: OpenCodeStreamState) => void }

/**
 * Frontend side of the OpenCode event relay (see ../../common/opencode-events.ts): each tab of the card follows
 * its project folder here and gets OpenCode's events pushed over Theia's WebSocket — background tabs too, so
 * their status (working / needs you / done) stays live. When that connection drops and comes back (Theia
 * reconnects by itself), every folder is subscribed again on the new backend instance and each tab sees
 * `error` → `open`, which is its cue to reload its session.
 */
@injectable()
export class OpenCodeEvents implements OpenCodeEventsClient {
  @inject(WebSocketConnectionProvider) protected readonly connections: WebSocketConnectionProvider;

  protected server: RpcProxy<OpenCodeEventsServer>;
  protected followers = new Map<string, Follower>();

  @postConstruct()
  protected init(): void {
    this.server = this.connections.createProxy<OpenCodeEventsServer>(OPENCODE_EVENTS_PATH, this);
    this.server.onDidCloseConnection(() => { for (const f of this.followers.values()) { f.onState('error'); } });
    this.server.onDidOpenConnection(() => { for (const dir of this.followers.keys()) { void this.server.subscribe(dir); } });
  }

  /** Follow one folder's event bus; the returned function stops following it. One follower per folder (a tab). */
  follow(directory: string, onEvent: (ev: OCEvent) => void, onState: (s: OpenCodeStreamState) => void): () => void {
    const me: Follower = { onEvent, onState };
    this.followers.set(directory, me);
    void this.server.subscribe(directory);
    return () => {
      if (this.followers.get(directory) !== me) { return; }
      this.followers.delete(directory);
      void this.server.unsubscribe(directory);
    };
  }

  // ── RPC notifications from the backend ─────────────────────────────────────
  onEvent(directory: string, event: unknown): void { this.followers.get(directory)?.onEvent(event as OCEvent); }
  onState(directory: string, state: OpenCodeStreamState): void { this.followers.get(directory)?.onState(state); }
}
