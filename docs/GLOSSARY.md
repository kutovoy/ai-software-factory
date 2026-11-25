# Glossary

Terms used across specs, code and UI. Keep this aligned with `packages/core` type names.

| Term | Meaning |
|---|---|
| **Factory** | A team of agents bound to one or more repositories, plus its automations, scorers, benchmarks and settings. The unit of versioning and cloning. |
| **Factory definition** | The git-tracked, declarative description of a factory (`factory.yaml` + `agents/`, `automations/`, `scorers/`, `benchmarks/`, `skills/`, `runners/`). The source of truth. |
| **Factory version** | An immutable snapshot identified by a git commit SHA of the definition repo. Every run pins one. Two versions can be benchmarked against each other. |
| **Work item** | One unit of requested work (issue, Slack thread, PR, scheduled job) tracked from intake to handoff, retaining its source context. |
| **Mission** | A durable goal above work items: plan, milestones, features, validation contract, checkpoints, events, gates, validations and optional budget. Runs under `MissionWorkflow`. |
| **Milestone** | A group of mission features that must all finish before a fresh validation round (scrutiny + user-testing) checks the mission contract. |
| **Mission feature** | One unit of mission work; persisted as a work item that runs `implement → review → ship`. Whole-app `verify` belongs to the milestone boundary, so partial features can merge before the full milestone exists; an already-satisfied feature completes without a PR. |
| **Validation contract** | Behavioral assertions written before features run, with tier, required flag, tool and expected evidence; mission-level contracts drive milestone validators. `architecture` and `maintainability` are first-class tiers with optional named thresholds (`2026-11-07-harden-factory-quality`). |
| **Risk tier** | A per-plan/feature classification (`low`, `medium`, `high`) that decides plan approval, review and merge policy. Autonomy is bounded by blast radius and verification capacity, not a factory-wide switch. |
| **Risk policy** | `governance.risk` in `factory.yaml`: the default tier, per-tier `planApproval`/`review`/`merge` rules and `highRiskPaths`. Absent means conservative defaults. |
| **High-risk path** | A glob such as `auth/**` or `migrations/**` that escalates a change to `high` risk, forcing human plan, review and ship decisions. |
| **Vertical slice** | A feature that delivers an end-to-end, testable behavior. An *enabler* is scaffolding that must state which later slice verifies it. |
| **Slop budget** | Risk-tiered caps on diff lines, changed files, new dependencies, duplication delta and complexity delta (`quality.slopBudget`). An overage stops an agent review gate or needs a human waiver. |
| **Proof artifact** | A run-scoped screenshot, video, HTML explainer, curl transcript or test report bound to the commit; required for UI/behavioral claims. |
| **Context pack** | A deterministic, bounded bundle of relevant ADRs, architecture constraints, test standards, prior failures and relevant files passed into a feature/stage prompt. |
| **Review packet** | A compact deterministic decision surface: intent, plan, budget vs actual, blast radius, proof, read-first list, decisions, reviewer roles, comprehension and open questions; high-risk work items use it as the human review surface. |
| **Plan depth** | `none`/`light`/`full` planning effort chosen from risk, expected pain and change size; avoids over-planning small changes while keeping full design for high-cost work. |
| **Comprehension debt** | The gap between code shipped and code humans understand. It grows when review/reading is removed; planned as a metric and autonomy gate. |
| **Checkpoint** | A small JSON snapshot of mission state (completed work, decisions, failed approaches, tests, blockers, budget) that lets the next feature start with fresh context. |
| **Mission Control** | The factory-scoped console view of missions: plan approval, milestones/features, checkpoints, validation evidence, budget and pause/resume/cancel controls. |
| **Stage** | A step in the SDLC loop: `triage`, `spec`, `plan`, `implement`, `review`, `verify`, `ship`, `monitor`. |
| **Gate** | A checkpoint on a stage that requires a human decision (`human`) or is auto-approved by an agent/policy (`agent`). Gates are configurable globally and per automation. |
| **Foreman** | The coordinating agent that owns a factory's work item: it decides stages, dispatches subagents, picks model/harness per step, talks to humans, and escalates. |
| **Worker agent** | An agent that executes one stage (e.g. implementer, reviewer). Ephemeral session, persistent identity/history. |
| **Crew** | Human members of a factory (the people who approve gates). |
| **Run** | One agent execution: prompt → tool calls → artifacts → terminal state. Emits an append-only event log. |
| **Retention / GC** | The lifecycle policy for run evidence: terminal runs beyond the age/keep policy are removed with their rows, run directory, artifact blobs and terminal canary trees; active runs are protected. |
| **Quota** | A per-factory admission cap: lifetime/daily/monthly spend or concurrent runs. Exhaustion refuses new work with `factory_budget_exhausted` or `factory_quota_exhausted`. |
| **Promotion checkout** | After a canary merge, the local definition tree is rewritten from the candidate and committed when the git worktree is clean; a dirty checkout records `promotion_pending_deploy`. |
| **Event log** | JSONL stream of everything a run did (messages, tool calls, diffs, approvals, cost). Audit trail + eval input. |
| **Runner** | An execution environment (local subprocess sandbox or remote worker) where tool calls actually happen. The web process never executes tools. |
| **Harness** | Everything around the model that makes it an agent: prompt, tools, memory, skills, orchestration, plugins. Supplied by an *adapter*. |
| **Harness adapter** | Our interface to a harness (opencode, Claude Code, Codex CLI, Gemini CLI, generic CLI). Normalises streaming, tool calls, permissions, cancellation, resume. |
| **Model route** | A rule mapping a stage/task type to a model + harness + context budget. Part of the definition; tunable by benchmarks. |
| **Skill** | A reusable instruction bundle (markdown + optional scripts) an agent can load for a kind of work. |
| **MCP server** | External tool provider registered to a factory and exposed to agents. |
| **Scorer** | A function/rubric that grades a run or a set of runs (correctness, procedure compliance, efficiency, verbosity, code quality). Graded by code, human, or LLM-as-judge. |
| **Benchmark** | A fixed task set run across ≥2 factory configurations, scored with the same scorers, producing a comparison matrix. |
| **Self-improvement loop** | Observer agents that read scored runs and propose diffs to the factory definition (prompts, skills, model routes, scorers, automations), gated by evals and (optionally) human review. |
| **Lights on** | Default mode: humans approve spec, plan and PR review (and any other stage configured). |
| **Lights off** | All gates set to `agent`/auto-approve; humans only see the inbox and can intervene asynchronously. |
| **Inbox** | Human-facing queue of items needing attention: approvals, escalations, failures, proposed self-improvement diffs. |
| **Control room / dashboard** | Live + historical view of runs, work items, throughput, cost, automation %, quality. |
| **Automation** | A trigger (schedule, webhook, GitHub event, Slack message) that starts a work item or run. |
| **Promotion** | Moving a factory version from candidate → active, usually after passing a benchmark gate. |
| **Audit trail** | Git history of definitions + event logs + approvals, sufficient to reconstruct why any change shipped. |
