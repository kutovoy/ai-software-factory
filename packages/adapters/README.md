# `@factory/adapters`

Harness-agnostic access to agent harnesses. Every harness is wrapped in a `HarnessAdapter`
that emits one canonical event stream (`FactoryEvent`), so the API, the JSONL event log,
the SSE stream and the web UI never need to know which harness produced a run.

```
apps/api ──▶ HarnessAdapter ──HTTP+SSE──▶ opencode serve (inside a runner)
                        └──scripted──▶ FakeAdapter (CI, smoke tests, UI demo)
```

## Contract

```ts
interface HarnessAdapter {
  readonly id: AdapterId;
  readonly capabilities: AdapterCapabilities;

  startSession(req): Promise<SessionHandle>;
  sendPrompt(handle, parts, opts?): Promise<void>;
  streamEvents(handle, signal?): AsyncIterable<FactoryEvent>;
  cancel(handle, reason?): Promise<void>;
  resume(handle, sessionRef?): Promise<SessionHandle>;
  fork?(handle, atMessageId?): Promise<SessionHandle>;
  respondToPermission(handle, requestId, decision): Promise<void>;
  listAgents(handle): Promise<AgentDescriptor[]>;
  getDiff(handle): Promise<FileDiff[]>;
  getUsage(handle): Promise<UsageReport>;
  dispose(handle): Promise<void>;
  getStats?(): AdapterStats;
}
```

Rules the implementation must honour:

1. **One canonical union.** Eleven event types, no harness-specific fields leaking out
   (`src/events.ts`). Anything unmappable is dropped and counted in `droppedEvents`; a run
   never fails because of an unknown payload.
2. **Monotonic `seq` per run.** Assigned by `EventSequencer` at emit time — one sequencer
   per run (single writer). `at` is informational only.
3. **Stream before prompt.** Start consuming `streamEvents()` first, then call `sendPrompt()`,
   otherwise early harness events are missed. `streamEvents` always ends with exactly one
   `run.completed`.
4. **Permissions are a round trip.** `permission.requested` carries a `requestId`; the API
   posts a decision to `respondToPermission`. Static-permission harnesses advertise
   `permissions: "static"` and never emit the event.
5. **Errors are `{code, message, details?}`.** `AdapterError` maps to
   `harness_unreachable`, `harness_error`, `unsupported_capability`, `session_not_found`,
   `permission_not_found`, `invalid_response`, `aborted`.
6. **Capabilities are declared, not guessed.** Consumers degrade: no resume → fresh session;
   no structured output → reject the request with `unsupported_capability`; no MCP → the requested
   wiring is recorded as capability flags (`{supported:false, mode:"recorded", servers, permissions}`)
   instead of being silently dropped.

## Capability matrix

| Adapter | streaming | toolCalls | permissions | resume | fork | usage | structuredOutput | mcp |
|---|---|---|---|---|---|---|---|---|
| `opencode` (v2 server) | ✅ | ✅ | `interactive` | ✅ | ✅ | ✅ | ❌ | ✅ |
| `fake` | ✅ | ✅ | `interactive` | ❌ | ❌ | ✅ | ✅ | ❌ (recorded) |
| `claude-code` (planned) | ✅ | ✅ | `static` | ✅ | ❌ | ✅ | ❌ | ❌ (recorded) |
| `codex` (planned) | ✅ | ✅ | `static` | ✅ | ❌ | ⚠️ | ❌ | ❌ (recorded) |
| `gemini` / ACP (planned) | ✅ | ✅ | `interactive` | ✅ | ❌ | ⚠️ | ❌ | ❌ (recorded) |
| `generic-cli` (planned) | ❌ | ❌ | `none` | ❌ | ❌ | ❌ | ❌ | ❌ (recorded) |

## `opencode` adapter

Talks to a real `opencode serve` process over HTTP + SSE. Verified against the installed
CLI, `opencode v2.0.26`, and against `v2.2.0` inside the runner image
(`packages/runners/docker/Dockerfile`); both expose the same `/api` surface.

| Purpose | Endpoint |
|---|---|
| readiness probe | `GET /api/info` (backoff → `harness_unreachable`) |
| create session | `POST /api/session` `{title, agent?, model?, config?}` (`config` carries `mcp` + per-agent `permission` globs; credentials are `{env:NAME}` templates) |
| send prompt (async) | `POST /api/session/:id/prompt` `{text, files?, agent?, model?, resume:true}` |
| stream events | `GET /api/event` (SSE; first frame `server.connected`, then bus events) |
| cancel | `POST /api/session/:id/interrupt` |
| permission reply | `POST /api/session/:id/permission/:requestId/reply` `{decision:"once"\|"always"\|"reject"}` |
| pending permissions | `GET /api/session/:id/permission` |
| diff | `GET /api/session/:id/diff` |
| usage | `GET /api/session/:id` (`cost`, `tokens`) |
| agents | `GET /api/agent` |
| fork | `POST /api/session/:id/fork` `{messageID?}` |

