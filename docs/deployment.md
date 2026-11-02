# Deployment

Workspaces installs with one Helm chart (`charts/workspaces`). This page goes
through what the cluster needs, the install itself, and the common
variations. Every value is documented in
[`values.yaml`](../charts/workspaces/values.yaml).

## What you need

- **Kubernetes** 1.27 or newer, with a default StorageClass that provides
  `ReadWriteOnce` volumes (or set `workspace.storageClass`).
- **A way in:**
  - an ingress controller (ingress-nginx, Traefik, HAProxy, …), or
  - a Gateway API implementation (Envoy Gateway, Istio, Cilium, …).
- **A domain:** pick one, e.g. `ws.example.com`.
  - The portal lives at `portal.ws.example.com`.
  - Workspaces live at `<user>-<name>.ws.example.com`.
  - Their ports live at `<port>--<user>-<name>.ws.example.com`.
- **DNS:** a wildcard record `*.ws.example.com` pointing at your ingress or
  gateway.
- **TLS:** a wildcard certificate for `*.ws.example.com`. It covers the
  portal too. cert-manager with a DNS-01 issuer is the usual way.
- **An OpenID Connect client** with the redirect URI
  `https://portal.ws.example.com/auth/callback`.
- **Optional:** a CNI that enforces NetworkPolicy (most do), so only the
  router can reach workspace pods.

## Install

```sh
helm install workspaces oci://ghcr.io/alfredtm/charts/workspaces \
  --namespace workspaces --create-namespace \
  -f my-values.yaml
```

A typical `my-values.yaml` with ingress-nginx and cert-manager:

```yaml
domain: ws.example.com

oidc:
  issuer: https://login.example.com/realms/main
  clientId: workspaces
  clientSecret: ""                 # leave empty for a public client
  allowedEmailDomains: example.com # optional

routing:
  mode: ingress
  ingress:
    className: nginx
    tlsSecretName: ws-wildcard-tls
    annotations:
      # The editor runs over WebSockets: don't cut idle connections after 60s.
      nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
      nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
      nginx.ingress.kubernetes.io/proxy-body-size: "0"
```

What gets installed:

| Where | What |
|---|---|
| release namespace (`workspaces`) | manager (2 replicas), port-router (2 replicas), the image-prepull DaemonSet, the OIDC and session Secrets, the Ingress or HTTPRoutes |
| `workspaceNamespace` (`workspaces-users`) | every workspace (Deployment, Service, PVC), a NetworkPolicy, a LimitRange, optionally a ResourceQuota and the inference Secret |

The manager's permissions are a namespaced Role in the workspace namespace:
- no ClusterRole;
- no access to Secrets.

`helm uninstall` keeps the workspace namespace and the session keys, because
they hold people's work. Delete them yourself if you mean it.

## Gateway API instead of Ingress

```yaml
routing:
  mode: gateway
  gateway:
    name: main            # an existing Gateway
    namespace: infra
    sectionName: https    # optional: a listener for *.ws.example.com
```

The chart creates two HTTPRoutes: the portal host, and `*.<domain>` to the
router. The latter has request timeouts switched off, for WebSockets and
streaming. The Gateway's listener must accept those hostnames from the
release namespace.

## Identity providers

The manager is a plain OIDC client. Usernames come from the email's local
part (`alice@example.com` becomes `alice`) and become part of workspace
hostnames.

- **Keycloak:** a client with *Standard flow*. Make it confidential (set
  `clientSecret`) or public (leave it empty; PKCE is always on).
- **Microsoft Entra ID:**
  - Issuer: `https://login.microsoftonline.com/<tenant-id>/v2.0`.
  - Use an app registration with a *Web* redirect URI and a client secret.
- **Google:** issuer `https://accounts.google.com`, an OAuth client of type
  *Web application*. Use `allowedEmailDomains` to keep it to your domain.
- **Dex, Authentik, Zitadel, Okta, …:** any standard OIDC provider works the
  same way.

## OpenShift

Workspace pods run as uid 1000 with `fsGroup` 1000 by default. OpenShift's
restricted SCC assigns its own ids instead, so clear both:

```yaml
workspace:
  fsGroup: null
  runAsUser: null
```

The image is built for arbitrary uids (group 0, `/etc/passwd` handled at
start).

## Inference providers

OpenCode and Pi need at least one OpenAI-compatible provider. Claude Code
does not. See [inference.md](./inference.md).

## Sizing

Each running workspace requests 250m CPU and 512Mi memory, with limits of 2
CPU and 4Gi; the PostgreSQL sidecar adds a little on top. Stopped workspaces
cost only their disk. Cap the namespace with `resourceQuota` if you need to.
`workspace.activeLimit` caps how many workspaces one person runs at once.

The workspace image is large (several GB): the prepull DaemonSet keeps it on
every node, so starts take seconds instead of minutes.

## Upgrades

`helm upgrade` rolls the manager and the router. Running workspaces keep
their pod until they stop. They pick up a new image the next time they
start, as long as the workspace image uses the `latest` tag: Kubernetes
pulls `latest` every time and caches any other tag. After publishing a new
workspace image, refresh node caches:

```sh
kubectl -n workspaces rollout restart ds/workspace-prepull
```

## Image architecture and local images

The published images are `linux/amd64` only. On an ARM cluster (including
kind or colima on an Apple Silicon Mac) the workspace image runs under
emulation if the node has it, and is slow to start. Build your own for ARM
(see below).

To use images from a local registry, or loaded straight into a node (for
example with `kind load docker-image`), give them a tag other than `latest`.
Kubernetes pulls `latest` even when the image is already on the node, and
the pull fails if the image isn't in a registry:

```yaml
image:
  registry: registry.example.com/workspaces
  tag: v0.1.1
```

Or set `manager.image`, `portRouter.image` and `workspace.image` one by one.

## Building your own images

The chart defaults to `ghcr.io/alfredtm/workspaces`. To ship your own
toolchain or defaults:
1. Fork the repo.
2. Edit `images/workspace` and `versions.txt`.
3. Let `.github/workflows/images.yml` publish to your registry.
4. Set `image.registry` to that registry.
