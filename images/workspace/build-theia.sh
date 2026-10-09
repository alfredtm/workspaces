#!/usr/bin/env bash
# Build the Theia editor app into the tarball the workspace Dockerfile ADDs at
# /opt/theia. Used by CI (the theia job, on the runner with the npm cache) and
# for local image builds.
#
# Needs Node 20 on PATH: Theia 1.75 targets it and its native modules
# (node-pty, watcher, drivelist) are ABI-bound to the Node that installs them,
# so the very same node binary ships inside the tarball and runs the editor in
# the pod (entrypoint.sh: /opt/theia/bin/node lib/backend/main.js).
# CLAUDE_EXT_VERSION / MATERIAL_ICON_THEME_VERSION come from the environment or
# versions.txt (fetch-plugins.sh reads it itself).
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root/ui/theia"

major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" = 20 ] || { echo "build-theia.sh: need Node 20 on PATH (Theia's natives are ABI-bound), have $(node --version)" >&2; exit 1; }

npm ci --no-audit --no-fund
TARGET_PLATFORM=${TARGET_PLATFORM:-linux-x64} bash fetch-plugins.sh
npm run build
npm prune --omit=dev --no-audit --no-fund

# Stage exactly what the pod runs: the app dir after prune (sources, lib/,
# src-gen/, plugins/, node_modules) plus the node binary at bin/node.
out=$root/ui/theia/dist-image
stage=$out/stage
rm -rf "$out"
mkdir -p "$stage/bin"
tar -cf - \
  --exclude=./dist-image --exclude=./state --exclude=./ws --exclude=./.theia \
  --exclude=./core --exclude=./README.md --exclude=./lab.sh --exclude=./run.sh \
  . | tar -C "$stage" -xf -
cp "$(command -v node)" "$stage/bin/node"
# OpenShift runs with a random UID in gid 0: group must equal user perms.
chmod -R g=u "$stage"
tar -C "$stage" -czf "$out/theia.tar.gz" .
rm -rf "$stage"
du -sh "$out/theia.tar.gz"
