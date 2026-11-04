# Software Factory Ideas and Roadmap

Captured 2026-11-03. Companion to `research/talks.md` and `research/ecosystem.md`.

This is a **proposed** roadmap. Nothing below is implemented yet. The goal is to move the product from
"agents can build features" to **"the factory is measurable, verifiable and self-tuning."**

## Thesis

The videos converge on the same shift:

- The coding agent is no longer the differentiator; the **factory around it** is.
- The hard problems are **validation, context, cost, governance and continuous improvement**.
- A factory should be **defined in code**, record every run, score outcomes, and propose improvements as
  reviewed changes to its own definition.
- Humans move up to **factory engineering**: deciding what to build, setting policy, and tuning the loop.

We already have the primitives: factory-as-code, stages/gates, two-reviewer committee, Playwright QA,
scoring, benchmarks/Pareto, self-improvement, canary, merge queue, Forgejo, auth, secrets and MCP wiring.
The next phase is to make those primitives trustworthy and measurable.

## Source videos and diagram moments

| Talk | URL | Diagram / key moments | What it contributes |
|---|---|---|---|
| Boundary — How to Build a Software Factory for AI Coding Agents | https://www.youtube.com/watch?v=tGbjIvvYuHE | `29:40` orchestration diagram; `33:53` infrastructure layer; `36:25` harness; `40:03` enterprise factory stack; `41:20` layer stack; `51:44` dev environment; `52:18` interface gaps | Buy-vs-build stack: control plane → harness → dev environment → infrastructure; interfaces are the hard part |
| Eric Tech — I Built a Self-Improving Software Factory | https://www.youtube.com/watch?v=aggJvNZxfKA | `00:08` telemetry→board; `02:28` super-collect/super-board; `04:02` build skill map; `07:06` QA map; `09:01` collect flow; `09:23` UI loop; `10:34` diagnose/fix/style/motion; `10:48` guard hooks | Telemetry-driven tickets, specialist builder/QA/reviewer, QA pyramid, guard hooks, UI refinement loop |
| Zach Lloyd (Warp) — Building a Self-Improving Software Factory | https://www.youtube.com/watch?v=AIH8AGJm_IY | `08:00` metrics dashboard; `09:54` factory YAML; `12:46` metrics; `15:09` scorer; `17:31` self-improvement PR; `19:51` Pareto benchmark; `22:01` factories stack | Factory-as-infrastructure, traces, outcome metrics, per-agent scores, definition PRs, internal benchmarks |
| Tereza Tížková (Factory) — What It Actually Takes to Build a Software Factory | https://www.youtube.com/watch?v=vGCJ7diEtrw | `01:58` full cycle; `07:47` routing classifier; `12:20` orchestrator/workers/validators; `13:39` validation contract; `15:24` loops; `16:31` context; `18:23` agent readiness | Full lifecycle, model routing, missions, validation contract, computer-use validator, progressive disclosure, readiness |
| Eno Reyes (Factory AI) — From AI Coding Agents to the Software Factory | https://www.youtube.com/watch?v=SkoT4RkteSA | `05:03` signal→deployment; `07:28` capabilities; `08:04` surface-agnostic; `09:22` governance; `10:22` readiness; `12:47` outcomes | Canonical automations, same agent on every surface, governance, agent readiness, outcome metrics |

Frames were extracted with `tools/yt/ytx.py` and saved under `/tmp/sf-yt/<video-id>/frames/` for this
review. They are research artifacts, not committed product assets.

## Idea catalogue