Auth: `OPENCODE_SERVER_PASSWORD` → HTTP basic (`opencode:<password>`). Always set it when
the harness runs in a container; the adapter refuses to talk to an unauthenticated server
only if you pass no password and the server rejects (401 → `harness_error`).

### Doc vs installed CLI divergence

`https://opencode.ai/docs/server/` still documents the **v1** surface:
`POST /session`, `POST /session/:id/prompt_async`, `POST /session/:id/abort`, `GET /event`,
OpenAPI at `/doc`, permission body `{response, remember}`.

The installed **v2.0.26** server differs:

- everything moved under `/api` (`/api/session`, `/api/event`, `/api/agent`, …);
- `/doc` now serves the web UI; the OpenAPI 3.1 document is at **`/openapi.json`**;
- `prompt_async` → `POST /api/session/:id/prompt` (durably admits the input, schedules the
  agent loop; response is the admitted inbox item, not the assistant message);
- `abort` → `POST /api/session/:id/interrupt` (`{interrupted: boolean}`);
- permissions → `POST /api/session/:id/permission/:requestId/reply` `{decision}` with
  `once | always | reject` (not `response`/`remember`);
- SSE payloads are `{id, created, type, location, data, durable}` where `type` is the bus
  event name (e.g. `session.next.text.delta`, `session.next.tool.called`,
  `permission.v2.asked`, `session.idle`);
- structured output is **not** exposed on the prompt endpoint (the v1 SDK advertised
  `format: {type:"json_schema"}`, v2 does not) → `structuredOutput: false`.

The mapper still recognises the v1 event names that share a payload shape
(`message.part.delta`, `permission.asked`) so older servers degrade instead of breaking.

### Event mapping

| opencode event | canonical event |
|---|---|
| stream open | `run.started` |
| `session.next.text.delta`, `message.part.delta` | `message.delta` |
| `session.next.text.ended` | `message.completed` |
| `session.next.tool.input.started` | `tool.call.started` (args `{}`) |
| `session.next.tool.input.delta` | `tool.call.args.delta` |
| `session.next.tool.called` | `tool.call.started` with full args (only if not announced) |
| `session.next.tool.success` | `tool.call.completed` (`ok:true`) |
| `session.next.tool.failed` | `tool.call.completed` (`ok:false`) |
| `permission.v2.asked`, `permission.asked` | `permission.requested` |
| `file.edited` | `file.edited` (empty diff) |
| `session.diff` | `file.edited` per file, with patch |
| `session.next.step.ended` | `usage.updated` |
| `session.next.step.failed` | remembered; turns `session.idle` into `run.completed(error)` |
| `session.idle` | `run.completed` (`ok` / `error` / `cancelled`) |
| `session.error` | `run.completed(error)` |
| anything else | dropped, `droppedEvents++` |

## `FakeAdapter`

Deterministic, scripted, cancellable, configurable delay (`delayMs`, default 0). It emits
the canonical happy path used by `scripts/smoke.sh`, the UI demo and the contract test:
`run.started → 2× message.delta → message.completed → read_file call → bash call gated on
permission → file.edited → usage.updated → run.completed(ok)`. Denying the permission
completes the bash call with `ok:false`.

## Contract tests

`test/contract.test.ts` runs the same scenario through `FakeAdapter` and through
`OpencodeAdapter` replayed over a recorded SSE transcript (`test/fixtures/opencode-run.sse`,
captured from `opencode serve` v2). Ids, timestamps, run ids and the harness name are
normalised; **sequence numbers and payload shapes must match exactly**. A second fixture
records the denied-permission path.

## Adding a harness

1. Add the id to `AdapterId` and pick its capabilities honestly — a lie here breaks consumers.
2. Implement `HarnessAdapter`. Translate native payloads into `FactoryEventInput` with a
   mapper class (see `OpencodeEventMapper`) that counts dropped payloads.
3. Stamp events with one `EventSequencer` per run; emit `run.started` first and exactly one
   `run.completed` last.
4. Map permissions to `permission.requested` + `respondToPermission`, or declare
   `permissions: "static"`/`"none"`.
5. Record a real transcript as an SSE/JSONL fixture and add it to `test/contract.test.ts`
   so the new harness is held to the same canonical sequence.
6. Update the capability matrix in this README.
