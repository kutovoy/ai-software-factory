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

The default compose stack enables console auth (`AUTH_REQUIRED=1`) but ships a **local
development** bootstrap admin: `FACTORY_ADMIN_EMAIL=admin@factory.local` /
`FACTORY_ADMIN_PASSWORD=factory-admin`, checked into git for the demo. These are not
secrets and must never be reused on a reachable host. Override both from the environment,
set `AUTH_COOKIE_SECURE=1` when the console is served over HTTPS, and keep ports 3000/8080
off untrusted networks. Set `AUTH_REQUIRED=0` only for local development where the console
and API intentionally run as the implicit local user.
