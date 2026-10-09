#!/bin/bash
set -euo pipefail

HOME_DIR="${HOME:-/home/dev}"
SEED_MARKER="$HOME_DIR/.workspace-seeded"
DEFAULT_FOLDER="$HOME_DIR/workspace"

# Some platforms (OpenShift, for one) run the container with a random UID that
# is not in /etc/passwd. Append an entry so whoami and similar tools work.
if ! whoami &>/dev/null 2>&1; then
    echo "dev:x:$(id -u):0:dev:$HOME_DIR:/usr/bin/zsh" >> /etc/passwd
fi
# Same for a supplemental fsGroup gid: without a /etc/group line, `groups`
# (which Ubuntu's /etc/bash.bashrc runs at every interactive start) prints
# "cannot find name for group ID …" into every login.
for gid in $(id -G); do
    if ! getent group "$gid" >/dev/null 2>&1; then
        echo "fsgroup-$gid:x:$gid:" >> /etc/group
    fi
done

# First boot of a home directory: the project folder with its README, and the
# shell dotfiles. Never overwrites anything the user already has.
if [ ! -f "$SEED_MARKER" ]; then
    mkdir -p "$DEFAULT_FOLDER"
    [ ! -f "$DEFAULT_FOLDER/README.md" ] && cp /etc/workspace-defaults/README.md "$DEFAULT_FOLDER/README.md"
    [ ! -f "$HOME_DIR/.zshrc" ]     && cp /etc/skel/.zshrc    "$HOME_DIR/.zshrc"
    [ ! -f "$HOME_DIR/.gitconfig" ] && cp /etc/skel/.gitconfig "$HOME_DIR/.gitconfig"
    [ ! -d "$HOME_DIR/.oh-my-zsh" ] && ln -s /etc/oh-my-zsh  "$HOME_DIR/.oh-my-zsh"

    touch "$SEED_MARKER"
fi

# The one platform-provided Claude skill: tells Claude what environment it
# runs in. Overwritten every boot so it always matches the image.
mkdir -p "$HOME_DIR/.claude/skills/workspace"
cp /etc/claude-defaults/workspace-skill.md "$HOME_DIR/.claude/skills/workspace/SKILL.md"

# Repo-centric workspaces (API only): clone WORKSPACE_REPO on first boot and
# open the editor there. Anonymous clone only — private repos fail fast
# (GIT_TERMINAL_PROMPT=0) and leave a note telling the user what to do.
if [ -n "${WORKSPACE_REPO:-}" ]; then
    repo_name=$(basename "${WORKSPACE_REPO%.git}")
    repo_dir="$HOME_DIR/$repo_name"
    if [ -d "$repo_dir/.git" ]; then
        DEFAULT_FOLDER="$repo_dir"
    else
        echo "Cloning $WORKSPACE_REPO ..."
        if GIT_TERMINAL_PROMPT=0 timeout 180 git clone "$WORKSPACE_REPO" "$repo_dir"; then
            DEFAULT_FOLDER="$repo_dir"
        else
            rm -rf "$repo_dir"
            mkdir -p "$DEFAULT_FOLDER"
            cat > "$DEFAULT_FOLDER/CLONE-FAILED.md" <<EOF
# Repo clone failed

Could not clone \`$WORKSPACE_REPO\` anonymously — it is probably a private
repo (or the URL is wrong). Authenticate in the terminal and clone it
yourself:

    gh auth login
    git clone $WORKSPACE_REPO ~/$repo_name
EOF
        fi
    fi
fi

# OpenCode on the configured inference endpoints: one provider per LLM_* endpoint
# (from the optional inference Secret, envFrom on the pod), regenerated every boot
# so a rotated key or a new model reaches every workspace on its next start. The
# file holds {env:...} references only. OPENCODE_CONFIG merges it into the user's
# own OpenCode config for everything started from here: the `opencode serve` behind
# the editor's OpenCode panel and `opencode` in a terminal.
OPENCODE_PLATFORM_CONFIG="$HOME_DIR/.config/opencode/workspace-platform.json"
/usr/local/bin/workspace-opencode-config "$OPENCODE_PLATFORM_CONFIG" || true
if [ -f "$OPENCODE_PLATFORM_CONFIG" ]; then
    export OPENCODE_CONFIG="$OPENCODE_PLATFORM_CONFIG"
fi
# OpenCode also reads ~/.claude/skills/, where Claude's `workspace` skill lives under
# the same name; OpenCode has its own (/etc/opencode-defaults/skills), so skip Claude's.
export OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1
# OpenCode's terminal UI (`opencode` in a terminal) can be themed like the editor:
# workspaces-{light,dark,navy} are small OpenCode themes that lock light/dark and
# match the editor's surfaces; pick one in ~/.config/opencode/tui.json. Refreshed
# every boot. The editor's OpenCode panel is its own chat widget and needs none of this.
mkdir -p "$HOME_DIR/.config/opencode/themes"
cp /etc/opencode-defaults/themes/workspaces-*.json "$HOME_DIR/.config/opencode/themes/" 2>/dev/null || true

# Secrets & variables (editor Settings) are written to ~/.workspace/env as export
# lines. Claude re-sources them via CLAUDE_ENV_FILE; every other non-interactive
# bash — OpenCode's shell tool included — gets them through BASH_ENV. Missing file
# = bash skips it.
export BASH_ENV="$HOME_DIR/.workspace/env"

# authproxy on :8080 validates the session cookie before forwarding anything to
# the editor, the agent or a user's app. Everything else binds 127.0.0.1 only and
# cannot be reached from outside the pod.
authproxy &

# The workspace agent (ports, Preview, uploads, env, guided sign-ins) on 13338,
# its page server on 13339; the editor proxies it under /workspace-api.
export AGENT_PORT=13338 PREVIEW_PORT=13339
WS_ROOT="$DEFAULT_FOLDER" node /opt/workspace-agent/agent.js &

# The Theia editor on 13337, where authproxy points. Webviews must be same-origin
# ({{hostname}} = the page host) or the Claude panel renders about:blank.
# PORT=3000: a free default for the user's apps (the assistants' shells inherit
# it) — 8080 is authproxy, 13337-13339 the editor and agent. authproxy itself
# listens via LISTEN, not PORT. Pi (PI_SERVER, default /opt/pi/server.mjs) and
# `opencode serve` (OPENCODE_PORT, default 4097) are started by the editor on demand.
cd /opt/theia
exec env PORT=3000 THEIA_WEBVIEW_EXTERNAL_ENDPOINT="{{hostname}}" WS_ROOT="$DEFAULT_FOLDER" \
    /opt/theia/bin/node lib/backend/main.js \
    --hostname 127.0.0.1 --port 13337 \
    --plugins=local-dir:/opt/theia/plugins "$DEFAULT_FOLDER"
