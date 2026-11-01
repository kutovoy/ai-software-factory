# Contributing

Thanks for taking a look. This project is an open, model- and harness-agnostic
software factory; contributions are welcome.

## Setup

```bash
git clone <repo> && cd SoftwareFactory
cp .env.example .env          # set OPENAI_BASE_URL / OPENAI_API_KEY
docker compose up -d --build  # web :3000, API :8080, Temporal UI :8233
bash scripts/smoke.sh         # credential-free end-to-end smoke
```

For a real forge with resolving PR links:

```bash
bash scripts/forgejo-bootstrap.sh
# writes GITHUB_TOKEN / GITHUB_API_BASE_URL to .env, restarts api+worker
```

## Development

- Bun workspaces, TypeScript, ESM. Node 22+.
- `bun run ci` — typecheck + unit tests + factory validation.
- `cd apps/web && bunx playwright test` — browser flows (needs the stack up).
- `bash scripts/e2e.sh` — compose up → smoke → Playwright.
- Integration suites are opt-in: `RUN_INTEGRATION=1 DATABASE_URL=… bun test <file>`
  against the `factory_test` database.

## Changes go through OpenSpec

Every non-trivial change is an OpenSpec change:

```bash
openspec list
openspec validate <change>
openspec archive <change>
```

Specs describe observable behaviour. Keep `docs/STATUS.md` current and add an ADR
in `docs/DECISIONS.md` for irreversible choices.

## Rules that matter

- Definitions are the source of truth; the UI never writes the worktree.
- The API lives under `/api/v1`; `apps/api/openapi.json` must match the routes.
- Help is part of the product: update the matching entry in `apps/web/src/lib/help.ts`.
- README stays current with features, install steps and architecture.
- Never commit secrets; reference them by name.
