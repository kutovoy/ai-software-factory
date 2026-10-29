# Glossary

Terms used across specs, code and UI. Keep this aligned with `packages/core` type names.

| Term | Meaning |
|---|---|
| **Factory** | A team of agents bound to one or more repositories, plus its automations, scorers, benchmarks and settings. The unit of versioning and cloning. |
| **Factory definition** | The git-tracked, declarative description of a factory (`factory.yaml` + `agents/`, `automations/`, `scorers/`, `benchmarks/`, `skills/`, `runners/`). The source of truth. |
| **Factory version** | An immutable snapshot identified by a git commit SHA of the definition repo. Every run pins one. Two versions can be benchmarked against each other. |
| **Work item** | One unit of requested work (issue, Slack thread, PR, scheduled job) tracked from intake to handoff, retaining its source context. |
| **Stage** | A step in the SDLC loop: `triage`, `spec`, `plan`, `implement`, `review`, `verify`, `ship`, `monitor`. |
| **Gate** | A checkpoint on a stage that requires a human decision (`human`) or is auto-approved by an agent/policy (`agent`). Gates are configurable globally and per automation. |
| **Foreman** | The coordinating agent that owns a factory's work item: it decides stages, dispatches subagents, picks model/harness per step, talks to humans, and escalates. |
| **Worker agent** | An agent that executes one stage (e.g. implementer, reviewer). Ephemeral session, persistent identity/history. |
| **Crew** | Human members of a factory (the people who approve gates). |
| **Run** | One agent execution: prompt → tool calls → artifacts → terminal state. Emits an append-only event log. |
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
