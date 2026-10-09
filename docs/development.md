# Development

## Manager and portal, no cluster

```bash
cd services/manager
export PUBLIC_HOST=localhost:8080 WORKSPACE_HOST='{user}.workspace.localhost' \
  WORKSPACE_NAMESPACE=workspaces WORKSPACE_IMAGE=ghcr.io/alfredtm/workspaces:latest \
  OIDC_ISSUER=https://accounts.google.com OIDC_CLIENT_ID=dev \
  OIDC_CALLBACK_URL=http://localhost:8080/auth/callback \
  SESSION_PRIVATE_KEY=$(openssl rand -base64 32) CSRF_KEY=$(openssl rand -base64 32) \
  DEV_FAKE=1 DEV_USER=alice@example.com
go run .
```

- **`DEV_USER`** makes `/auth/login` sign you in as that user without an
  identity provider.
- **`DEV_FAKE`** swaps in an in-memory Kubernetes client seeded with a couple
  of workspaces.

Both refuse to run unless `PUBLIC_HOST` is `localhost`. Drop `DEV_FAKE` and
set `KUBECONFIG` to run against a real cluster.

Then the portal with hot reload (it proxies `/api` and `/auth` to the
manager on `:8080`; override that with `MANAGER_ORIGIN`):

```bash
cd ui/portal && npm ci && npm run dev
```

The manager's own `/` serves `services/manager/uidist`, which is only a
placeholder in git until you build the portal.

## The editor

The Theia app and its extension live in `ui/theia`.
- **Run it:** `ui/theia/lab.sh` runs it in Docker with the agent, OpenCode
  and Pi.
- **Watch loop:** `DEV=1 ./lab.sh` rebuilds on every change.

Details and gotchas are in [`ui/theia/README.md`](../ui/theia/README.md).

The agent the editor talks to also runs on its own:

```bash
cd services/shell && npm ci && PORT=7777 WS_ROOT=/some/dir node agent.js
```

## Tests

```bash
(cd services/manager && go test ./...)
(cd services/authproxy && go test ./...)
(cd services/port-router && go test ./...)
(cd services/shell && npm ci && node --test)
(cd services/pi && npm ci && node --test)
(cd ui/portal && npm ci && npx tsc --noEmit -p . && npm run build)
(cd ui/theia && npm ci --ignore-scripts && npx tsc -p workspace-theia --noEmit)
helm lint charts/workspaces --set oidc.issuer=https://id.example.com --set oidc.clientId=x
```

## Building images

The workspace image builds in two layers:
- **base** (`images/workspace/base`): toolchains, slow, rebuilt when
  `versions.txt` changes.
- **editor layer** (`images/workspace/Dockerfile`): the editor, the agent,
  Pi and authproxy, rebuilt on every change.

Build context for the editor layer is the repository root.

```bash
docker build -t ghcr.io/alfredtm/workspaces/base:latest images/workspace/base   # slow, optional
images/workspace/build-theia.sh            # needs Node 20 → ui/theia/dist-image/theia.tar.gz
docker build -f images/workspace/Dockerfile -t ghcr.io/alfredtm/workspaces:latest .

# Go services are built with ko (no Dockerfiles; see each module's .ko.yaml).
# The manager embeds the portal: build that first.
(cd ui/portal && npm ci && npm run build)
(cd services/manager && KO_DOCKER_REPO=ghcr.io/alfredtm/workspaces/manager ko build . --bare --local)
(cd services/port-router && KO_DOCKER_REPO=ghcr.io/alfredtm/workspaces/port-router ko build . --bare --local)
(cd services/authproxy && KO_DOCKER_REPO=ghcr.io/alfredtm/workspaces/authproxy ko build . --bare --local)
```

Tooling versions are pinned in [`versions.txt`](../versions.txt). The
Dockerfiles have defaults, and CI passes the pinned values.

## CI

| Workflow | When | What |
|---|---|---|
| `ci.yml` | pull requests, pushes to `main` | Go lint, vet, test and govulncheck per module; agent and Pi tests; portal typecheck and build; editor typecheck; chart lint and render; actionlint and shellcheck |
| `images.yml` | pushes to `main`, `v*` tags, manual | Builds and publishes every image to `ghcr.io/<owner>/<repo>` (`:<sha>`, `:latest` on main, `:X.Y.Z` on tags) |
| `release.yml` | `v*` tags | Publishes the Helm chart to `oci://ghcr.io/<owner>/charts` and creates the GitHub release |

## Manager configuration

The Helm chart sets all of these; the table is for running the manager by
hand.

| Variable | Required | Default and notes |
|---|---|---|
| `PUBLIC_HOST` | yes | The portal's hostname. The session cookie is scoped to its parent domain. |
| `WORKSPACE_HOST` | yes | Workspace hostname pattern; `{user}` becomes `<user>-<name>` |
| `WORKSPACE_NAMESPACE` | yes | Namespace for every workspace |
| `WORKSPACE_IMAGE` | yes | The workspace image |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CALLBACK_URL` | yes | The issuer must match discovery exactly (no trailing slash) |
| `OIDC_CLIENT_SECRET` | no | Empty for public clients; PKCE is always used |
| `ALLOWED_EMAIL_DOMAINS` | no | Comma list; empty = anyone the provider admits |
| `SESSION_PRIVATE_KEY` | yes | Base64 of a 32-byte Ed25519 seed |
| `CSRF_KEY` | yes | Base64, at least 16 bytes |
| `MANAGER_URL` | no | In-cluster URL workspace pods call for activity; default `http://manager.<POD_NAMESPACE>.svc.cluster.local:8080` |
| `WORKSPACE_STORAGE_CLASS` | no | Empty = cluster default |
| `WORKSPACE_STORAGE_SIZE` | no | `10Gi` |
| `WORKSPACE_FS_GROUP` | no | `1000`; empty or `0` = don't set (OpenShift) |
| `WORKSPACE_RUN_AS_USER` | no | Empty = don't set |
| `POSTGRES_IMAGE` | no | `quay.io/sclorg/postgresql-16-c9s:latest` |
| `INFERENCE_SECRET` | no | `workspace-inference`; the optional Secret whose keys become workspace env |
| `ACTIVE_LIMIT` | no | `3` running workspaces per person |
| `IDLE_TIMEOUT` | no | `30m`; `0` = never stop idle workspaces |
| `START_TIMEOUT` | no | `10m`; `0` disables |
| `IDLE_WARN_DAYS`, `IDLE_DELETE_DAYS` | no | `7`, `14`; `0` disables |
| `LISTEN` | no | `:8080` |
| `DEV_USER`, `DEV_NAME`, `DEV_FAKE`, `KUBECONFIG` | dev only | See above (`DEV_NAME` is the display name, default `Dev User`) |
