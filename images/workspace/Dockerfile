# workspace: the per-user devcontainer image. Starts FROM the base image
# (images/workspace/base/Dockerfile: OS, toolchains, Claude Code, OpenCode)
# and adds everything that changes per commit — the Theia editor, the
# workspace agent, Pi, dotfiles, the entrypoint, and the authproxy binary
# copied out of its ko-built component image.
#
# Build context is the repo root (this file copies services/shell/,
# services/pi/ and the Theia tarball from ui/theia/dist-image/):
#   images/workspace/build-theia.sh        # Node 20 on PATH
#   docker build -f images/workspace/Dockerfile -t ghcr.io/alfredtm/workspaces:latest .
# Base and component images default to :latest; CI pins them to the tag it
# just built when they changed in the same run.
ARG BASE_IMAGE=ghcr.io/alfredtm/workspaces/base:latest
ARG AUTHPROXY_IMAGE=ghcr.io/alfredtm/workspaces/authproxy:latest

# Component image (ko puts the binary at /ko-app/<module>).
FROM ${AUTHPROXY_IMAGE} AS authproxy

# ============================================================
# The image: base + per-commit content
# ============================================================
FROM ${BASE_IMAGE}
USER root

# The platform's one Claude customization: an environment skill.
RUN mkdir -p /etc/claude-defaults
COPY images/workspace/dotfiles/workspace-skill.md /etc/claude-defaults/workspace-skill.md
RUN chmod -R g=u /etc/claude-defaults

# OpenCode config from the LLM_* env (optional inference Secret), run by the
# entrypoint on every boot — see the script header. /etc/opencode-defaults holds
# OpenCode's platform brief (AGENTS.md, always in the prompt), the `workspace`
# skill in OpenCode's skill format — the OpenCode counterpart of
# /etc/claude-defaults; keep the two in step — and the terminal UI themes.
COPY images/workspace/opencode-config.sh /usr/local/bin/workspace-opencode-config
COPY images/workspace/dotfiles/opencode/ /etc/opencode-defaults/
RUN chmod 755 /usr/local/bin/workspace-opencode-config && chmod -R g=u /etc/opencode-defaults

# The README seeded into a new home's project folder (~/workspace).
COPY images/workspace/dotfiles/README.md /etc/workspace-defaults/README.md
RUN chmod -R g=u /etc/workspace-defaults

# Dotfiles seeded into new home directories.
COPY images/workspace/dotfiles/.zshrc    /etc/skel/.zshrc
COPY images/workspace/dotfiles/.gitconfig /etc/skel/.gitconfig

# ============================================================
# authproxy (validates the session cookie before anything in the pod is
# reached) — from its component image, no Go stage here.
# ============================================================
COPY --from=authproxy /ko-app/authproxy /usr/local/bin/authproxy

# ============================================================
# Workspace agent — the editor's small backend (services/shell/agent.js).
# Deps pinned via the committed lockfile.
# ============================================================
COPY --chown=1000:0 services/shell/package.json services/shell/package-lock.json /opt/workspace-agent/
RUN cd /opt/workspace-agent && npm ci --omit=dev --no-audit --no-fund && chmod -R g=u /opt/workspace-agent
COPY --chown=1000:0 services/shell/agent.js /opt/workspace-agent/agent.js

# ============================================================
# Pi (beta) — the editor's third assistant: OpenCode's API over Pi Durable (services/pi).
# The editor backend starts it with the image's Node (>= 22.19 needed) while
# Settings → Assistant is Pi. Deps pinned via the committed lockfile.
# ============================================================
COPY --chown=1000:0 services/pi/package.json services/pi/package-lock.json /opt/pi/
RUN cd /opt/pi && npm ci --omit=dev --no-audit --no-fund && chmod -R g=u /opt/pi
COPY --chown=1000:0 services/pi/*.mjs /opt/pi/

# ============================================================
# The editor — an Eclipse Theia app, see ui/theia/README.md.
# Built outside BuildKit by images/workspace/build-theia.sh (CI: the theia job,
# with the npm cache; locally: run it first with Node 20 on PATH). The tarball
# carries the app after `npm prune --omit=dev` plus the Node 20 binary the
# natives are bound to, at bin/node — not the user-facing Node.
# ============================================================
ADD --chown=1000:0 ui/theia/dist-image/theia.tar.gz /opt/theia/

# ============================================================
# Group-writable by gid 0, for platforms that run the container with a random
# UID in group 0 (OpenShift). Only the small trees here — the big ones
# (/opt/workspace-agent, /opt/pi, /opt/theia) get their perms in the layer
# that creates them.
# ============================================================
RUN chown -R dev:0 /home/dev && \
    chmod -R g=u /home/dev /etc/passwd /etc/group /etc/skel

COPY images/workspace/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER 1000
WORKDIR /home/dev
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
