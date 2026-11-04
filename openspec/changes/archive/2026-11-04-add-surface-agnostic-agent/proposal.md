# Proposal

## Why

The console, API and webhooks exist, but there is no CLI or CI surface. Roadmap item 11 asks
for the same agent on every surface: chat, CLI, Slack, API and CI/webhooks, all through the
same adapter → runner path.

## What Changes

- Add `factory run` and `factory intake` CLI commands.
- Add `packages/cli/src/surfaces.ts`: a small client that logs in, starts a chat run through
  `POST /factories/:id/chat`, creates intake work through `/intake/:provider`, and polls a run.
- Reuse the existing Slack intake provider for Slack; CI can use `factory intake --provider
  generic` or call the same API.
- Document the surfaces in the CLI help.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `harness-adapter`: CLI/CI surfaces reuse the same run path; no private execution path.
- `automations`: Slack/CI intake uses the intake provider contract.

## Impact

- `packages/cli/src/{index,surfaces}.ts`
- `packages/cli/test/surfaces.test.ts`
- No API or DB change; the CLI calls existing `/chat` and `/intake` routes.

## Non-goals

- No new harness adapter implementation; CLI surfaces call the API, which leases the runner.
- No Slack app manifest; the existing intake provider accepts Slack payloads.
- No CI provider plugin; a generic HTTP step is the contract.
