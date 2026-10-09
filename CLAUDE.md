# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

Read `README.md` (what this is), `docs/architecture.md` (how it fits
together) and `docs/development.md` (how to run and test it) first.

## Things that are easy to get wrong

- **The image needs the agent.** The editor depends on
  `services/shell/agent.js` for ports, Preview, file upload, env settings
  and guided sign-ins (Theia's backend proxies `/workspace-api/*` to it).
  The editor's terminals are Theia's own.
- **Pi follows OpenCode.** The assistant card speaks OpenCode's HTTP API, and
  `services/pi` implements the subset it uses. A card change that calls a
  new OpenCode endpoint needs a Pi answer too.
- **Ownership is a label.** It is the exact `workspaces.dev/user` label match,
  never parsed from object names.
- **Request and response shapes change together** in `ui/portal/src/api.ts`
  and `services/manager/api.go`.
- **Workspace hostnames are one label:** `<user>-<name>` and
  `<port>--<user>-<name>` under the domain. `--` is the port separator, so
  names never contain it.
- **The guides for assistants inside workspaces** live in
  `images/workspace/dotfiles` (Claude skill, OpenCode `AGENTS.md` and skill,
  the seeded README). Keep them in plain language and in step with the UI and
  with each other.
- **Inference is generic:** any OpenAI-compatible provider through `LLM_*`
  env (`docs/inference.md`). Don't add vendor-specific defaults.
- **The manager is stateless.** State lives in labels and annotations, it runs
  with several replicas, and its RBAC is a namespaced Role on the workspace
  namespace.
