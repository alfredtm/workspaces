# Pi (beta) — the editor's third assistant

Settings → Assistant offers **OpenCode | Claude | Pi**. Pi is [Pi Durable](https://github.com/earendil-works/pi)
(MIT, Earendil) on the same models as OpenCode, behind the **same chat card**: `server.mjs` speaks the part of
OpenCode's HTTP API the card uses (`ui/theia/workspace-theia/src/browser/opencode/client.ts`) plus its `/event`
stream, so the card does not know which one it talks to.

- **Started by the editor.** While `workspace.assistant` is `pi`, the editor backend starts
  `node /opt/pi/server.mjs` (`PI_NODE`, `PI_SERVER`) on `127.0.0.1:$PI_PORT` (4099) and routes `/opencode-api`
  there instead of to `opencode serve` (`OPENCODE_PORT`, 4097).
- **Durable.** Every model turn and tool call is committed to SQLite in `$PI_DATA` (default `~/.local/share/pi/`,
  on the workspace volume) before the card sees it. A pause, a crash or a restart mid-run continues where it
  stopped — an approval card still waiting comes back by itself.
- **Same models, same rules as OpenCode.** `models.mjs` reads the `LLM_*` endpoints exactly like
  `images/workspace/opencode-config.sh` (provider ids `llm`, `llm-2`, …; any OpenAI-compatible server);
  `rules.mjs` asks before the same shell commands (`permission.bash` from `$OPENCODE_CONFIG` when present).
  "Yes, for this project" is remembered in `approvals.json`.
- **Same brief.** The prompt carries OpenCode's platform brief and skill (`images/workspace/dotfiles/opencode/`,
  `/etc/opencode-defaults` in the image, `OPENCODE_DEFAULTS` to point elsewhere), plus the folder's own `AGENTS.md`.

Not in the beta yet: slash commands, undo/redo, question cards, MCP servers (the card shows "… is not in Pi (beta)
yet").

```bash
cd services/pi && npm ci && npm test        # Node >= 22.19
```

The lab (`ui/theia/lab.sh`) fetches a Node 22 into `ui/theia/state/` for Pi (Theia itself runs on Node 20) and keeps
Pi's data in `ui/theia/state/pi`.