| # | Theme | Idea | Evidence | Current gap | Effort |
|---|---|---|---|---|---|
| 1 | Validation | **Validation contract** written before code: acceptance checks, test tiers, commands, evidence, risks | Tereza `12:20`–`13:39`; [acceptance criteria as contract](https://dev.to/teppana88/how-i-validate-quality-when-ai-agents-write-my-code-481c) | Spec is free text; QA evidence is not tied to a contract | M |
| 2 | Validation | **Two validators**: scrutiny (code/tests/lint/typecheck) + user-testing (computer-use/Playwright against the running app) | Tereza `13:39`; [computer-use UI testing](https://www.ml6.eu/en/blog/computer-use-agents-in-practice-automating-ui-testing) | QA is Playwright-only; no explicit adversarial/user-testing split | M |
| 3 | Validation | **QA pyramid**: unit → component/integration → E2E; pick the right test library per ticket | Eric `07:06`–`08:44`; [agent testing guide](https://www.openlayer.com/blog/agent-testing-complete-guide-validating-ai-systems) | QA does not require unit/component tiers | M |
| 4 | Readiness | **Agent Readiness score** for repos/factories: tests, linters, typecheck, formatter, docs, dev env, observability, security, task discovery | Tereza `18:23`; Eno `10:22`; [agent-readiness](https://github.com/kodustech/agent-readiness), [Factory linters](https://factory.com/news/using-linters-to-direct-agents) | No readiness gate before autonomy | M |
| 5 | Measurement | **Outcome dashboard**: human interactions per PR, autonomy ratio, signal→production cycle time, code shelf life, incident MTT, cost per PR, cost per accepted change | Zach `08:00`/`12:46`; Eno `12:47`; [DORA in the AI era](https://getdx.com/blog/dora-metrics/), [agentic developer intelligence](https://www.elixirdata.co/blog/agentic-developer-intelligence) | Metrics exist but not these outcome/autonomy ratios | M |
| 6 | Measurement | **Per-agent scores** for redundant tests, verbosity, scope, review usefulness; sample traces with LLM-as-judge | Zach `15:09`; [agent observability](https://www.augmentcode.com/guides/agent-observability-for-ai-coding), [Arize](https://arize.com/ai-agents/agent-observability/) | Scores/lessons exist but not trace-driven factory diagnosis | L |
| 7 | Self-improvement | **Factory-definition PRs** generated from scored failures, with run IDs/evidence; A/B benchmark before promotion | Zach `17:31`; [Warp self-improving factories](https://www.warp.dev/blog/agent-self-improving-software-factories) | Self-improvement exists but proposals are not consistently evidence-backed definition PRs | L |
| 8 | Routing | **Classifier-based model routing**: task difficulty/tools/repo → cheapest model above quality threshold; fallback; cache | Tereza `07:47`; Zach `19:51`; [Pareto routing](https://www.braintrust.dev/articles/evaluation-driven-model-routing-pareto-frontier), [model routing](https://www.mindstudio.ai/blog/model-routing-cut-ai-agent-costs) | `routing.yaml` is static; benchmarks inform humans, not runtime routing | L |
| 9 | Cost | **Budgets and spend caps** per run/factory/stage; cost attribution by model/agent; alerts | Zach `12:46`; Eno `02:26`–`03:06`; [DORA/cost](https://getdx.com/blog/dora-metrics/) | Cost is visible but not enforced per run/factory | M |
| 10 | Intake | **Work intake from anywhere**: Sentry/PostHog/Slack/Linear/GitHub/API; dedupe and verify before creating a ticket | Eric `00:08`/`09:01`; Zach `05:46`–`06:07`; [software factory intake](https://www.firecrawl.dev/blog/ai-software-factory) | GitHub webhooks + manual only | M |
| 11 | Context | **Progressive context / MCP discovery**: capability index; discover → promote → reuse; defer full schemas until needed | Tereza `16:31`; [meta-tool pattern](https://www.synapticlabs.ai/blogs/bounded-context-packs-meta-tool-pattern), [progressive disclosure](https://codemyspec.com/blog/progressive-disclosure) | MCPs are declared per agent; no deferred schema/capability broker | L |
| 12 | Guardrails | **Deterministic guard hooks**: secret scan, protected push, delete-outside, worktree cleanup, skill evals, README/docs sync | Eric `10:48`; [hook-based governance](https://www.endorlabs.com/learn/when-the-guardrails-slip-the-case-for-hook-based-governance-across-agent-platforms), [agentic hooks](https://ranthebuilder.cloud/blog/agentic-coding-hooks-deterministic-ai-guardrails/) | Runner hardening/secrets exist, but not a general hook framework | M |
| 13 | Governance | **Autonomy levels and risk classes**: per-action allow/deny, model allowlists, spend limits, audit/OTEL export, SSO/OIDC | Eno `09:22`; [HITL governance](https://www.dataiku.com/blog/human-in-the-loop-ai-agents), [safe autonomy](https://factory.com/news/safe-autonomy-readiness-policy) | Autonomy is binary; audit exists but no risk policy engine | L |
| 14 | Surfaces | **Same agent on every surface**: chat, CLI, Slack, API, CI/webhooks | Eno `08:04`; Zach `05:46`–`06:07`; [Augment factory](https://www.augmentcode.com/blog/beyond-ai-coding-agents-how-we-built-augments-software-factory) | Chat + API; no Slack/CLI adapter | L |
| 15 | Long-running | **Missions**: orchestrator → sequential workers → validators, fresh context per feature, checkpoints, validation contract | Tereza `12:20`–`15:24`; [Factory missions](https://factory.com/) | Work item loop is stage-based, not long-running mission sessions | L |
| 16 | Explainability | **Factory stack page**: 00 factories-as-code, 01 data/context, 02 compute, 03 inference, 04 improvement, 05 orchestration, 06 access | Zach `22:01`; Boundary `40:03`/`41:20`; [LaunchDarkly](https://launchdarkly.com/blog/what-is-an-ai-software-factory/) | Help explains features, not the stack model | S |

## Roadmap

### Now — 0 to 4 weeks (highest leverage)

**Goal:** make autonomy trustworthy before widening it.

1. **Validation Contract + QA pyramid**
   - Spec stage emits `validation-contract.yaml` (acceptance checks, test tiers, commands, evidence, risks).
   - Work-item detail shows the contract; QA must attach evidence per check; review verifies it.
   - QA requires unit/component/integration/E2E where applicable; Playwright remains the browser tier.
   - Acceptance: a verify gate cannot approve without evidence for every contract check; a review gate cannot
     approve if the contract is missing or unverified.

2. **Agent Readiness**
   - Add a readiness projection/scorer: style, build, testing, docs, dev env, observability, security, task discovery.
   - Surface on factory/dashboard; warn at factory creation and before autonomy enablement.
   - Acceptance: readiness score is visible, deterministic, and can block/annotate autonomy.

3. **Outcome metrics**
   - Add human interactions per PR, autonomy ratio, signal→production cycle time, code shelf life, incident MTT,
     cost per PR and cost per accepted change.
   - Acceptance: dashboard cards have definitions, sample size and time window; data comes from runs/events/scores.

4. **Deterministic guard hooks**
   - Add a hook framework around runner/adapter: secret scan, protected push, delete-outside-workspace,
     worktree cleanup, skill evals, README/docs sync.
   - Acceptance: hooks are testable, fail closed, and record evidence in the event log.

5. **Factory Stack page** *(quick win)*
   - Add a Help/console page explaining the 00–06 stack and where our components sit.
   - Acceptance: every stack layer links to the relevant help entry.

### Next — 1 to 3 months

6. **Trace-driven self-improvement**
   - Sample traces; score redundant tests, verbosity, scope, review usefulness; generate definition PRs with evidence.
   - A/B benchmark before promotion; reuse canary/merge queue.

7. **Classifier-based model routing + spend caps**
   - Runtime classifier chooses the cheapest model above a quality threshold; fallback on failure; cache.
   - Per-run/factory/stage budgets and alerts.

8. **Work intake from anywhere**
   - Sentry/PostHog/Slack/Linear/GitHub/API sources; dedupe and verify before creating a ticket.
   - Reuse automations/webhooks and the existing board.

### Later — 3 to 6 months

9. **Progressive context / MCP discovery**
   - Capability index and deferred schemas; measure token savings.

10. **Governance and autonomy levels**
    - Risk classes, per-action policy, model allowlists, audit/OTEL export, SSO/OIDC.

11. **Surface-agnostic agent**
    - Slack/CLI/CI adapters using the same adapter/runner path.

12. **Missions**
    - Long-running orchestrator/workers/validators with fresh context and checkpoints.

## Dependencies and blockers

- OIDC/IdP, remote runners, Temporal Cloud and multi-tenant isolation remain blocked on infrastructure/IdP
  decisions; they are not part of the first sprint.
- The live GitHub forge path still needs a PAT, repo and webhook secret.
- Model routing depends on a stable internal benchmark set and calibrated scorers.
- Agent readiness depends on a deterministic repo scan; start with the local checkout and factory repo.

## Grounding links

- Software factory architecture:  
  https://www.augmentcode.com/blog/beyond-ai-coding-agents-how-we-built-augments-software-factory  
  https://launchdarkly.com/blog/what-is-an-ai-software-factory/  
  https://www.firecrawl.dev/blog/ai-software-factory
- Agent readiness:  
  https://github.com/kodustech/agent-readiness  
  https://factory.com/news/using-linters-to-direct-agents
- Model routing / Pareto:  
  https://www.braintrust.dev/articles/evaluation-driven-model-routing-pareto-frontier  
  https://www.mindstudio.ai/blog/model-routing-cut-ai-agent-costs
- Observability / evals:  
  https://www.augmentcode.com/guides/agent-observability-for-ai-coding  
  https://arize.com/ai-agents/agent-observability/
- Validation / computer-use QA:  
  https://dev.to/teppana88/how-i-validate-quality-when-ai-agents-write-my-code-481c  
  https://www.ml6.eu/en/blog/computer-use-agents-in-practice-automating-ui-testing
- Progressive context:  
  https://www.synapticlabs.ai/blogs/bounded-context-packs-meta-tool-pattern  
  https://codemyspec.com/blog/progressive-disclosure
- Governance / HITL:  
  https://www.dataiku.com/blog/human-in-the-loop-ai-agents  
  https://factory.com/news/safe-autonomy-readiness-policy
- DORA / outcomes:  
  https://getdx.com/blog/dora-metrics/  
  https://www.elixirdata.co/blog/agentic-developer-intelligence
- Guard hooks:  
  https://www.endorlabs.com/learn/when-the-guardrails-slip-the-case-for-hook-based-governance-across-agent-platforms  
  https://ranthebuilder.cloud/blog/agentic-coding-hooks-deterministic-ai-guardrails/

## Approval gate

The roadmap is recorded here but **not approved for execution**. On approval, the first sprint becomes OpenSpec
changes (one per item), with the validation contract and readiness items first.
