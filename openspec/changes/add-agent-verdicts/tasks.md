# Tasks

## 1. Core
- [x] 1.1 `agentVerdict` in the factory schema (`advisory` default, `required` allowed)
- [x] 1.2 `parseAgentVerdict` + tests (structured, textual, unknown, malformed)
- [x] 1.3 Verdict types exported from `packages/core`

## 2. Orchestration
- [x] 2.1 Append the verdict instruction to agent-gated stage prompts
- [x] 2.2 Map verdict → gate decision in `StageWorkflow`; persist verdict
- [x] 2.3 Integration test: rejecting agent gate drives `request_changes`/escalation

## 3. Persistence + API
- [x] 3.1 Migration 015: `gate_decisions.verdict jsonb`
- [x] 3.2 Repository accepts/stores verdict; gate detail returns it
- [x] 3.3 Console shows the verdict badge and feedback

## 4. Definition
- [x] 4.1 `hello-nextjs` sets `agentVerdict: required`; canonical export updated
