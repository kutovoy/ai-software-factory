# Architecture decisions (ADR-lite)

One entry per decision that is expensive to reverse. Format: context → options → decision → consequences.
Status: `proposed` | `accepted` | `superseded`.

---

## ADR-001 — Durable orchestration engine

**Status:** accepted (2026-10-28)
**Context:** Agent runs are long-lived (minutes to hours), must survive restarts, need retries, timers,
human-in-the-loop waits, and per-run observability. Solo-on-Mac first, cloud multi-tenant later.
**Options:** Temporal · Inngest · Restate · DBOS · Trigger.dev · Windmill · plain Postgres queue.
**Decision:** **Temporal from day one**, using `temporal server start-dev` locally and the TS SDK.
One Workflow per work item, child Workflows per stage, Activities wrapping runner and model calls.
Postgres remains the read model for the UI (runs/work items/events index); Temporal event history is the
durable execution truth. Migrate to Temporal Cloud when multi-tenant (Phase 6).
**Consequences:** gates use Signals/Updates (native durable waits, days-long); timers give escalation SLAs;
replay gives auditability. Adds a local dev dependency and a worker process; every Activity must be
idempotent. Do not put artifacts in Postgres — object store/disk + references.

---

## ADR-002 — Harness abstraction

**Status:** accepted (2026-10-28)
**Context:** Must be harness-agnostic (opencode first, then Claude Code / Codex / Gemini / generic CLI),
model-agnostic (any OpenAI-compatible endpoint), and must stream tool calls into the web UI because the
UI *is* the harness front-end.
**Options:** embed opencode server in the UI · adapter interface per harness · adopt ACP/AG-UI as wire
protocol · CLI wrapper with structured stdout.
**Decision:** one internal `HarnessAdapter` interface + canonical `FactoryEvent` union. **New Chat always
goes through adapter + runner** — the UI never talks to a harness process directly. Every prompt becomes a
run on a runner, so chat and factory work share one code path, one audit trail, and one permission model.
opencode adapter talks to `opencode serve` (HTTP+SSE) as the reference implementation.
**Consequences:** slightly higher chat latency (runner lease per message); in exchange: full audit trail,
identical semantics for all harnesses, and the ability to move a chat session into a factory run and back.

---

## ADR-003 — Factory definition format & versioning

**Status:** proposed (strongly leaning accepted)
**Context:** Definitions must be diffable, cloneable, comparable across versions, editable by agents,
and exportable/importable as text.
**Options:** DB-first + export bundles · git-backed YAML + DB index · both with bidirectional sync.
**Leaning:** git-backed `factory.yaml` + directory tree, DB only indexes/caches; every run pins a commit
SHA; UI edits produce a commit (or PR) — never a DB-only mutation.
**Decision:** _pending schema confirmation from `research/warp-factories.md` §4._
**Consequences:** enables benchmarks per version, self-improvement as PRs, and rollback.

---

## ADR-004 — Gates model (lights on/off)

**Status:** proposed
**Context:** Humans should be optional but on by default; granularity needed per stage and per automation.
**Options:** global boolean · per-stage enum (`human` | `agent` | `policy`) · per-automation overrides
with global defaults.
**Decision:** gate policy object resolved as `automation override → factory default → global default`,
each gate being `human` | `agent` | `policy:<name>`. Default (lights on) = spec, plan, pr_review = human.
Target capability (lights off) = **every stage agent-gated**, including deploy, with `mergePolicy:
auto_on_green`. Build the full capability in Phase 3, but **enabling** all-agent gates requires a passing
benchmark non-regression gate (Phase 4) — the switch exists earlier, the guardrail ships with it.
**Consequences:** drives inbox semantics, escalation paths, and what "lights off" means for audit. A global
kill switch flips every gate back to `human` and pauses dispatch.

---

## ADR-005 — Self-improvement safety

**Status:** proposed
**Context:** Observer agents may propose changes to prompts/skills/model routes/scorers/automations.
Must not degrade quality or silently rewrite itself.
**Options:** propose-only PRs · auto-merge if eval improves · staged rollout with canary + rollback.
**Leaning:** propose → benchmark against current version on a fixed task set → if improved beyond a
threshold, open a PR (auto-merge only in lights-off mode with a benchmark gate + rollback on regression).
**Decision:** _pending — informed by Harness² mechanics (`research/ecosystem.md` §B)._
**Consequences:** requires benchmark infrastructure before self-improvement can ship.

---

## ADR-006 — Runner isolation

**Status:** proposed
**Context:** Tool execution must not happen in the web process; local Mac + remote workers later.
**Options:** Docker containers · macOS `sandbox-exec` · microVM (Firecracker/Lima) · git worktree +
process jail.
**Leaning:** local runner = Docker (or Lima) with a bind-mounted worktree; remote runner = same image on
a worker host; protocol identical.
**Decision:** _pending._
