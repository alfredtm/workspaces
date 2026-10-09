<!-- Keep this short. Delete sections that do not apply. -->

## Summary

<!-- One or two sentences: what does this PR do and why? -->

## Linked issue

Closes #

## What changed

<!-- Bullet the notable changes. -->

-

## Verification

<!-- How did you confirm it works? Paste the relevant output. The `ci`
     workflow runs the same commands (see CONTRIBUTING.md). -->

```sh
# Go (per module): cd services/<manager|authproxy|port-router> && gofmt -l . && go vet ./... && go test ./...
# Agent / Pi:      cd services/<shell|pi> && npm ci && node --test
# Portal:          cd ui/portal && npm ci && npx tsc --noEmit -p . && npm run build
# Editor:          cd ui/theia && npm ci --ignore-scripts && npx tsc -p workspace-theia --noEmit
# Chart:           helm lint charts/workspaces --set oidc.issuer=https://id.example.com --set oidc.clientId=x
```

## Checklist

- [ ] CI is green
- [ ] Diff is focused (no unrelated changes)
- [ ] PR title is a Conventional Commit (`feat(manager): ...`, `fix(editor): ...`)
- [ ] New GitHub Actions are pinned to a commit SHA with a `# vX.Y.Z` comment
