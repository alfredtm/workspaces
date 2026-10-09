import { ContainerModule } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common';
import { AgentProxy } from './agent-proxy';
import { OpenCodeServer } from './opencode-server';
import { OpenCodeEventsServerImpl } from './opencode-events-server';
import { OPENCODE_EVENTS_PATH, OpenCodeEventsClient } from '../common/opencode-events';

export default new ContainerModule(bind => {
  bind(AgentProxy).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(AgentProxy);
  // `opencode serve` for the OpenCode assistant card, proxied same-origin (see opencode-server.ts).
  bind(OpenCodeServer).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(OpenCodeServer);
  // OpenCode's event bus over Theia's WebSocket (one relay per frontend connection) — see common/opencode-events.ts.
  bind(OpenCodeEventsServerImpl).toSelf();
  bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler<OpenCodeEventsClient>(OPENCODE_EVENTS_PATH, client => {
    const server = ctx.container.get(OpenCodeEventsServerImpl);
    server.setClient(client);
    client.onDidCloseConnection(() => server.dispose());
    return server;
  })).inSingletonScope();
});
