# workspace base: everything in the workspace image that changes only when
# versions.txt does — OS packages, the dev user, Go, Node, Python, Claude Code,
# OpenCode, oh-my-zsh.
#
# Rebuilt by CI when this directory or versions.txt changes, and weekly (apt
# security updates). Everything that changes per commit — Theia, the
# workspace agent, Pi, dotfiles, the entrypoint, authproxy — lives in
# images/workspace/Dockerfile, which starts FROM this image. That split is
# what makes an editor change a short build.
#
# Build context is THIS directory:
#   docker build -t ghcr.io/alfredtm/workspaces/base:latest images/workspace/base
FROM ubuntu:24.04

USER root

# ============================================================
# System dependencies
# ============================================================
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    wget \
    git \
    jq \
    unzip \
    ripgrep \
    fd-find \
    htop \
    vim \
    tmux \
    zsh \
    ca-certificates \
    gnupg \
    lsb-release \
    openssh-client \
    procps \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI — the documented path for authenticating to private repos
# (gh auth login) inside a workspace
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# ============================================================
# dev user — numeric UID required for OpenShift runAsNonRoot.
# Ubuntu 24.04 ships with an 'ubuntu' user at UID 1000; remove it
# before creating dev so there's no UID/GID collision.
# ============================================================
RUN userdel -r ubuntu 2>/dev/null || true && \
    groupdel ubuntu 2>/dev/null || true && \
    groupadd --gid 1000 dev && \
    useradd --uid 1000 --gid 1000 --shell /usr/bin/zsh \
            --create-home --home-dir /home/dev dev

# ============================================================
# Go
# ============================================================
ARG GO_VERSION=1.26.9
RUN wget -qO- "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
    | tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:/home/dev/go/bin:${PATH}"
ENV GOPATH="/home/dev/go"

RUN GOBIN=/usr/local/bin go install golang.org/x/tools/gopls@latest && \
    GOBIN=/usr/local/bin go install github.com/go-delve/delve/cmd/dlv@latest && \
    GOBIN=/usr/local/bin go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest && \
    GOBIN=/usr/local/bin go install github.com/air-verse/air@latest

# ============================================================
# Node.js (LTS)
# ============================================================
ARG NODE_VERSION=24
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g \
    typescript \
    ts-node \
    eslint \
    prettier \
    pnpm \
    yarn

# ============================================================
# Claude Code
# ============================================================
ARG CLAUDE_CODE_VERSION=2.1.246
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Headless pod: claude login must use the device-code flow, so strip the
# browser-opening env vars. Global rc → applies in every workspace shell,
# including existing PVCs whose seeded dotfiles predate this.
RUN echo "alias claude='env -u BROWSER -u DISPLAY claude'" >> /etc/zsh/zshrc && \
    echo "alias claude='env -u BROWSER -u DISPLAY claude'" >> /etc/bash.bashrc

# ============================================================
# OpenCode: an assistant in the editor (Settings → Assistant; the editor's chat panel
# talks to `opencode serve`) and a second agent CLI in terminals.
# The npm package is `opencode-ai`; its postinstall hard-links the matching
# `opencode-linux-x64` optional dep into bin/, so no --ignore-scripts here.
# ============================================================
ARG OPENCODE_VERSION=1.18.29
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" && opencode --version

# ============================================================
# Shell
# ============================================================
RUN chsh -s /usr/bin/zsh dev
RUN git clone --depth 1 https://github.com/ohmyzsh/ohmyzsh.git /etc/oh-my-zsh \
    && chmod -R g=u /etc/oh-my-zsh

# claude is pinned via versions.txt and installed in a root-owned prefix —
# self-update can only fail ("no write permission to npm prefix"), so off.
ENV DISABLE_AUTOUPDATER=1
# Mouse reporting steals clicks from the browser terminal's native text
# selection — with it off, select + copy just works.
ENV CLAUDE_CODE_DISABLE_MOUSE=1

USER 1000
WORKDIR /home/dev
