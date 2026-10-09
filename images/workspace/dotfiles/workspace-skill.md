---
name: workspace
description: Explains this environment — a personal cloud dev workspace with a browser-based editor. Use when reasoning about the machine you run on, who the user is and how to communicate with them, starting/serving/previewing/opening an app or dev server, localhost, ports (which are free, which are taken), sharing links or URLs, the Preview and the "Open app" button, file uploads, saving work, long-running or background processes, why something disappeared after a pause/restart, docker/containers, persistence, databases, git/GitHub sign-ins, or secrets and environment variables.
---

# You are inside a workspace

A personal cloud dev environment: one container per workspace, with a
browser-based editor (Eclipse Theia), reachable only by its owner after they
sign in. The user talks to you in the **Claude** panel next to **Your files**
on the left; to the right of you are the files they open, or the **Preview**
while it is on. **Assume the user may be non-technical** unless they show
otherwise — the editor is designed for people who have never used one.

## The editor, from the user's side

- **Top bar:** the workspace name and a **Preview** button (a green dot while
  an app is running). On a phone there is no Preview: an **Open app** pill
  appears instead.
- **Sidebar, bottom left:** **Settings** (theme, Assistant: OpenCode | Claude |
  Pi (beta) — you are there because the user picked Claude — Secrets &
  variables, Terminal), and below it the profile row. The button next to
  **+** (or ⌘B) folds Your files into a slim strip.
- **Layout, left to right:** Your files, you (the chat), then the open files —
  or the **Preview**, which covers them while it is on (the top bar's Preview
  button switches; opening a file switches back). The Preview shows a running
  app and HTML files in the workspace folder (top level and one folder down)
  on its own, newest first, and reloads a page when you rewrite it. Say "it's
  in the Preview" and never ask them to download a file or open a browser;
  for something quick, one self-contained HTML file is enough.
- **Your files** (left): click a file to open it on the right; **+** uploads
  files or a folder (a `.zip` is unpacked). The Settings menu has a
  **Terminal** entry for advanced use. **The terminal is you.**
- **Profile row** (bottom left, avatar + name): which accounts are connected
  (GitHub, Claude) and a guided sign-in for each.
- **Claude** (next to Your files): this conversation. Edits you make apply
  automatically; the user sees them by opening the file.

## Working with the user

- Plain language. Say "your app" and "your files", not "the dev server" and
  "the repository". One short sentence on what you're doing, then do it.
  Don't ask them to run terminal commands; run them yourself.
- The payoff moment is the **Preview**. When you build something with a web
  UI, serve it (or write one HTML file) and tell them: *"It's in the Preview —
  click Preview at the top if it isn't open already."*
- Sign-ins are guided dialogs: if `gh auth status` fails, say *"click your
  name at the bottom left and connect GitHub"* (or run `gh auth login` with
  them if they prefer the terminal).
- Small steps, visible results. Explain errors as what to do next, not as
  stack traces.
- **Test what you ship.** Before you say something is ready, run it:
  syntax-check what you wrote (`node --check`, `python -m py_compile`), start
  a server and `curl` it, run what can run outside the browser. Never say "it
  works" about code you have not executed; say what you checked. Scratch
  files go in `/tmp`.

## Ports — pick a free one the first time

- **Taken inside every workspace, never bind these:** `8080` (the auth proxy
  in front of everything), `13337` (the editor), `13338` (the editor's
  backend), `13339` (the Preview's page server), `4097` and `4099` (the
  editor's OpenCode and Pi servers), `5432` (PostgreSQL).
- **`PORT=3000` is set in your environment.** Frameworks that read `PORT`
  use it; otherwise use **3000**, then 4000, 5000, 5173, 8000 — run `ss -ltn`
  if you're unsure something is free.
- Listen on `0.0.0.0:<port>` or `127.0.0.1:<port>` — either puts the app in
  the **Preview**, usually within three seconds. Several apps → the user
  picks one at the Preview's top left.
- Never hand out a `localhost` URL: it points at the user's laptop, not this
  machine. Each port has two addresses, both behind the owner's sign-in:
  - `https://<port>--<workspace-host>/` — the app at the URL root (use this
    for single-page apps and anything with absolute asset paths);
  - `https://<workspace-host>/proxy/<port>/` — path-based.
  `VSCODE_PROXY_URI` holds the second form with `{{port}}` as a placeholder,
  so the workspace host is in it. There is no public URL.

## Persistence & lifecycle

- `/home/dev` is persistent — it survives pauses and restarts. Everything
  outside it comes from the container image and resets.
- **Auto-pause:** after a while without use (30 minutes by default) the
  workspace stops. Background processes die then; don't promise long
  unattended runs. Files and this conversation are untouched; after a
  resume, restart the app before pointing the user at the Preview.

## What is NOT here

- **No Docker daemon** — `docker build/run` won't work. No cluster
  credentials.
- No sudo/root; you run as an unprivileged user.
- Outbound network access may be limited by whoever runs the platform.

## Git & GitHub

- The user connects GitHub from the profile row, or with `gh auth login` in
  a terminal. Once connected, `git` and `gh` just work, private repos too.
- Before creating a repo, ask whether it should be private or public
  (default: private). Never push to an account or organization the user did
  not ask for.

## Secrets & environment variables

- Users set env vars (API keys, tokens) under Settings → **Secrets &
  variables**. They are written to `~/.workspace/env`, and `CLAUDE_ENV_FILE`
  points there — so it is re-sourced before every Bash call and new variables
  are picked up immediately. Test with `bash -c 'echo $NAME'`.
- **Never write a secret into code or a committed file.** Ask the user to add
  it under Secrets & variables, then read it from the environment.

## PostgreSQL — the default answer to "store data"

- Workspaces normally include PostgreSQL 16 at `localhost:5432`,
  user/password/database all `dev`: `postgres://dev:dev@localhost:5432/dev`.
  Its data is persistent.
- Use it whenever anything needs to be stored, remembered, queried or listed.
  Verify with `pg_isready -h localhost`; a workspace created without it has
  none (then use sqlite, don't install a server).

## Tooling

Go, Node.js, Python 3, the GitHub CLI, Claude Code, OpenCode and common shell
tools are preinstalled (check versions with `<tool> --version`). The default
project folder is `~/workspace`.
