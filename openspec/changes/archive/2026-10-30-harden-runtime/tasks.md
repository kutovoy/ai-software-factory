# Tasks

## 1. Routes (`apps/api`)

- [x] 1.1 `GET /autonomy?factory=` — declared policy, enabled/paused, actor/reason/time, newest `autonomy.*` event
- [x] 1.2 `POST /work-items/:id/cancel` — actor + reason, idempotent, `invalid_state` when terminal
- [x] 1.3 `FactoryWorkflow` handles `cancelWorkItem` Signal: cancel stage child, end `cancelled`
- [x] 1.4 Gates page reads `GET /autonomy`; E2E cleanup uses cancel instead of rejecting a gate
- [x] 1.5 Tests: read shape, cancel idempotency, cancel-while-gated, terminal refusal

## 2. Automation attestation parity

- [x] 2.1 Automation-created items resolve autonomy through the same attestation check as manual items
- [x] 2.2 Emit `autonomy.attestation_missing` when the gate cannot be satisfied
- [x] 2.3 Test: automation item with no attestation → human gates + event; with attestation → auto gates

## 3. Read-model rebuild (`packages/core` + `packages/cli`)

- [x] 3.1 `factory rebuild --from runs/ [--dry-run]` — replay `events.jsonl` in `(runId, seq)` order
- [x] 3.2 Idempotent upserts for runs/steps/events; diff report (missing/extra/divergent/orphaned)
- [x] 3.3 `event_log_corrupt` on gap or duplicate `seq`
- [x] 3.4 Tests: clean rebuild, second run no-op, orphan reported not deleted, corrupt log refused

## 4. jsonb hygiene

- [x] 4.1 Single encode at the repository boundary for `source_ref` / `input`
- [x] 4.2 Migration `011_jsonb_normalise.sql` rewriting double-encoded values (`jsonb_typeof` detection)
- [x] 4.3 Tests: round-trip object, legacy double-encoded row normalised, `->>` queries correct

## 5. Canary follow-ups

- [x] 5.1 GC candidate trees on terminal rollout, keep last N (configurable), never delete an active tree
- [x] 5.2 Hourly time series (pass rate, runs, error rate per version) derived from scores/runs
- [x] 5.3 Promotion hook: `deployHook` runs after merge; failure → `promoted_pending_deploy`; no hook →
      `promotion_pending_deploy`
- [x] 5.4 UI: series chart with null buckets, GC/prune control, promotion state
- [x] 5.5 Tests: GC keeps N + skips active, series buckets + nulls, hook success/failure/no-hook

## 6. Local runner sandbox

- [x] 6.1 Generated SBPL profile: deny default, read system+workspace, write workspace/tmp/run dir, network deny
- [x] 6.2 `RUNNER_SANDBOX=exec` opt-in; network grant per stage; unsupported platform → `runner.sandbox_unavailable`
- [x] 6.3 Tests: write outside workspace blocked, write inside allowed, network denied vs granted, fallback event

## 7. Flake hunt

- [x] 7.1 Loop canary + improvement suites 50×; record failure signature or confirm none
- [x] 7.2 Update the STATUS flake note with evidence (or remove it)

## 8. Wrap-up

- [x] 8.1 Smoke: cancel a work item, autonomy read, rebuild dry-run
- [x] 8.2 Playwright: cancel from the board, Gates reads autonomy directly
- [x] 8.3 STATUS + ADR-024 (rebuild is replay) + ADR-025 (sandbox-exec opt-in)
- [x] 8.4 `openspec validate harden-runtime`
