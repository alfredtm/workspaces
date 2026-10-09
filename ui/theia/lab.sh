#!/usr/bin/env bash
# (Re)create the local lab container and serve http://localhost:3000 with the workspace agent alongside.
# Claude/Theia/OpenCode state persists in ui/theia/state/. node_modules / third-party plugins are installed on first run.
#
#   ./lab.sh          production build once, then serve (what the image does)
#   DEV=1 ./lab.sh    dev loop: one development build, then `tsc -w` + `theia build --watch` keep lib/ fresh —
#                     edit src/ or workspace.css, wait for "[build/browser] Finished", refresh the browser.
#                     Backend (src/node/*) edits need `docker restart workspaces-theia` (the watch only rebuilds the
#                     browser bundle: a node rebuild rewrites the native modules under the running backend → SIGSEGV).
set -e
cd "$(dirname "$0")"
REPO=$(cd ../.. && pwd)
mkdir -p state/claude state/theia ws
docker rm -f workspaces-theia >/dev/null 2>&1 || true
if [ -n "${DEV:-}" ]; then
  # Polling watchers: inotify events don't cross the colima bind mount. esbuild's watch already polls.
  CMD='[ -d node_modules ] || npm ci --no-audit --no-fund; bash fetch-plugins.sh;
       npm run build:ext && npx theia build --mode development 2>&1 | grep --line-buffered -iE "error|Finished"; echo BUILD_DONE;
       (TSC_WATCHFILE=DynamicPriorityPolling npx tsc -p workspace-theia -w --preserveWatchOutput 2>&1 | grep --line-buffered -iE "error|Found" &)
       (npx theia build --mode development --watch 2>&1 | grep --line-buffered -iE "error|Finished" &)
       bash run.sh'
else
  CMD='[ -d node_modules ] || npm ci --no-audit --no-fund; bash fetch-plugins.sh; npm run build 2>&1 | grep --line-buffered -iE "error|Finished"; echo BUILD_DONE; bash run.sh'
fi
# Inference for the OpenCode / Pi card: put your provider's LLM_* settings (docker --env-file format, see
# images/workspace/opencode-config.sh) in state/inference-env — gitignored with the rest of state/.
ENVFILE=(); [ -f state/inference-env ] && ENVFILE=(--env-file state/inference-env)
mkdir -p state/opencode-config state/opencode-data state/pi
# Pi (beta, Settings → Assistant): services/pi needs Node >= 22.19, the lab's Theia runs on Node 20 — fetch a Node 22
# into state/ once (the pod uses its own Node 24) and the service's deps from its lockfile (in the container: Linux).
PI_NODE=node-v22.20.0-linux-$( [ "$(uname -m)" = arm64 ] || [ "$(uname -m)" = aarch64 ] && echo arm64 || echo x64 )
[ -x "state/$PI_NODE/bin/node" ] || curl -fsSL "https://nodejs.org/dist/v22.20.0/$PI_NODE.tar.xz" | tar -xJ -C state
docker run -d --name workspaces-theia -p 3000:3000 "${ENVFILE[@]}" \
  -v "$REPO":/repo -v "$REPO/ui/theia/state/claude":/root/.claude -v "$REPO/ui/theia/state/theia":/root/.theia \
  -v "$REPO/ui/theia/state/opencode-config":/root/.config/opencode -v "$REPO/ui/theia/state/opencode-data":/root/.local/share/opencode \
  -e THEIA_WEBVIEW_EXTERNAL_ENDPOINT='{{hostname}}' -e WS_ROOT=/repo/ui/theia/ws \
  -e PI_NODE="/repo/ui/theia/state/$PI_NODE/bin/node" -e PI_SERVER=/repo/services/pi/server.mjs -e PI_DATA=/repo/ui/theia/state/pi \
  -w /repo/ui/theia node:20 \
  bash -lc "(cd /repo/services/pi && [ -d node_modules ] || npm ci --no-audit --no-fund); $CMD"
echo "started${DEV:+ (dev loop)} — follow with: docker logs -f workspaces-theia"
