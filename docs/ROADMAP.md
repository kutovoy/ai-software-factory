# Roadmap

Long-running platform project, phased. Each phase ends with a demoable artifact and an OpenSpec change
that is validated + archived. Phases 1–3 are solo-on-Mac; phase 6 opens the cloud/multi-tenant path.

## Phase 0 — Research & foundation ✅ (2026-10-28)
- OpenSpec initialized, `AGENTS.md`, brief, glossary, ADRs, research corpus.
- YouTube toolkit (`tools/yt`) + Warp talk analysis + UI nav map.
- **Exit:** we know the reference product's primitives and our differentiators.

## Phase 1 — Definitions as code (≈2 weeks) ✅
Build: `packages/core` schema (Zod) for `factory.yaml` + agents/automations/scorers/benchmarks/skills/
runners/routing; loader + validator; `export`/`import`/`diff` CLI; git round-trip (write files → commit →
read back identical); DB index tables; `factories/example` reference factory.
**Exit:** `factory export | diff | import` is byte-identical; schema validates the Warp example factory
(adapted); `openspec validate` passes. Nothing else is testable until this exists.

## Phase 2 — Chat → run → events → inbox (≈2–3 weeks) ✅
Build: `packages/adapters` canonical `FactoryEvent` union + **opencode adapter** (HTTP+SSE); `packages/runners`
local Docker runner (lease/exec/heartbeat/kill); **Temporal worker** with `RunWorkflow` (one per chat message)
and `RunnerActivity`s; `apps/api` sessions/runs/events (Postgres read model + SSE); `apps/web` New Chat +
Runs + Inbox with live streaming; append-only JSONL event log.
**Exit:** from the web chat, a prompt runs on a runner via Temporal, streams tool calls/diffs live, produces
a patch, and lands in the inbox. No terminal involved. Killing the worker mid-run and restarting resumes it.

## Phase 3 — The factory loop + gates (≈3–4 weeks) ✅
Build: work items, stage graph (triage → spec → plan → implement → review → verify → ship), foreman agent,
automations (GitHub label, Slack mention, cron), **`FactoryWorkflow`** (one per work item) with child
workflows per stage, gate primitive (typed decision via Temporal Update/Signal, durable wait, escalation
timer), gate policy resolution (automation → factory → global), merge policy + merge queue (agents never
push to main), review committee (≥2 reviewers + judge, advisory verdicts), **full lights-off capability**
(all stages agent-gated + `mergePolicy: auto_on_green` + kill switch).
**Exit:** label a GitHub issue `factory-ready` → spec PR → gate (human or auto) → implementation PR →
agent review → merge queue. Both lights-on and fully lights-off paths demoed. Lights-off stays behind a
benchmark gate until Phase 4 lands.

## Phase 4 — Measurement (≈3 weeks) ✅
Build: `packages/evals` scorer registry (deterministic checks + LLM-as-judge), sampling + cadence,
judge calibration golden set, dashboard metrics (throughput, cost/PR per stage, cycle time, autonomy),
benchmark suites with replay at pinned SHAs + `definitionCommit`, Pareto comparison.
**Exit:** two factory versions benchmarked side by side with a correctness-vs-cost scatter; cost per PR
attributable to stages.

## Phase 5 — Self-improvement + versioned releases (≈3–4 weeks) ✅
Build: observer agents, Harness²-style propose→probe→compose, experience library (`INDEX.md`/`EXPERIENCE.md`),
proposal dedupe + impact ranking, PR generation against the definition repo, benchmark non-regression gate,
`factory-vN` tags, canary rollout (route X% of work to vN+1), rollback.
**Exit:** a scored-run corpus produces a ranked proposal, it beats the baseline on the benchmark, merges as
a PR (or auto-merges in lights-off), and can be rolled back in one click.

## Phase 6 — Team & cloud (ongoing)
Build: auth/users/roles, remote runners (UI-enrolled outbound-mTLS host agents, central Temporal
scheduling, no Temporal/Postgres on remote hosts, Linux first, then Windows native/Windows containers,
then macOS native/Tart), runner host CPU/RAM/disk metrics and alerts, **Temporal Cloud** (namespaces +
search attributes; retire the local dev server), managed Postgres, cost/quota controls (daily/monthly
spend + concurrent-run admission), Teams/Jira/GitLab integrations, multi-tenant namespaces.
**Exit:** a second user and a remote Linux runner operate the same factory with per-tenant isolation,
and the console shows each runner's CPU/RAM/disk health with firing/resolved alerts.

