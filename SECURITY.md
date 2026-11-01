# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). Include:

- what is affected (component, route or configuration),
- reproduction steps or a proof of concept,
- impact and any suggested fix.

You will get an acknowledgement, and a fix or mitigation will be coordinated
before any public disclosure.

## Supported versions

This is a fast-moving pre-1.0 project; security fixes land on `main`. Pin a
commit or tag if you need stability.

## Secrets

- Never commit `.env` files, tokens, keys or certificates. `.env.example` is the
  only environment file that belongs in git.
- Credentials are referenced **by name** in factory definitions and resolved at
  run time. The inference key never enters a sandbox (ADR-011).
- If you believe a credential was exposed, rotate it immediately and open a
  private report.

## Deployment note

The default compose stack is a **local, single-user** setup: the console and the
local forge have no authentication yet (Phase 6). Do not expose ports 3000/8080
to an untrusted network until console auth lands.
