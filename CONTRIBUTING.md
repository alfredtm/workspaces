# Contributing

Thanks for taking a look. Issues and pull requests are welcome.

## Before you open a pull request

Run the checks for what you touched (the full list is in
[`docs/development.md`](./docs/development.md#tests)):

- Go services: `go vet ./... && go test ./...` in the module.
- Portal: `npx tsc --noEmit -p . && npm run build` in `ui/portal`.
- Editor: `npx tsc -p workspace-theia --noEmit` in `ui/theia`, then look at
  it with `ui/theia/lab.sh`. Several past bugs were invisible to the type
  checker and obvious on screen.
- Agent and Pi: `node --test` in `services/shell` and `services/pi`.
- Chart: `helm lint charts/workspaces` with `oidc.issuer` and `oidc.clientId`
  set.

## Conventions

- Pull request titles are [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat(editor): …`, `fix(manager): …`). They become the squash commit
  message.
- Tooling versions live in `versions.txt`, not in workflows or Dockerfiles.
- Keep user-facing text plain: many people using this aren't developers.
- Don't commit secrets, tokens or real hostnames. Examples use
  `example.com`.

## Releases

Tag `vX.Y.Z` on `main`. CI publishes the images with that tag, the Helm
chart to `oci://ghcr.io/alfredtm/charts/workspaces`, and a GitHub release
with generated notes.