**Remote-runner plan:** `docs/REMOTE_RUNNERS_PLAN.md`. Linux Docker, Windows native and macOS native
agents are implemented and merged to `main` (archived OpenSpec `2026-11-04-add-remote-runners`,
`2026-11-05-add-runner-platforms-and-artifacts` and `2026-11-05-harden-live-runner-platforms`):
enrollment, outbound command queue, central scheduling, agent-side sandbox/harness, host CPU/RAM/disk
metrics and alerts, and RustFS artifact upload/download. macOS M5 native (`sandbox-exec`) and Linux
Docker agent runs were live-verified end-to-end, including full `runner: remote` factory work items with
concurrent review and artifacts (PRs #13 and #14); Windows live verification, Windows containers, macOS
Tart VMs, mTLS certificate issuance, service-manager wrappers and a separate remote host remain
follow-ups.

**Operational follow-ups:** retention/GC, daily/monthly spend and concurrent-run quotas, and canary
promotion rewriting the local checkout are implemented (OpenSpec
`2026-11-05-add-retention-quotas-promotion`).

## What's left (2026-11-06)

Done: Phases 0–5, roadmap items 1–11, remote runners on Linux/macOS (live-verified) and Windows native
(implemented, not live-verified), retention/GC, cost quotas, promotion checkout, a fresh `hello-nextjs`
lights-off cycle with zero human decisions, and full `runner: remote` factory cycles on macOS native and
Linux Docker (PRs #13 and #14).

Remaining, in rough priority order:

1. **Roadmap item 12 — long-running missions.** Unblocked: design and build the durable mission model.
2. **Runner metric retention + rollups.** Unblocked: raw 1-minute samples for 7 days, 5-minute
   rollups for 30 days.
3. **launchd + Windows service wrappers.** Unblocked: turn the generated agent start commands into
   managed services.
4. **mTLS certificate issuance/rotation.** Unblocked to prototype; production is blocked on a PKI
   decision.
5. **Live Windows native runner verification.** Blocked on a Windows host.
6. **Windows containers backend.** Blocked on a Windows host with a container runtime.
7. **macOS Tart VM backend.** Blocked on Tart/macOS VM infrastructure.
8. **Separate remote-host E2E.** Blocked on a second physical or VM host.
9. **Forge proxy websocket upgrade E2E.** Unblocked: exercise the Caddy upgrade path end to end.
10. **Benchmark replay beyond canonical events + patch.** Unblocked: replay arbitrary harness
    tool-response traces.
11. **Live GitHub forge path.** Blocked on a PAT, a real repository and a webhook secret.
12. **Teams/Jira/GitLab deep integrations.** Unblocked but lower priority; webhook + token clone
    already covers the basic path.
13. **Phase 6c — external OIDC/IdP group→org mappings.** Blocked on an IdP/infrastructure decision
    (Keycloak/Authentik/Zitadel).
14. **Temporal Cloud.** Blocked on cloud account, namespace and cost decisions.
15. **Managed Postgres.** Blocked on provider/infrastructure decisions.
16. **Multi-tenant isolation + Phase 6 exit.** Blocked on items 13–15 and a real remote Linux host.

## Cross-cutting, every phase
- OpenSpec change per phase; `docs/STATUS.md` updated; ADR added for every irreversible choice.
- Tests: schema round-trip, adapter contract tests (recorded fixtures), runner integration test.
- Keep the reference factory in `factories/` runnable at all times.

## Deliberately deferred
- Managed self-hosting backends, AWS/GCP federation, ECR credentials (Warp enterprise surface).
- GitLab/Azure DevOps/Teams deep integrations (webhook + token clone covers them).
- Fine-tuning / training anything. Harness² proves you don't need it.
- "Live-managed" definitions (API-only, no files) — contradicts files-as-truth.
