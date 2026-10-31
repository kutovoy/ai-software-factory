# Proposal

## Why

A 33-route UI audit found seven real defects (copy contradictions, a heading that changes per page, an
overflow, pluralisation, indistinguishable demo factories, ambiguous secret references). Separately, the
example factories hardcode `openai/gpt-5`, which does not exist on the operator's LiteLLM — the model must come
from configuration, not from a definition written for someone else's account.

## What Changes

- **Model references:** `model` may be `env:NAME`; the loader resolves it from the environment, the resolved
  config reports both the reference and the value, and an unset name is a non-fatal warning
  (`model_env_unresolved`). Example factories switch to `env:FACTORY_MODEL` / `env:FACTORY_SMALL_MODEL` /
  `env:FACTORY_REVIEW_MODEL`; `.env` sets them to the operator's model.
- **UI fixes:** one heading source for every factory page, `1 server` pluralisation, no horizontal overflow on
  the definition page, attestation copy that matches the actual state, canary copy that does not claim a live
  rollout, factory-specific secret references, and distinct name/alias for the lights-off demo factory.
- **Dev-data hygiene:** smoke pauses the cron schedules it syncs and removes the secret it registers; a
  `scripts/reset-dev.sh` clears demo/test rows on demand; integration tests default to a separate
  `factory_test` database.

## Capabilities

### Modified Capabilities
- `factory-definition`: model references resolved from the environment.
- `web-console`: consistent headings, correct copy, no overflow, attributable references.

## Impact

- Definition schema gains one reference form; no migration for models.
- Demo factories become portable across model providers.
- Smoke leaves no nightly schedules behind.
