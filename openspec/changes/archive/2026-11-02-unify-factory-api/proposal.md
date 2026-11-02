# Proposal

## Why

The API is mostly factory-scoped, but scoring, calibration, scores, improvements, proposals and
lessons still live at global paths with `?factory=`. The console also has global `/scores/[id]` and
`/mcps` pages. This is inconsistent with the rule that everything factory-related is addressed
through `/api/v1/factories/:factoryId/...` and `/factories/<id>/...`.

## What Changes

- Move all remaining factory-scoped API routes under `/api/v1/factories/:factoryId/...`:
  scores, score detail, calibration, scoring, benchmark-run detail, improvement-run detail,
  proposals (+ decision/apply), and lessons (+ promote).
- Remove every `?factory=` / `?factoryId=` query from factory-scoped endpoints.
- Work-item/run creation takes the factory from the path; no `factoryId` in the body.
- Move factory-scoped browser pages under `/factories/<id>/...`: score detail and MCPs.
- Update OpenAPI, web clients, smoke, Playwright, help and README.

## Capabilities

### Modified Capabilities
- `factory-identity`: all factory-scoped resources use the factory path.

## Impact

- Breaking `/api/v1` rewrite (ADR records the exception to the prefix-bump rule).
- No DB migration; existing factory/work-item/run storage is unchanged.
