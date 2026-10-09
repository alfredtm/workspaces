#!/usr/bin/env bash
# Fetch + unpack the third-party VS Code extensions Theia loads from plugins/ (idempotent; the Claude ext + icon theme
# our Claude patches. Versions come from ../../versions.txt unless overridden via env.
#   CLAUDE_EXT_VERSION            Anthropic.claude-code (Open VSX, platform-specific vsix)
#   MATERIAL_ICON_THEME_VERSION   PKief.material-icon-theme (Open VSX)
#   TARGET_PLATFORM               linux-x64 (prod) | linux-arm64 (arm lab); default from uname
set -euo pipefail
cd "$(dirname "$0")"
V=../../versions.txt
ver() { grep -E "^$1=" "$V" | cut -d= -f2; }
: "${CLAUDE_EXT_VERSION:=$(ver CLAUDE_EXT_VERSION)}"
: "${MATERIAL_ICON_THEME_VERSION:=$(ver MATERIAL_ICON_THEME_VERSION)}"
: "${TARGET_PLATFORM:=linux-$(uname -m | sed 's/aarch64/arm64/; s/x86_64/x64/')}"
fetch() { # name url
  [ -d "plugins/$1/." ] && [ -f "plugins/$1/package.json" ] && { echo "plugins/$1 present"; return; }
  echo "fetching $1 from $2"; rm -rf "/tmp/vsix-$1" "plugins/$1"; mkdir -p "/tmp/vsix-$1"
  curl -fsSL "$2" -o "/tmp/vsix-$1/x.vsix"
  ( cd "/tmp/vsix-$1" && if command -v unzip >/dev/null; then unzip -q x.vsix; else python3 -c 'import zipfile;zipfile.ZipFile("x.vsix").extractall(".")'; fi )
  mkdir -p plugins && mv "/tmp/vsix-$1/extension" "plugins/$1"; rm -rf "/tmp/vsix-$1"
}
fetch claude-code "https://open-vsx.org/api/Anthropic/claude-code/${TARGET_PLATFORM}/${CLAUDE_EXT_VERSION}/file/Anthropic.claude-code-${CLAUDE_EXT_VERSION}@${TARGET_PLATFORM}.vsix"
fetch material-icon-theme "https://open-vsx.org/api/PKief/material-icon-theme/${MATERIAL_ICON_THEME_VERSION}/file/PKief.material-icon-theme-${MATERIAL_ICON_THEME_VERSION}.vsix"
# Language support: VS Code built-in extensions (grammars, TS/JSON/CSS/HTML/Markdown features) plus Python,
# Go and YAML — listed in package.json "theiaPlugins" (pinned URLs), resolved + unpacked by Theia's downloader.
npx theia download:plugins --rate-limit 8 --ignore-errors   # pack members missing on Open VSX are listed in theiaPluginsExcludeIds; anything else missing just logs
# zip extraction can drop the exec bit on the bundled claude binary
chmod +x plugins/claude-code/resources/native-binary/* 2>/dev/null || true
node patch-claude.mjs plugins/claude-code
