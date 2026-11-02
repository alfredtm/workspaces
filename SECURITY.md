# Security

Workspaces is a hobby project, so there is no support contract and no fixed
response time. Reports are still welcome and read.

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository.

Include what you found, how to reproduce it, and which version or commit you
tested.

## What matters most

Workspaces runs people's code behind a login, so these are the areas where a
report is most useful:

- getting into a workspace you don't own (the session cookie, the authproxy
  in each pod, the port-router);
- getting from a workspace to other workspaces, the manager or the cluster
  (the NetworkPolicy, the manager's Role);
- leaking provider keys, session keys or tokens.

## Supported versions

Only the latest release gets fixes.
