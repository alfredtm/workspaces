# portal

The web UI users see at the manager's public host: sign in, create, open, pause, resume and delete workspaces, and
check platform status. It is built with Vite and embedded into the manager binary (`services/manager`,
`go:embed all:uidist`), so **the portal and the manager API ship together in the manager image**.

## Stack

React 19 + TypeScript, Vite, plain CSS. No component library, no router, no state library: `App.tsx` switches between
two pages with the History API and each view fetches what it needs through `api.ts`. Icons are FontAwesome path data
rendered as inline SVG (`src/ui/Icon.tsx`). No external fonts or CDNs; the manager's CSP only allows `'self'`.

## Files

| File | What |
|---|---|
| `src/main.tsx` | Mounts the app and loads `styles.css`. |
| `src/App.tsx` | Page frame (top bar with Workspaces / Status, signed-in user, sign out) and the two-page routing. |
| `src/WorkspacesView.tsx` | The main page: list, **create (name only)**, open / resume / pause / delete, start-progress polling. |
| `src/StatusView.tsx` | Platform status: `GET /api/v1/status` plus live WebSocket probes from the browser. |
| `src/api.ts` | Typed API client: `fetchMe()` (also captures the CSRF token) and the workspace calls. |
| `src/shared/` | List plumbing: polling hook, start-message hook, status vocabulary, name suggestions, row + delete dialog. |
| `src/ui/` | Small in-house components: `AppShell`, `Button`, `Input`, `Message`, `Modal` (native `<dialog>`: focus trap, Esc, focus restore), `Spinner`, `Skeleton`, `Icon`. |
| `src/styles.css` | All styles. Design tokens are CSS custom properties in `:root`; dark mode re-points the colour tokens under `prefers-color-scheme: dark`. Class prefixes: `ui-` components, `ws-` workspace list, `st-` status page. |
| `vite.config.ts` | Dev proxy for `/api` (incl. WebSockets) and `/auth` → `MANAGER_ORIGIN` (default `http://localhost:8080`); `outDir` is `../../services/manager/uidist`. |

## The API it talks to (`services/manager/api.go`)

JSON under `/api/v1`, cookie-authenticated, **CSRF header on every non-GET** (`X-CSRF-Token`, value from
`GET /api/v1/me`); a `401` sends the browser to `/auth/login?redirect_to=…`; errors are `{"error": "…"}`.

| Call | Notes |
|---|---|
| `GET /api/v1/me` | `{upn, displayName, username, csrfToken, activeLimit}`. |
| `GET /api/v1/workspaces` | The caller's workspaces: `{name, slug, repo, url, replicas, ready, startFailed, idleDays, idleWarning, deleteAfterDays}`. |
| `POST /api/v1/workspaces` `{name, postgres?, repoUrl?}` | The UI sends only `name`. `postgres` defaults to true; `repoUrl` is for automation. |
| `POST …/{name}/start`, `POST …/{name}/stop`, `DELETE …/{name}` | Resume / pause / delete. No request body. |
| `GET …/{name}/status` | `{state, ready, message, redirect, phase, reason, unreadySeconds}`, polled while a workspace is starting. `message` is the human stage line; the row turns into a warning once `reason` is set or `unreadySeconds` > 180 (`shared/status.ts`). |
| `GET /api/v1/status`, `GET /api/v1/ws-probe` | Platform status `{clusterOk, running, starting, stuck}` and the WebSocket probe used by the Status page. |

If you change a request or response shape, change `api.ts` and `api.go` together.

## Develop

Run the manager with an in-memory fake cluster and a fake login (no Kubernetes, no identity provider), then the
portal with hot reload:

```sh
cd services/manager
export PUBLIC_HOST=localhost:5173 WORKSPACE_HOST='{user}.workspace.localhost' \
  WORKSPACE_NAMESPACE=workspaces WORKSPACE_IMAGE=ghcr.io/alfredtm/workspaces:latest \
  OIDC_ISSUER=https://issuer.example.invalid OIDC_CLIENT_ID=dev \
  OIDC_CALLBACK_URL=http://localhost:5173/auth/callback \
  SESSION_PRIVATE_KEY=$(openssl rand -base64 32) CSRF_KEY=$(openssl rand -base64 32) \
  DEV_FAKE=1 DEV_USER=alice@example.com
go run .                                  # API on :8080 (LISTEN=127.0.0.1:8090 if 8080 is taken)

cd ui/portal && npm ci && npm run dev     # http://localhost:5173, proxies /api and /auth to the manager
# MANAGER_ORIGIN=http://localhost:8090 npm run dev   if you moved the manager
```

Open `http://localhost:5173/auth/login`: with `DEV_USER` set, the manager signs you in as that user without an
identity provider (only allowed with a localhost `PUBLIC_HOST`). `DEV_FAKE` seeds a couple of workspaces in memory
(`services/manager/dev.go`); create / start / stop / delete work against the fake. Drop it and set `KUBECONFIG` to
hit a real cluster.

The manager's own `/` serves whatever is in `services/manager/uidist` (a placeholder in git, or your last
`npm run build`), so for UI work use the Vite dev server.

Checks: `npm run typecheck && npm run build`. Note that `npm run build` writes into `services/manager/uidist`.
