# theia — the workspace editor

An Eclipse Theia browser app that hosts the **real Claude Code VS Code extension** (plus our own OpenCode / Pi chat)
in a calm, card-based layout designed for non-technical users. `services/shell/agent.js` stays the backend: the
`workspace-theia` extension proxies `/workspace-api/*` (HTTP + websocket) to it for ports, guided sign-ins, secrets,
uploads and workspace info.

## What the user sees

- **Top bar** (56px, every screen size): the workspace's name as plain text (from `GET /workspace-api/api/info`;
  "Workspaces" until it is known — no logo), the **Preview** toggle (the **Open app** pill on phones), and the
  **gear** — preferences: theme (Light / Dark / Navy), **Assistant (OpenCode | Claude | Pi)**, Secrets & variables,
  Terminal. On phones the bar also holds the menu button and the Editor | assistant switch.
- **Three cards** on a near-black page (no hairlines in dark; a hairline overlay in light): **Your files**
  (tree, `+` upload, hover `×` delete, and the **profile row** — avatar, owner, connected accounts; opens the
  accounts menu), the **assistant**, and the **editor** (pill tabs, one file at a time, no line numbers, no
  splitting, no minimap) with the **Preview** overlay (`preview-widget.tsx`: the running app or an HTML page the
  assistant wrote, over the whole main area).
- **Assistant toggle** (`assistant.ts`, User scope → `~/.theia/settings.json`): the assistant card is either **our
  own OpenCode chat** (default; `workspace-theia/src/browser/opencode/`, a Theia `ReactWidget`), the Claude Code
  extension, or **Pi** (beta: the same chat widget over `services/pi`, which speaks OpenCode's API). The OpenCode
  chat is built over OpenCode's HTTP API instead of its terminal UI: the editor backend
  (`src/node/opencode-server.ts`) starts one headless `opencode serve` on `127.0.0.1:4097` (reused if already up) —
  or Pi's server on `127.0.0.1:4099` while Pi is the pick — and proxies it same-origin, including the `/event`
  stream, which reaches the browser over Theia's own WebSocket (`common/opencode-events.ts`). The widget passes
  `directory=<workspace folder>` on every call (OpenCode's server is multi-project). Chat model: user message =
  turn, the assistant messages answering it (same `parentID`) fold into one turn of blocks — text (markdown-it +
  DOMPurify), tool calls as one folding activity card, permission asks, questions, errors, the live thought while
  the model reasons. Sessions are OpenCode's own: the card resumes the last one it showed (per folder,
  localStorage), "New chat" is a draft until the first message, the clock lists the others; project tabs are
  top-level folders. The model chip picks among your inference provider's models. A follow-up typed while a turn
  runs is queued and sent on idle. Claude's views are never closed while another assistant is chosen (one shared
  webview) — just hidden. Switching assistant writes the preference and reloads.
