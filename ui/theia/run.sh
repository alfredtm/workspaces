#!/usr/bin/env bash
# Lab runner (inside the node:20 container started by lab.sh). Prod uses images/workspace/entrypoint.sh.
set -e
REPO=${REPO:-/repo}
# The shell agent is the backend for Running/Settings/wizard. Install its deps in a container-local
# dir so the repo's services/shell/node_modules (host-native) is never touched.
AGENT=$REPO/ui/theia/state/agent   # persisted across container recreations (state/ is gitignored)
mkdir -p "$AGENT" && cp "$REPO/services/shell/agent.js" "$REPO/services/shell/package.json" "$REPO/services/shell/package-lock.json" "$AGENT/"
if ! cmp -s "$AGENT/package-lock.json" "$AGENT/.installed-lock"; then
  for try in 1 2 3; do  # the container's DNS can be flaky right after start
    (cd "$AGENT" && npm_config_registry=https://registry.npmjs.org/ npm ci --omit=dev --no-audit --no-fund >/dev/null) && cp "$AGENT/package-lock.json" "$AGENT/.installed-lock" && break
    echo "agent npm ci failed (try $try)"; sleep 5
  done
fi
mkdir -p "${WS_ROOT:=/tmp/ws}"
# GitHub CLI for the guided sign-in (prod image ships it; the lab container doesn't)
if ! command -v gh >/dev/null 2>&1; then
  GHV=2.63.2; ARCH=$(uname -m | sed 's/aarch64/arm64/; s/x86_64/amd64/')
  if curl -sL "https://github.com/cli/cli/releases/download/v${GHV}/gh_${GHV}_linux_${ARCH}.tar.gz" | tar -xz -C /tmp; then
    cp "/tmp/gh_${GHV}_linux_${ARCH}/bin/gh" /usr/local/bin/gh || true
  fi
fi
# Claude CLI for the guided Claude sign-in (prod image pins it via versions.txt)
if ! command -v claude >/dev/null 2>&1; then
  CCV=$(grep -E "^CLAUDE_CODE_VERSION=" "$REPO/versions.txt" | cut -d= -f2)
  npm_config_registry=https://registry.npmjs.org/ npm i -g "@anthropic-ai/claude-code@${CCV}" --no-audit --no-fund >/dev/null 2>&1 || true
fi
# OpenCode CLI — the editor's OpenCode card talks to its `opencode serve` (prod image pins it via versions.txt)
if ! command -v opencode >/dev/null 2>&1; then
  OCV=$(grep -E "^OPENCODE_VERSION=" "$REPO/versions.txt" | tail -1 | cut -d= -f2)
  npm_config_registry=https://registry.npmjs.org/ npm i -g "opencode-ai@${OCV}" --no-audit --no-fund >/dev/null 2>&1 || echo "opencode install failed"
fi
# Inference for OpenCode, exactly like the pod: your provider's LLM_* settings (lab.sh passes state/inference-env
# when present) → ~/.config/opencode/platform.json, merged into OpenCode's config via OPENCODE_CONFIG. Without
# them OpenCode starts with no providers configured. The generator needs jq (the prod image has it; node:20 does not).
command -v jq >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq jq) >/dev/null 2>&1 || echo "jq install failed"
OPENCODE_PLATFORM_CONFIG="$HOME/.config/opencode/platform.json"
export OPENCODE_DEFAULTS="$REPO/images/workspace/dotfiles/opencode"
bash "$REPO/images/workspace/opencode-config.sh" "$OPENCODE_PLATFORM_CONFIG" || true
[ -f "$OPENCODE_PLATFORM_CONFIG" ] && export OPENCODE_CONFIG="$OPENCODE_PLATFORM_CONFIG"
mkdir -p "$HOME/.config/opencode/themes" && cp "$REPO/images/workspace/dotfiles/opencode/themes/"workspaces-*.json "$HOME/.config/opencode/themes/"   # TUI themes, like the pod
# THEIA_PORT: the agent reaches OpenCode through the editor backend; the pod's editor is on 13337, the lab's on 3000.
PORT=13338 AGENT_PORT=13338 WS_ROOT="$WS_ROOT" THEIA_PORT=3000 node "$AGENT/agent.js" &
cd "$REPO/ui/theia" && exec npm start
