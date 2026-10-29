# Initial idea (verbatim user brief)

> Captured 2026-10-28. This is the founding brief for the project. Keep it intact; append clarifications below it rather than rewriting it.

## Brief

I want you to research best way to build "software factory" that I could use for a team or myself.

I want to have lights on software factory where human can optionally (on by default) be involved into code review and features review but also have it configurable to be full lights off software factory.

Use serper web search to research deeply all ideas and decisions, find best solutions.

Look into how gas city idea is structured with multiple agents making a team.

I also want self improving software factory, look what harness 2 by google does.

I also want software factory be written in a way that it can be documented and revisioned so I can compare which versions are better if needed or clone them.

Search youtube and listen to best videos for large ai conferences (AI Engineer is a good channel, find more) for ideas on software factories.

I want my factory be ai model agnostic and harness agnostic but I might like to use opencode harness and my own local AI model to test it.

I want my ai factory to have detailed web interface. https://www.youtube.com/watch?v=x-PK3yx_MJg has screenshots of comparable interface starting from 9:11.

Find a way how to get screenshots and text transcriptions from youtube videos and do https://www.youtube.com/watch?v=x-PK3yx_MJg first.

Ask me clarifying questions first.

That video web ui in menu had: New Chat, Inbox, Runs, MCPs and apps, Secrets, Users, Factories (Dashboard, Agents, Automations, Scorers, Self-improvement, Benchmarks, Factory definition, Settings), User profile. It connects to github/slack/etc.

Factory settings and whole configuration should be exportable/importable as text/json (like IaaC/terraform, similar idea just definitions) so it can be versioned, diffs can be done, etc.

Your first focus would be to spawn a sub agent that will focus and create a youtube video downloader (use serper to search if one exists and for all ideas to ground them) so you can download video and then transcribe text to analyse all ideas from video and to take frames as screenshots to analyse them. After that youtube video downloader works you can then focus on building plan of the work and present it to me after asking clarifying questions.

Try to use up to 2-3 sub agents where appropriate to split work and to conserve context of main agent.

Use openspec to build any codebase/project/subprojects and git.

Create AGENTS.md and keep project status/progress updated in related md files.

Use serper web search to find and install helpful skills into this project.

## Clarifications given (2026-10-28)

- **Deployment:** solo on this Mac first, with a path to cloud multi-tenant later (AWS / OpenStack / Digital Ocean). Support both local and remote runners.
- **Stack:** TypeScript monorepo — Next.js/React web UI, Postgres (Supabase-compatible), Bun. Consider Temporal.io for tasks/runners orchestration.
- **Harness strategy:** opencode adapter first, generic CLI adapter second.
- **Human gates:** configurable per automation *and* globally; per-stage choice of human vs agent for: spec, plan, agent runs, core review, PR review, deploy. Global default = spec + plan + PR review.
- **Self-improvement scope:** may change prompts/agents/scorers/automations, gated by evals. Not the factory's own source code (at least not initially).
- **Factory-as-code:** git-backed JSON/YAML definitions + DB index.
- **Local model:** user supplies OpenAI-compatible endpoint credentials (LiteLLM), factory must stay provider-agnostic.
- **MVP UI:** full nav parity with the reference product (Warp Factories).
- **"Gas city":** confirmed to mean **Gas Town / Gas City** (Steve Yegge).
- **Horizon:** long-running platform project, phased roadmap with versioned factory releases.

## Architectural addendum (2026-10-28, after clarifications)

- The **web UI chat is the harness front-end** (or *is* the harness). The user will not run opencode in a console as the primary workflow.
- **Tool execution happens on runners** (local or remote sandbox workers), not on the user's laptop.
- Consequence: the UI must stream agent events (tool calls, diffs, approvals) from a runner-backed session, and the orchestrator must own session lifecycle rather than delegating to a terminal.

## Working agreement

- Warn the user when the session approaches ~500k tokens (they may want to compact).
- Use subagents for major workstreams to conserve main-agent context.
- Serper is the primary web search; searxng is the fallback.
- Research artifacts live under `research/`; status lives in `docs/STATUS.md`.