- **Inference**: OpenCode and Pi read the provider config the pod entrypoint (or `run.sh` in the lab) generates
  from the `LLM_*` environment (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODELS`, optional `LLM_LABEL`, `LLM_CONTEXT`,
  `LLM_OUTPUT`, `LLM_REASONING`, `LLM_IMAGES`; numbered `LLM_2_*`… for more providers) with
  `images/workspace/opencode-config.sh`, exported as `OPENCODE_CONFIG`. Any OpenAI-compatible endpoint works;
  providers show up as `llm`, `llm-2`, …. The backend strips API keys and headers from OpenCode's `/config` and
  `/provider` answers before the browser sees them.
- First run: a wizard for the GitHub sign-in (and Claude's, when Claude is the chosen assistant) —
  `guided-flow.tsx`; sign-in URLs are allow-listed in `SIGNIN_HOSTS` (Claude Code signs in on `claude.com`).
- Themes: `plugins/workspaces-theme/themes/*.json` for Monaco + the webview (ids `workspaces-dark` (default),
  `workspaces-navy`, `workspaces-light`; labels Dark / Navy / Light), CSS variable sets in `workspace.css`
  (`:root` = Dark, `body.ws-theme-navy`, `body.ws-theme-light` = "Paper"); `syncThemeClass()` mirrors
  `workbench.colorTheme` onto `<body>`.

## Layout of this directory

- `package.json` — the Theia app: deps pinned to one Theia version, **frontend preferences baked in** (theme,
  `editor.lineNumbers: off`, `editor.minimap.enabled: false`, `editor.padding.top`, `chat.fontSize`, workspace
  trust off…), `theiaPlugins` (builtin pack, python, go, yaml) + `theiaPluginsExcludeIds`.
- `workspace-theia/src/browser/` — the extension's frontend (`workspace-frontend-module.ts` binds it all):
  - `layout-contribution.ts` — the layout brain: top bar slots, card sizing (`fitClaude`), mobile single
    pane + relayout, brand + Claude title, footer rows, Files header and strip, hover-delete, path-tooltip
    stripping, editor tab captions cleared (Theia's tab hover shows the fs path), hard-refresh recovery
    (`guardWebviewServiceWorker`), reload after a backend swap (`guardBackendSwap`), native paste (`nativePaste`),
    terminal adoption into the popup.
  - `settings-widget.tsx` (gear = preferences, profile row = accounts via `ws:toggle-accounts`),
    `running-widget.tsx` (ports → `ws:ports` event → Preview / Open app), `preview-widget.tsx`,
    `wizard-widget.tsx`, `guided-flow.tsx`, `terminal-modal.ts`, `keybindings.ts` (shadows F1 / palette /
    quick-open), `split-position-handler.ts`, `style/workspace.css`, `style/preview.css`.
  - `opencode/` — the OpenCode card: `opencode-widget.tsx` (the widget: boot, project tabs, sessions, model chip,
    composer), `chat.ts` (one session's turns/blocks from stored messages + the event stream), `client.ts` (the
    HTTP calls through the proxy), `events.ts` (the event relay's frontend), `components.tsx` (turn, activity card,
    tool rows, permission/question cards, composer), `style/opencode.css` (on the `--ws-*` variables, scoped
    `.oc-*`).
- `workspace-theia/src/node/` — the extension's backend (`workspace-backend-module.ts`):
  - `agent-proxy.ts` — `/workspace-api` proxy to the agent (`AGENT_PORT`, default 13338), favicon.
  - `opencode-server.ts` — owns `opencode serve` (:4097) or Pi's server (:4099) and proxies the card's calls.
  - `opencode-events-server.ts` — follows OpenCode's `/event` stream per folder and relays it over RPC.
- `plugins/workspaces-theme` — the three colour themes. `plugins/claude-code` and `plugins/material-icon-theme` are
  fetched from Open VSX by `fetch-plugins.sh` (versions in `../../versions.txt`) and gitignored.
- `patch-claude.mjs` — post-unpack patches for the Claude extension, idempotent, run by `fetch-plugins.sh`:
  font CSP, "Browse the web" off, terminal banner hidden, webview cosmetics (prompt radius, bubbles, light
  hairline), no path tooltips, plain-language placeholder and tips. Each patch logs "nothing to do" when the
  extension's shape changed — check after every version bump.

## Build and run

Build (what the image does, via `images/workspace/build-theia.sh`): `npm ci && bash fetch-plugins.sh && npm run build`
→ `workspace-theia/lib/` (tsc), `lib/` + `src-gen/` (theia build).
Typecheck only: `npm ci --ignore-scripts && npx tsc -p workspace-theia --noEmit`.
Run: `node lib/backend/main.js --hostname 127.0.0.1 --port 13337 --plugins=local-dir:plugins <folder>` with
`THEIA_WEBVIEW_EXTERNAL_ENDPOINT='{{hostname}}'` (webviews must be same-origin) and `AGENT_PORT=13338`.
Native modules are ABI-bound to the Node that ran `npm ci`, so the image ships the build stage's Node alongside
the app (`/opt/theia/bin/node`).

Environment the editor backend reads: `AGENT_PORT` (agent.js, default 13338), `PI_NODE` / `PI_SERVER` (default
`node` / `/opt/pi/server.mjs`), `PI_PORT` (default 4099; passed on to Pi together with the inherited `PI_DATA`),
`OPENCODE_PORT` (default 4097), `WS_ROOT` (lab: the workspace folder), `OPENCODE_CONFIG` and the `LLM_*`
keys (inherited by `opencode serve`).

## Local lab

`./lab.sh` → http://localhost:3000 (node:20 container, production build on start, state in `state/`, workspace
folder `ws/`). **Day-to-day: `DEV=1 ./lab.sh`** — one development build, then `tsc -w` + `theia build --watch`
keep `lib/` fresh: edit `workspace-theia/src/**` or `workspace.css`, wait for `[watch/browser] Finished` in
`docker logs -f workspaces-theia` (~4s CSS, ~20s TS), refresh the browser. Needs `docker restart workspaces-theia`:
backend edits (`src/node/*`), theme JSON, `package.json` preferences, `services/shell/agent.js` (copied into
`state/agent/` at start). The watch rebuilds only the browser bundle on purpose — the node pass re-copies the
native modules under the running backend, which then segfaults. Watchers poll (inotify doesn't cross the
colima mount). The lab serves the checked-out working tree: keep it on the branch you are testing.

OpenCode in the lab: `run.sh` installs the `opencode` CLI (and jq) in the container and generates the provider
config from `LLM_*`; `lab.sh` passes `state/inference-env` when the file exists. It is a docker `--env-file` for any
OpenAI-compatible provider, for example:

```
LLM_BASE_URL=https://api.example.com/v1
LLM_API_KEY=sk-...
LLM_MODELS=model-a,model-b
LLM_LABEL=My provider
```

(optional `LLM_CONTEXT` + `LLM_OUTPUT`, `LLM_REASONING`, `LLM_IMAGES`; `LLM_2_*` for a second provider). OpenCode's
own state persists in `state/opencode-config/` and `state/opencode-data/`. The card's server log is in
`docker logs workspaces-theia` (`opencode-server:` lines); `curl localhost:3000/opencode-api/_status` shows its
state. Pi runs on a Node 22 fetched into `state/` (`PI_NODE`, `PI_SERVER`, `PI_DATA` are set by `lab.sh`).

Lab quirks: the user's theme (and assistant) lives in `state/theia/settings.json`; `WORKSPACE_NAME`/`WORKSPACE_OWNER`
are unset (brand shows the folder name, profile row "You") — restart the agent process with them set to see the
real strings; ports 13337/13338/8080/5432 are hidden from Running by the agent.

## Theia/Lumino gotchas worth knowing before touching the layout

- Cards are Lumino panels styled with a **border painted in the page colour** (`background-clip: padding-box`,
  per-corner radii = 14px + border); Lumino subtracts borders, CSS `top`/`margin` offsets it does not.
  Different border colours per side produce diagonal corner joins — never paint a header as a border.
- The Claude webview iframe is inside the right panel; an inset shadow on the panel is hidden by it (use an
  overlay `::after` for hairlines). `display:none` on a panel makes Lumino lay its children out at 0×0 —
  send a resize when it comes back (`relayoutMain`).
- Theia owns `location.hash` (workspace path), tab hovers come from `title.caption` (not a `title`
  attribute), webviews load through a service worker that a hard refresh bypasses, and Theia's Cmd+V runs
  `execCommand('paste')` which Chrome turns into a "Paste" confirmation bubble — all handled in the layout
  contribution; see the comments there before "simplifying".
