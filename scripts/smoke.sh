#!/usr/bin/env bash
# End-to-end smoke test for Phase 2a (task 6.3 / 6.5).
#
#   docker compose up -d
#   bash scripts/smoke.sh
#
# Asserts, against a running stack:
#   1. /health is green (db + temporal)
#   1b. the web console serves / (200) and renders the full nav + New Chat composer
#   2. migrations apply (idempotent)
#   3. POST /chat starts a fake-harness run (no model, no network)
#   4. GET /runs/:id/events streams >= 3 events including exactly one terminal event
#   5. an interactive permission is approved and execution continues
#   6. the run directory contains events.jsonl (+ patch.diff) on the host
#   7. Last-Event-ID replay returns only seq > header value
#   8. the inference proxy works with a per-run token against the stub upstream,
#      rejects a disallowed model, and the run detail never leaks the provider key
#   10. permission-blocked runs hold no activity slot: eight waiting runs do not stop a
#      ninth run from completing (delegated to scripts/smoke-permissions.sh, ADR-013)
#   11. one-stage factory loop on the fake stack: create work item → triage gate →
#      approve → assert `stage.changed` (triage→spec) + `gate.decided`, then clean up
#   14. canary rollout (Phase 5b): an improvement pass on `example-lights-off` starts a
#      100% canary, one work item routes to the candidate, a manual rollback returns
#      routing to stable and records `canary.started` + `canary.rolled_back`
#
# Re-runnable: every invocation creates a fresh run; migrations and the proxy stub are
# idempotent. Exits non-zero on any failure.

set -euo pipefail
cd "$(dirname "$0")/.."

API_URL="${API_URL:-http://localhost:8080}"
WEB_URL="${WEB_URL:-http://localhost:3000}"
DATABASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5433/factory}"
RUNS_DIR="${RUNS_DIR:-runs}"
PROVIDER_KEY="${OPENAI_API_KEY:-sk-provider-secret}"
TMP_DIR="$(mktemp -d)"
SSE_PID=""

log() { printf '[smoke] %s\n' "$*"; }
fail() { printf '[smoke] FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf '[smoke] ok: %s\n' "$*"; }

cleanup() {
  if [ -n "$SSE_PID" ] && kill -0 "$SSE_PID" 2>/dev/null; then
    kill "$SSE_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# Reads JSON from stdin and prints a dotted path ("" when missing).
jget() {
  PATH_KEY="$1" bun -e '
    const raw = await Bun.stdin.text();
    const data = JSON.parse(raw || "{}");
    const value = process.env.PATH_KEY.split(".").reduce(
      (acc, part) => (acc == null ? acc : acc[part]),
      data,
    );
    if (value === undefined || value === null) console.log("");
    else if (typeof value === "object") console.log(JSON.stringify(value));
    else console.log(String(value));
  '
}

api() { curl -sS "$@"; }

# ---------------------------------------------------------------- 1. health
log "waiting for $API_URL/health"
health=""
for _ in $(seq 1 90); do
  health="$(api "$API_URL/health" || true)"
  if [ -n "$health" ] && [ "$(printf '%s' "$health" | jget status)" = "ok" ]; then break; fi
  sleep 2
done
[ "$(printf '%s' "$health" | jget status)" = "ok" ] || fail "health is not ok: $health"
pass "health ok ($(printf '%s' "$health" | jget checks.temporal.address))"

# ------------------------------------------------------------ 1b. web console
log "waiting for $WEB_URL/"
web_code=""
for _ in $(seq 1 90); do
  web_code="$(curl -sSL -o "$TMP_DIR/web.html" -w '%{http_code}' "$WEB_URL/" || true)"
  [ "$web_code" = "200" ] && break
  sleep 2
done
[ "$web_code" = "200" ] || fail "web / did not return 200 (got ${web_code:-none})"
grep -q 'data-testid="nav-sidebar"' "$TMP_DIR/web.html" || fail "web nav sidebar did not render"
for label in 'New Chat' 'Inbox' 'Runs' 'MCPs and apps' 'Secrets' 'Users' \
  'Dashboard' 'Agents' 'Automations' 'Scorers' 'Self-improvement' 'Benchmarks' \
  'Definition' 'Gates' 'Settings'; do
  grep -q "$label" "$TMP_DIR/web.html" || fail "nav item '$label' is missing from the rendered shell"
done
grep -q 'data-testid="chat-prompt"' "$TMP_DIR/web.html" || fail "New Chat composer did not render"
grep -q 'data-testid="factory-switcher"' "$TMP_DIR/web.html" || fail "factory switcher did not render"
pass "web / returns 200 with full nav + New Chat composer"

# ------------------------------------------------------------- 2. migrations
log "applying migrations"
DATABASE_URL="$DATABASE_URL" bun scripts/migrate.ts || fail "migrations failed"
pass "migrations applied"

# ------------------------------------------------------------- 3. chat run
log "creating fake-harness chat run"
created="$(api -X POST "$API_URL/chat" \
  -H 'content-type: application/json' \
  -d '{"factory":"example","harness":"fake","fakeDelayMs":250,"prompt":"smoke: read the README"}')"
run_id="$(printf '%s' "$created" | jget run.id)"
model="$(printf '%s' "$created" | jget run.model)"
[ -n "$run_id" ] || fail "no run id in response: $created"
[ "$(printf '%s' "$created" | jget run.harness)" = "fake" ] || fail "harness is not fake"
pass "run $run_id created (model=$model)"

# --------------------------------------------------------- 4. proxy checks
log "exercising the inference proxy"
token_resp="$(api -X POST "$API_URL/runs/$run_id/proxy-token")"
token="$(printf '%s' "$token_resp" | jget token)"
[ -n "$token" ] || fail "no proxy token (is EXPOSE_RUN_TOKEN=1?): $token_resp"
pass "proxy token minted for run"

proxy_body="{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}"
proxy_resp="$(api -X POST "$API_URL/v1/chat/completions" \
  -H "authorization: Bearer $token" -H 'content-type: application/json' -d "$proxy_body")"
printf '%s' "$proxy_resp" | grep -q 'stub model response' \
  || fail "proxy stub call failed: $proxy_resp"
pass "proxy forwards a stub model call"

stream_resp="$(api -N -X POST "$API_URL/v1/chat/completions" \
  -H "authorization: Bearer $token" -H 'content-type: application/json' \
  -d "{\"model\":\"$model\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}")"
printf '%s' "$stream_resp" | grep -q 'data: \[DONE\]' \
  || fail "proxy did not stream: $stream_resp"
pass "proxy streams the upstream response"

status_code="$(curl -sS -o "$TMP_DIR/denied.json" -w '%{http_code}' -X POST "$API_URL/v1/chat/completions" \
  -H "authorization: Bearer $token" -H 'content-type: application/json' \
  -d '{"model":"definitely-not-allowed","messages":[{"role":"user","content":"x"}]}')"
[ "$status_code" = "403" ] || fail "expected 403 for a disallowed model, got $status_code"
[ "$(jget code < "$TMP_DIR/denied.json")" = "model_not_allowed" ] || fail "wrong error code for disallowed model"
pass "proxy enforces the model allowlist"

# ------------------------------------------------------ 5. SSE + permission
log "streaming events and approving the permission request"
api -N --max-time 120 "$API_URL/runs/$run_id/events" > "$TMP_DIR/sse.log" &
SSE_PID=$!

request_id=""
for _ in $(seq 1 120); do
  detail="$(api "$API_URL/runs/$run_id")"
  request_id="$(printf '%s' "$detail" | jget pendingPermissions.0.request_id)"
  [ -n "$request_id" ] && break
  sleep 0.5
done
[ -n "$request_id" ] || fail "no pending permission request appeared"

decision="$(api -X POST "$API_URL/runs/$run_id/permissions/$request_id" \
  -H 'content-type: application/json' -d '{"decision":"allow"}')"
[ "$(printf '%s' "$decision" | jget decision)" = "allow" ] || fail "permission approval failed: $decision"
pass "permission $request_id approved"

wait "$SSE_PID" || fail "SSE stream exited non-zero"
SSE_PID=""

event_count="$(grep -c '^event: ' "$TMP_DIR/sse.log" || true)"
terminal_count="$(grep -c '^event: run.completed' "$TMP_DIR/sse.log" || true)"
[ "$event_count" -ge 3 ] || fail "expected >= 3 SSE events, got $event_count"
[ "$terminal_count" -eq 1 ] || fail "expected exactly one terminal event, got $terminal_count"
grep -q '^event: run.completed' "$TMP_DIR/sse.log" || fail "no terminal event in stream"
pass "SSE streamed $event_count events, exactly one terminal"

# ------------------------------------------------------------ 6. run state
# The SSE stream closes as soon as the terminal event is appended; the run row flips to its
# terminal status a moment later in `finishRunActivity`. Poll instead of racing that write.
detail=""
run_status=""
for _ in $(seq 1 120); do
  detail="$(api "$API_URL/runs/$run_id")"
  run_status="$(printf '%s' "$detail" | jget run.status)"
  case "$run_status" in
    ok|error|cancelled) break ;;
  esac
  sleep 0.5
done
[ "$run_status" = "ok" ] || fail "run did not end ok: $run_status"
pass "run reached status ok"

# ------------------------------------------------------- 6b. scoring (4a)
log "scoring the completed run (deterministic registry + stub judge)"
scoring_resp="$(api -X POST "$API_URL/scoring" \
  -H 'content-type: application/json' \
  -d "{\"factory\":\"example\",\"runId\":\"$run_id\",\"force\":true}")"
score_workflow="$(printf '%s' "$scoring_resp" | jget workflow.workflowId)"
[ -n "$score_workflow" ] || fail "scoring workflow did not start: $scoring_resp"

score_id=""
score_status=""
for _ in $(seq 1 120); do
  scores_resp="$(api "$API_URL/scores?run=$run_id")"
  score_id="$(printf '%s' "$scores_resp" | jget scores.0.id)"
  score_status="$(printf '%s' "$scores_resp" | jget scores.0.status)"
  [ -n "$score_id" ] && break
  sleep 0.5
done
[ -n "$score_id" ] || fail "no score row appeared for run $run_id"
[ "$score_status" = "ok" ] || fail "score status is $score_status, expected ok"
score_label="$(printf '%s' "$scores_resp" | jget scores.0.label)"
[ -n "$score_label" ] || fail "score has no label"
score_uncalibrated="$(printf '%s' "$scores_resp" | jget scores.0.uncalibrated)"
case "$score_uncalibrated" in
  true|false) ;;
  *) fail "judge score has no uncalibrated flag (got '$score_uncalibrated')" ;;
esac

score_detail="$(api "$API_URL/scores/$score_id")"
[ "$(printf '%s' "$score_detail" | jget events.0.type)" = "score.completed" ] \
  || fail "score detail has no score.completed event"
[ "$(printf '%s' "$score_detail" | jget score.rubricHash)" != "" ] \
  || fail "score provenance has no rubric hash"
pass "run $run_id scored ($score_label) with score.completed + provenance"

if printf '%s' "$detail" | grep -q "$PROVIDER_KEY"; then
  fail "run detail leaked the provider key"
fi
# The lease step records env *key names* only. A sandbox may see the proxy base URL and the
# per-run token, nothing else — never a provider credential (ADR-011).
printf '%s' "$detail" | bun -e '
  const raw = await Bun.stdin.text();
  const detail = JSON.parse(raw || "{}");
  const lease = (detail.steps ?? []).find((step) => step.step_id === "lease-runner");
  if (!lease) { console.error("no lease-runner step"); process.exit(1); }
  const keys = (lease.detail ?? {}).envKeys ?? [];
  const allowed = ["OPENAI_BASE_URL", "OPENAI_API_KEY"];
  const extra = keys.filter((key) => !allowed.includes(key));
  if (extra.length > 0) { console.error(`runner env has non-proxy keys: ${extra}`); process.exit(1); }
  if (JSON.stringify(lease.detail ?? {}).includes("sk-provider-secret")) {
    console.error("lease detail leaked the provider key");
    process.exit(1);
  }
' || fail "runner env is not proxy-only"
pass "run detail contains no provider key (runner env is proxy-only)"

# --------------------------------------------------------------- 7. replay
log "checking Last-Event-ID replay"
replay="$(api -H 'Last-Event-ID: 3' "$API_URL/runs/$run_id/events")"
first_id="$(printf '%s' "$replay" | grep -m1 '^id: ' | awk '{print $2}')"
[ "$first_id" = "4" ] || fail "replay after Last-Event-ID: 3 started at id $first_id"
if printf '%s' "$replay" | grep -q '^id: [123]$'; then fail "replay repeated an already-seen event"; fi
pass "replay resumed at seq 4"

# ---------------------------------------------------------- 8. run directory
log "checking the run directory"
events_file="$RUNS_DIR/$run_id/events.jsonl"
[ -f "$events_file" ] || fail "missing $events_file"
lines="$(wc -l < "$events_file" | tr -d ' ')"
[ "$lines" -ge 3 ] || fail "events.jsonl has only $lines lines"
[ -f "$RUNS_DIR/$run_id/patch.diff" ] || fail "missing patch.diff"
last_line_type="$(tail -n 1 "$events_file" | jget type)"
[ "$last_line_type" = "run.completed" ] || fail "last JSONL line is $last_line_type"
pass "run directory has events.jsonl ($lines events) + patch.diff"

# ----------------------------------------------------------- 9. token revoked
status_code="$(curl -sS -o "$TMP_DIR/revoked.json" -w '%{http_code}' -X POST "$API_URL/v1/chat/completions" \
  -H "authorization: Bearer $token" -H 'content-type: application/json' -d "$proxy_body")"
[ "$status_code" = "401" ] || fail "expected 401 after run end, got $status_code"
[ "$(jget code < "$TMP_DIR/revoked.json")" = "token_revoked" ] || fail "wrong error code after run end"
pass "proxy token revoked at run end"

# ------------------------------------- 10. permission waits do not block the queue
log "checking that permission-blocked runs do not starve the queue (ADR-013)"
API_URL="$API_URL" bash scripts/smoke-permissions.sh \
  || fail "permission non-blocking smoke failed"

# ---------------------------------------- 11. factory loop (one stage, fake forge)
log "running a one-stage factory loop (fake harness + fake forge)"
loop_created="$(api -X POST "$API_URL/work-items" \
  -H 'content-type: application/json' \
  -d '{"factory":"example","title":"smoke: loop stage","type":"task","source":"manual","harness":"fake","prompt":"smoke: fix the broken readme link"}')"
loop_id="$(printf '%s' "$loop_created" | jget workItem.id)"
[ -n "$loop_id" ] || fail "no work item id in response: $loop_created"
[ "$(printf '%s' "$loop_created" | jget workItem.stage)" = "triage" ] \
  || fail "work item did not start in triage"
[ "$(printf '%s' "$loop_created" | jget workItem.factory)" = "example" ] \
  || fail "work item factory is not example"

# The triage stage runs on the fake harness, then parks on a durable human gate.
gate_stage=""
detail=""
for _ in $(seq 1 120); do
  detail="$(api "$API_URL/work-items/$loop_id")"
  gate_stage="$(printf '%s' "$detail" | jget pendingGate.stage)"
  [ -n "$gate_stage" ] && break
  sleep 0.5
done
[ "$gate_stage" = "triage" ] || fail "expected a pending triage gate, got '${gate_stage:-none}'"
[ "$(printf '%s' "$detail" | jget pendingGate.gate)" = "human" ] || fail "triage gate is not human"
pass "work item $loop_id reached the triage gate"

decision="$(api -X POST "$API_URL/work-items/$loop_id/gates/triage" \
  -H 'content-type: application/json' \
  -d '{"decision":"approve","actor":"smoke","reason":"smoke: triage looks scoped"}')"
[ "$(printf '%s' "$decision" | jget decision)" = "approve" ] \
  || fail "gate decision failed: $decision"
[ "$(printf '%s' "$decision" | jget delivery)" = "update" ] \
  || fail "gate decision was not delivered as a Temporal Update: $decision"

transitioned=0
for _ in $(seq 1 120); do
  detail="$(api "$API_URL/work-items/$loop_id")"
  stage="$(printf '%s' "$detail" | jget workItem.stage)"
  if [ "$stage" != "triage" ]; then transitioned=1; break; fi
  sleep 0.5
done
[ "$transitioned" = "1" ] || fail "work item did not leave triage after the gate decision"

printf '%s' "$detail" | bun -e '
  const d = JSON.parse(await Bun.stdin.text());
  const events = d.events ?? [];
  const types = new Set(events.map((e) => e.type));
  const changed = events.find((e) => e.type === "stage.changed");
  if (!types.has("gate.decided")) { console.error("no gate.decided event"); process.exit(1); }
  if (!changed) { console.error("no stage.changed event"); process.exit(1); }
  if (changed.payload.from !== "triage" || changed.payload.to !== "spec") {
    console.error(`unexpected transition ${changed.payload.from} -> ${changed.payload.to}`);
    process.exit(1);
  }
  if (changed.payload.by !== "foreman") {
    console.error("transition is not attributed to the foreman");
    process.exit(1);
  }
' || fail "stage transition / event assertions failed"
pass "work item $loop_id: triage gate approved → spec (stage.changed + gate.decided recorded)"

# Cleanup: reject the next pending gate so the smoke leaves no parked workflow.
next_stage=""
for _ in $(seq 1 60); do
  detail="$(api "$API_URL/work-items/$loop_id")"
  next_stage="$(printf '%s' "$detail" | jget pendingGate.stage)"
  [ -n "$next_stage" ] && break
  sleep 0.5
done
if [ -n "$next_stage" ]; then
  api -X POST "$API_URL/work-items/$loop_id/gates/$next_stage" \
    -H 'content-type: application/json' \
    -d '{"decision":"reject","actor":"smoke","reason":"smoke: cleanup"}' >/dev/null
fi
pass "one-stage loop verified and cleaned up"

# ---------------------------------------- 12. benchmarks (Phase 4b, fake stack)
log "calibrating the judge, then running a tiny benchmark (1 task × 2 configs)"
calibration_resp="$(api -X POST "$API_URL/calibration" \
  -H 'content-type: application/json' \
  -d "{\"factory\":\"example\",\"scorer\":\"scope\",\"name\":\"smoke benchmark calibration\",\"minSize\":1,\"threshold\":1,\"items\":[{\"runId\":\"$run_id\",\"humanLabel\":\"compliant\"}]}")"
[ "$(printf '%s' "$calibration_resp" | jget calibration.verdict)" = "pass" ] \
  || fail "calibration did not pass: $calibration_resp"
pass "judge calibrated against the smoke run"

benchmark_resp="$(api -X POST "$API_URL/factories/example/benchmarks/review/run" \
  -H 'content-type: application/json' \
  -d '{"configurations":["Baseline","Candidate"],"tasks":["broken-doc-link"],"confirm":true,"maxCostUsd":10}')"
benchmark_id="$(printf '%s' "$benchmark_resp" | jget benchmark.id)"
[ -n "$benchmark_id" ] || fail "benchmark did not start: $benchmark_resp"
benchmark_config_hash="$(printf '%s' "$benchmark_resp" | jget benchmark.configHash)"
[ -n "$benchmark_config_hash" ] || fail "benchmark has no configHash: $benchmark_resp"
pass "benchmark $benchmark_id started (configHash ${benchmark_config_hash:0:12})"

benchmark_detail=""
benchmark_status=""
for _ in $(seq 1 240); do
  benchmark_detail="$(api "$API_URL/benchmarks/$benchmark_id")"
  benchmark_status="$(printf '%s' "$benchmark_detail" | jget benchmark.status)"
  started_event="$(printf '%s' "$benchmark_detail" | jget events.0.type)"
  completed_event="$(printf '%s' "$benchmark_detail" | jget events.1.type)"
  if [ "$benchmark_status" = "completed" ] \
    && [ "$started_event" = "benchmark.started" ] \
    && [ "$completed_event" = "benchmark.completed" ]; then
    break
  fi
  case "$benchmark_status" in
    error|cancelled) break ;;
  esac
  sleep 0.5
done
[ "$benchmark_status" = "completed" ] || fail "benchmark did not complete: $benchmark_status"

printf '%s' "$benchmark_detail" | bun -e '
  const d = JSON.parse(await Bun.stdin.text());
  const benchmark = d.benchmark ?? {};
  const trials = d.trials ?? [];
  const results = d.results ?? [];
  if (trials.length !== 2) { console.error(`expected 2 trials, got ${trials.length}`); process.exit(1); }
  if (!trials.every((trial) => trial.status === "ok")) {
    console.error(`a trial did not finish ok: ${trials.map((trial) => trial.status).join(",")}`);
    process.exit(1);
  }
  if (results.length !== 2) { console.error(`expected 2 result rows, got ${results.length}`); process.exit(1); }
  if (!results.every((row) => row.passRate === 1)) {
    console.error(`a configuration did not pass every trial: ${JSON.stringify(results)}`);
    process.exit(1);
  }
  if (benchmark.passed !== true) { console.error("benchmark is not passed"); process.exit(1); }
  if (benchmark.calibrationOk !== true) { console.error("benchmark is not calibrated"); process.exit(1); }
  if (benchmark.budgetExhausted !== false) { console.error("benchmark unexpectedly exhausted its budget"); process.exit(1); }
  if (!d.attestation) { console.error("no attestation recorded"); process.exit(1); }
  if (d.attestation.passed !== true || d.attestation.calibrationOk !== true) {
    console.error("attestation is not passing + calibrated");
    process.exit(1);
  }
  if (d.attestation.configHash !== benchmark.configHash) {
    console.error("attestation configHash does not match the run");
    process.exit(1);
  }
  const types = new Set((d.events ?? []).map((event) => event.type));
  if (!types.has("benchmark.started") || !types.has("benchmark.completed")) {
    console.error(`missing benchmark events: ${[...types].join(",")}`);
    process.exit(1);
  }
' || fail "benchmark matrix / attestation assertions failed"
pass "benchmark $benchmark_id: 2 trials, 2 results, pass rate 1, attestation recorded"

attestations_resp="$(api "$API_URL/factories/example/attestations")"
printf '%s' "$attestations_resp" | bun -e '
  const d = JSON.parse(await Bun.stdin.text());
  const rows = d.attestations ?? [];
  if (rows.length === 0) { console.error("no attestation rows for the factory"); process.exit(1); }
  if (!rows.some((row) => row.passed && row.calibrationOk)) {
    console.error("no passing, calibrated attestation row");
    process.exit(1);
  }
' || fail "attestation lookup assertions failed"
pass "attestation row is queryable by (factory, definitionCommit, configHash)"

# ---------------------------------------- 13. self-improvement (Phase 5)
log "creating a failed scored run for the improvement corpus"
cancel_created="$(api -X POST "$API_URL/chat" \
  -H 'content-type: application/json' \
  -d '{"factory":"example","harness":"fake","fakeDelayMs":8000,"prompt":"smoke: improvement corpus failure"}')"
cancel_run_id="$(printf '%s' "$cancel_created" | jget run.id)"
[ -n "$cancel_run_id" ] || fail "no cancelled-corpus run id: $cancel_created"
api -X POST "$API_URL/runs/$cancel_run_id/cancel" \
  -H 'content-type: application/json' -d '{"reason":"smoke: improvement corpus failure"}' >/dev/null

cancel_status=""
for _ in $(seq 1 120); do
  cancel_status="$(api "$API_URL/runs/$cancel_run_id" | jget run.status)"
  case "$cancel_status" in
    cancelled|error) break ;;
    ok) fail "corpus run completed before it could be cancelled" ;;
  esac
  sleep 0.5
done
[ "$cancel_status" = "cancelled" ] || fail "corpus run did not reach cancelled (got ${cancel_status:-none})"
pass "corpus run $cancel_run_id cancelled"

api -X POST "$API_URL/scoring" \
  -H 'content-type: application/json' \
  -d "{\"factory\":\"example\",\"runId\":\"$cancel_run_id\",\"force\":true}" >/dev/null
corpus_score_id=""
for _ in $(seq 1 120); do
  corpus_scores="$(api "$API_URL/scores?run=$cancel_run_id")"
  corpus_score_id="$(printf '%s' "$corpus_scores" | jget scores.0.id)"
  [ -n "$corpus_score_id" ] && break
  sleep 0.5
done
[ -n "$corpus_score_id" ] || fail "the cancelled corpus run was not scored"
pass "cancelled corpus run scored ($corpus_score_id)"

log "checking the authority-change preview (diff, no write)"
authority_preview="$(api -X POST "$API_URL/factories/example/improvement/authority" \
  -H 'content-type: application/json' \
  -d '{"authority":"auto_merge_on_benchmark","actor":"smoke","reason":"smoke: preview only"}')"
[ "$(printf '%s' "$authority_preview" | jget confirmationRequired)" = "true" ] \
  || fail "authority preview did not ask for confirmation: $authority_preview"
printf '%s' "$authority_preview" | grep -q 'propose_only -> auto_merge_on_benchmark' \
  || fail "authority preview has no diff: $authority_preview"
pass "authority preview returns the diff and requires confirmation"

log "running one improvement pass (eligibility → observe → probe → compose → decide)"
improvement_resp="$(api -X POST "$API_URL/factories/example/improvement/run" \
  -H 'content-type: application/json' -d '{"trigger":"on_demand"}')"
improvement_id="$(printf '%s' "$improvement_resp" | jget improvement.id)"
[ -n "$improvement_id" ] || fail "improvement run did not start: $improvement_resp"
pass "improvement run $improvement_id started (authority $(printf '%s' "$improvement_resp" | jget improvement.authority))"

improvement_detail=""
improvement_status=""
improvement_decision=""
for _ in $(seq 1 240); do
  improvement_detail="$(api "$API_URL/improvements/$improvement_id")"
  improvement_status="$(printf '%s' "$improvement_detail" | jget improvement.status)"
  improvement_decision="$(printf '%s' "$improvement_detail" | jget improvement.decision)"
  case "$improvement_status" in
    completed|skipped|error) break ;;
  esac
  sleep 0.5
done
[ "$improvement_status" = "completed" ] || fail "improvement run did not complete: ${improvement_status:-none} $(printf '%s' "$improvement_detail" | jget improvement.error)"
[ "$improvement_decision" = "pr_opened" ] || fail "improvement decision is ${improvement_decision:-none}, expected pr_opened"

printf '%s' "$improvement_detail" | bun -e '
  const d = JSON.parse(await Bun.stdin.text());
  const run = d.improvement ?? {};
  const proposals = d.proposals ?? [];
  if (run.eligibility?.eligible !== true) {
    console.error(`improvement run was not eligible: ${JSON.stringify(run.eligibility)}`);
    process.exit(1);
  }
  if (proposals.length < 1) { console.error("no proposal produced"); process.exit(1); }
  const proposal = proposals[0];
  if (proposal.status !== "pr_open") { console.error(`proposal status ${proposal.status}`); process.exit(1); }
  if (!proposal.candidateHash || !/^[0-9a-f]{64}$/.test(proposal.candidateHash)) {
    console.error("proposal has no candidate hash"); process.exit(1);
  }
  if (!Array.isArray(proposal.diff) || proposal.diff.length === 0) {
    console.error("proposal has no diff"); process.exit(1);
  }
  if (!Array.isArray(proposal.files) || proposal.files.length === 0) {
    console.error("proposal has no files"); process.exit(1);
  }
  if (typeof proposal.impact !== "number" || proposal.impact <= 0) {
    console.error("proposal has no positive impact"); process.exit(1);
  }
  if (!proposal.prUrl) { console.error("proposal has no PR url"); process.exit(1); }
  const probes = proposal.probes ?? [];
  if (probes.length === 0) { console.error("proposal has no probes"); process.exit(1); }
  if (!probes.some((probe) => probe.winner)) { console.error("no probe winner"); process.exit(1); }
  const types = new Set((d.events ?? []).map((event) => event.type));
  for (const type of ["improvement.started", "proposal.created", "probe.completed", "candidate.published"]) {
    if (!types.has(type)) { console.error(`missing improvement event ${type}`); process.exit(1); }
  }
  const lessons = d.lessons ?? [];
  if (lessons.length < 1) { console.error("no lesson recorded"); process.exit(1); }
  if (!lessons.some((lesson) => lesson.cue && lesson.confidence > 0)) {
    console.error("lesson has no cue/confidence"); process.exit(1);
  }
' || fail "improvement proposal / probe / candidate / PR / lesson assertions failed"
pass "improvement $improvement_id: proposal + probes + candidate + PR + lesson recorded"

lessons_resp="$(api "$API_URL/lessons?factory=example")"
printf '%s' "$lessons_resp" | bun -e '
  const d = JSON.parse(await Bun.stdin.text());
  const lessons = d.lessons ?? [];
  if (lessons.length === 0) { console.error("no lessons for the factory"); process.exit(1); }
  if (!lessons.every((lesson) => lesson.factory === "example" || lesson.promoted)) {
    console.error("lesson isolation violated"); process.exit(1);
  }
' || fail "lesson library assertions failed"
pass "experience library lists per-factory lessons only (plus promoted)"

# ------------------------------- 14. canary rollout + rollback (Phase 5b, ADR-021)
CANARY_FACTORY="example-lights-off"
log "creating a scored corpus for $CANARY_FACTORY"
canary_created="$(api -X POST "$API_URL/chat" \
  -H 'content-type: application/json' \
  -d "{\"factory\":\"$CANARY_FACTORY\",\"harness\":\"fake\",\"fakeDelayMs\":8000,\"prompt\":\"smoke: canary corpus failure\"}")"
canary_run_id="$(printf '%s' "$canary_created" | jget run.id)"
[ -n "$canary_run_id" ] || fail "no canary corpus run id: $canary_created"
api -X POST "$API_URL/runs/$canary_run_id/cancel" \
  -H 'content-type: application/json' -d '{"reason":"smoke: canary corpus failure"}' >/dev/null

canary_run_status=""
for _ in $(seq 1 120); do
  canary_run_status="$(api "$API_URL/runs/$canary_run_id" | jget run.status)"
  case "$canary_run_status" in
    cancelled|error) break ;;
    ok) fail "canary corpus run completed before it could be cancelled" ;;
  esac
  sleep 0.5
done
[ "$canary_run_status" = "cancelled" ] || fail "canary corpus run did not reach cancelled (got ${canary_run_status:-none})"

api -X POST "$API_URL/scoring" \
  -H 'content-type: application/json' \
  -d "{\"factory\":\"$CANARY_FACTORY\",\"runId\":\"$canary_run_id\",\"force\":true}" >/dev/null
canary_score_id=""
for _ in $(seq 1 120); do
  canary_score_id="$(api "$API_URL/scores?run=$canary_run_id" | jget scores.0.id)"
  [ -n "$canary_score_id" ] && break
  sleep 0.5
done
[ -n "$canary_score_id" ] || fail "the canary corpus run was not scored"

# Calibration is per factory: the canary factory needs its own passing judge calibration
# before the observer is eligible.
canary_calibration="$(api -X POST "$API_URL/calibration" \
  -H 'content-type: application/json' \
  -d "{\"factory\":\"$CANARY_FACTORY\",\"scorer\":\"scope\",\"name\":\"smoke canary calibration\",\"minSize\":1,\"threshold\":1,\"items\":[{\"runId\":\"$canary_run_id\",\"humanLabel\":\"compliant\"}]}")"
[ "$(printf '%s' "$canary_calibration" | jget calibration.verdict)" = "pass" ] \
  || fail "canary calibration did not pass: $canary_calibration"
pass "canary corpus run scored and the judge calibrated for $CANARY_FACTORY"

log "running an improvement pass that starts a 100% canary rollout"
canary_improvement="$(api -X POST "$API_URL/factories/$CANARY_FACTORY/improvement/run" \
  -H 'content-type: application/json' \
  -d '{"trigger":"on_demand","canaryPercent":100}')"
canary_improvement_id="$(printf '%s' "$canary_improvement" | jget improvement.id)"
[ -n "$canary_improvement_id" ] || fail "canary improvement run did not start: $canary_improvement"

canary_improvement_status=""
canary_improvement_decision=""
for _ in $(seq 1 240); do
  canary_improvement_detail="$(api "$API_URL/improvements/$canary_improvement_id")"
  canary_improvement_status="$(printf '%s' "$canary_improvement_detail" | jget improvement.status)"
  canary_improvement_decision="$(printf '%s' "$canary_improvement_detail" | jget improvement.decision)"
  case "$canary_improvement_status" in
    completed|skipped|error) break ;;
  esac
  sleep 0.5
done
[ "$canary_improvement_status" = "completed" ] \
  || fail "canary improvement run did not complete: ${canary_improvement_status:-none} $(printf '%s' "$canary_improvement_detail" | jget improvement.error)"
[ "$canary_improvement_decision" = "canary_started" ] \
  || fail "canary improvement decision is ${canary_improvement_decision:-none}, expected canary_started"
pass "improvement run $canary_improvement_id decided canary_started"

canary_view=""
canary_rollout_id=""
canary_candidate_commit=""
for _ in $(seq 1 120); do
  canary_view="$(api "$API_URL/factories/$CANARY_FACTORY/canary")"
  canary_rollout_id="$(printf '%s' "$canary_view" | jget active.rollout.id)"
  canary_candidate_commit="$(printf '%s' "$canary_view" | jget active.rollout.candidateCommit)"
  if [ "$(printf '%s' "$canary_view" | jget active.rollout.status)" = "active" ] && [ -n "$canary_candidate_commit" ]; then break; fi
  sleep 0.5
done
[ -n "$canary_rollout_id" ] || fail "no active canary rollout: $canary_view"
printf '%s' "$canary_view" | bun -e '
  const d = JSON.parse(await Bun.stdin.text());
  const active = d.active ?? {};
  const rollout = active.rollout ?? {};
  if (rollout.status !== "active") { console.error(`rollout status ${rollout.status}`); process.exit(1); }
  if (active.split?.canaryPercent !== 100 || active.split?.stablePercent !== 0) {
    console.error(`unexpected split ${JSON.stringify(active.split)}`);
    process.exit(1);
  }
  if (!/^factory-v\d+-candidate$/.test(rollout.candidateVersion ?? "")) {
    console.error(`candidate version ${rollout.candidateVersion}`); process.exit(1);
  }
  if (!rollout.stableVersion) { console.error("no stable version"); process.exit(1); }
  if (!/^[0-9a-f]{40}$/.test(rollout.candidateCommit ?? "")) {
    console.error(`candidate commit ${rollout.candidateCommit}`); process.exit(1);
  }
  if (!(active.window?.remainingMs > 0)) { console.error("window already closed"); process.exit(1); }
  const types = (active.events ?? []).map((event) => event.type);
  if (!types.includes("canary.started")) { console.error(`missing canary.started: ${types.join(",")}`); process.exit(1); }
  if (typeof active.metrics?.stable?.passRate !== "number" && active.metrics?.stable?.scores !== 0) {
    console.error(`unexpected stable metrics ${JSON.stringify(active.metrics?.stable)}`); process.exit(1);
  }
' || fail "canary projection assertions failed"
pass "canary $canary_rollout_id active at 100% (candidate $canary_candidate_commit, window open)"

log "routing one work item to the candidate version"
canary_item="$(api -X POST "$API_URL/work-items" \
  -H 'content-type: application/json' \
  -d "{\"factory\":\"$CANARY_FACTORY\",\"title\":\"smoke: canary routing\",\"harness\":\"fake\"}")"
canary_item_id="$(printf '%s' "$canary_item" | jget workItem.id)"
[ -n "$canary_item_id" ] || fail "canary work item was not created: $canary_item"
[ "$(printf '%s' "$canary_item" | jget workItem.definitionVersion)" = "candidate" ] \
  || fail "work item did not route to the candidate: $canary_item"
[ "$(printf '%s' "$canary_item" | jget workItem.canaryRolloutId)" = "$canary_rollout_id" ] \
  || fail "work item did not record the rollout: $canary_item"
[ "$(printf '%s' "$canary_item" | jget workItem.definitionCommit)" = "$canary_candidate_commit" ] \
  || fail "work item did not pin the candidate commit: $canary_item"
pass "work item $canary_item_id routed to candidate $canary_candidate_commit"

log "rolling the canary back manually"
canary_rollback="$(api -X POST "$API_URL/canary/rollback" \
  -H 'content-type: application/json' \
  -d "{\"factory\":\"$CANARY_FACTORY\",\"rolloutId\":\"$canary_rollout_id\",\"actor\":\"smoke\",\"reason\":\"smoke: manual rollback\"}")"
[ "$(printf '%s' "$canary_rollback" | jget rollout.status)" = "rolled_back" ] \
  || fail "canary rollback did not end the rollout: $canary_rollback"
[ "$(printf '%s' "$canary_rollback" | jget rollout.reason)" = "smoke: manual rollback" ] \
  || fail "rollback reason not recorded: $canary_rollback"
pass "canary $canary_rollout_id rolled back (reason recorded)"

canary_after="$(api "$API_URL/factories/$CANARY_FACTORY/canary")"
printf '%s' "$canary_after" | ROLLOUT_ID="$canary_rollout_id" bun -e '
  const d = JSON.parse(await Bun.stdin.text());
  if (d.active !== null) { console.error("an active rollout survived the rollback"); process.exit(1); }
  const entry = (d.history ?? []).find((row) => row.rollout.id === process.env.ROLLOUT_ID);
  if (!entry) { console.error("rolled-back rollout missing from history"); process.exit(1); }
  if (entry.rollout.status !== "rolled_back") { console.error(`history status ${entry.rollout.status}`); process.exit(1); }
  const types = (entry.events ?? []).map((event) => event.type);
  for (const type of ["canary.started", "canary.rolled_back"]) {
    if (!types.includes(type)) { console.error(`missing ${type}: ${types.join(",")}`); process.exit(1); }
  }
  const rollback = (entry.events ?? []).find((event) => event.type === "canary.rolled_back");
  if (rollback?.payload?.reason !== "smoke: manual rollback") {
    console.error(`rollback event reason ${rollback?.payload?.reason}`); process.exit(1);
  }
  if (rollback?.payload?.automatic !== false) { console.error("manual rollback marked automatic"); process.exit(1); }
' || fail "canary history / audit event assertions failed"
pass "canary history records canary.started + canary.rolled_back with reason + evidence"

log "asserting routing returned to stable"
canary_stable_item="$(api -X POST "$API_URL/work-items" \
  -H 'content-type: application/json' \
  -d "{\"factory\":\"$CANARY_FACTORY\",\"title\":\"smoke: canary post-rollback\",\"harness\":\"fake\"}")"
canary_stable_item_id="$(printf '%s' "$canary_stable_item" | jget workItem.id)"
[ "$(printf '%s' "$canary_stable_item" | jget workItem.definitionVersion)" = "stable" ] \
  || fail "routing did not return to stable after rollback: $canary_stable_item"
[ -z "$(printf '%s' "$canary_stable_item" | jget workItem.canaryRolloutId)" ] \
  || fail "a rolled-back rollout still routes work: $canary_stable_item"
pass "new work items route to stable after rollback"

# Cleanup: reject the pending gates so the smoke leaves no parked workflows.
for item_id in "$canary_item_id" "$canary_stable_item_id"; do
  gate_stage=""
  for _ in $(seq 1 60); do
    gate_stage="$(api "$API_URL/work-items/$item_id" | jget pendingGate.stage)"
    [ -n "$gate_stage" ] && break
    sleep 0.5
  done
  if [ -n "$gate_stage" ]; then
    api -X POST "$API_URL/work-items/$item_id/gates/$gate_stage" \
      -H 'content-type: application/json' \
      -d '{"decision":"reject","actor":"smoke","reason":"smoke: canary cleanup"}' >/dev/null
  fi
done
pass "canary work items cleaned up"

# ------------------------------- 15. webhooks (Phase 3b, ADR-023)
WEBHOOK_SECRET="${GITHUB_WEBHOOK_SECRET:-smoke-webhook-secret}"
log "configuring the GitHub integration and delivering a signed webhook"
integration="$(api -X POST "$API_URL/integrations/github" \
  -H 'content-type: application/json' \
  -d '{"factory":"example","secretRef":"GITHUB_TOKEN","webhookSecretRef":"GITHUB_WEBHOOK_SECRET","repos":[{"owner":"acme","name":"api-service"}],"events":["issues"],"labels":["factory-ready"],"dryRun":true,"mergeQueue":false,"harness":"fake","runner":"fake"}')"
[ "$(printf '%s' "$integration" | jget github.configured)" = "true" ] \
  || fail "github integration was not configured: $integration"
[ "$(printf '%s' "$integration" | jget github.webhookSecretConfigured)" = "true" ] \
  || fail "the webhook secret reference was not resolved"
pass "github integration configured by secret reference"

webhook_payload="$(cat <<JSON
{"action":"labeled","repository":{"full_name":"acme/api-service"},"sender":{"login":"smoke","type":"User"},"label":{"name":"factory-ready"},"issue":{"number":9001,"title":"smoke: webhook intake","html_url":"https://github.com/acme/api-service/issues/9001","labels":[{"name":"factory-ready"}]}}
JSON
)"

# Unsigned → 401 invalid_signature, no work item.
unsigned_code="$(curl -sS -o "$TMP_DIR/webhook-unsigned.json" -w '%{http_code}' -X POST "$API_URL/webhooks/github" \
  -H 'content-type: application/json' -H 'x-github-event: issues' \
  -H "x-github-delivery: smoke-unsigned-$(date +%s)" -d "$webhook_payload")"
[ "$unsigned_code" = "401" ] || fail "expected 401 for an unsigned webhook, got $unsigned_code"
[ "$(jget code < "$TMP_DIR/webhook-unsigned.json")" = "invalid_signature" ] \
  || fail "wrong error code for an unsigned webhook"
pass "unsigned webhook rejected with invalid_signature"

signature="$(SECRET="$WEBHOOK_SECRET" BODY="$webhook_payload" bun -e '
  const { createHmac } = require("node:crypto");
  process.stdout.write("sha256=" + createHmac("sha256", process.env.SECRET).update(process.env.BODY, "utf8").digest("hex"));
')"
delivery_id="smoke-signed-$(date +%s)"
webhook_resp="$(api -X POST "$API_URL/webhooks/github" \
  -H 'content-type: application/json' -H 'x-github-event: issues' \
  -H "x-github-delivery: $delivery_id" -H "x-hub-signature-256: $signature" \
  -d "$webhook_payload")"
[ "$(printf '%s' "$webhook_resp" | jget status)" = "accepted" ] \
  || fail "signed webhook was not accepted: $webhook_resp"
webhook_item="$(printf '%s' "$webhook_resp" | jget workItemId)"
[ -n "$webhook_item" ] || fail "signed webhook created no work item: $webhook_resp"

webhook_detail="$(api "$API_URL/work-items/$webhook_item")"
[ "$(printf '%s' "$webhook_detail" | jget workItem.source)" = "forge" ] \
  || fail "webhook work item source is not forge"
printf '%s' "$webhook_detail" | bun -e '
  const d = JSON.parse(await Bun.stdin.text());
  const ref = d.workItem?.sourceRef ?? {};
  if (ref.untrusted !== true) { console.error("sourceRef is not framed as untrusted"); process.exit(1); }
  if (ref.kind !== "issue" || ref.repo !== "acme/api-service") {
    console.error(`unexpected sourceRef ${JSON.stringify(ref)}`); process.exit(1);
  }
' || fail "webhook work item sourceRef assertions failed"
pass "signed webhook created work item $webhook_item (source forge, sourceRef untrusted)"

# Redelivery of the same delivery id is acknowledged and ignored.
duplicate="$(api -X POST "$API_URL/webhooks/github" \
  -H 'content-type: application/json' -H 'x-github-event: issues' \
  -H "x-github-delivery: $delivery_id" -H "x-hub-signature-256: $signature" \
  -d "$webhook_payload")"
[ "$(printf '%s' "$duplicate" | jget status)" = "ignored" ] \
  || fail "redelivered webhook was not ignored: $duplicate"
[ "$(printf '%s' "$duplicate" | jget reason)" = "duplicate_delivery" ] \
  || fail "redelivered webhook reason is not duplicate_delivery"
pass "duplicate delivery acknowledged and ignored"

# Cleanup: the webhook item parks on the triage gate; reject it so nothing is left waiting.
webhook_gate=""
for _ in $(seq 1 120); do
  webhook_gate="$(api "$API_URL/work-items/$webhook_item" | jget pendingGate.stage)"
  [ -n "$webhook_gate" ] && break
  sleep 0.5
done
if [ -n "$webhook_gate" ]; then
  api -X POST "$API_URL/work-items/$webhook_item/gates/$webhook_gate" \
    -H 'content-type: application/json' \
    -d '{"decision":"reject","actor":"smoke","reason":"smoke: webhook cleanup"}' >/dev/null
fi

# ------------------------------- 16. merge queue + automations (Phase 3b)
log "checking the merge queue and automation projections"
merge_queue="$(api "$API_URL/factories/example/merge-queue")"
[ "$(printf '%s' "$merge_queue" | jget batchSize)" = "2" ] \
  || fail "merge queue batch size is not 2: $merge_queue"
pass "merge queue projection returns batch size + batches"

sync_resp="$(api -X POST "$API_URL/factories/example/automations/sync" \
  -H 'content-type: application/json' -d '{"factory":"example"}')"
printf '%s' "$sync_resp" | bun -e '
  const d = JSON.parse(await Bun.stdin.text());
  const nightly = (d.schedules ?? []).find((row) => row.automation === "nightly");
  if (!nightly) { console.error("no nightly schedule row"); process.exit(1); }
  if (nightly.status !== "active") { console.error(`nightly status ${nightly.status}`); process.exit(1); }
  if (nightly.cron !== "0 3 * * *") { console.error(`nightly cron ${nightly.cron}`); process.exit(1); }
' || fail "automation schedule sync assertions failed"
pass "nightly cron automation synced to a Temporal schedule (active)"

automations="$(api "$API_URL/factories/example/automations")"
[ "$(printf '%s' "$automations" | jget webhook.url)" != "" ] || fail "automations has no webhook url"
pass "automations projection exposes webhook url + cron status"

# ------------------------------- 17. autonomy read + work-item cancel + rebuild
log "checking the autonomy read model, work-item cancellation and the rebuild dry run"

autonomy_read="$(api "$API_URL/autonomy?factory=example")"
printf '%s' "$autonomy_read" | bun -e '
  const d = JSON.parse(await Bun.stdin.text());
  const a = d.autonomy;
  if (!a) { console.error("no autonomy payload"); process.exit(1); }
  if (a.factory !== "example") { console.error(`factory ${a.factory}`); process.exit(1); }
  if (typeof a.enabled !== "boolean" || typeof a.paused !== "boolean") {
    console.error("enabled/paused are not booleans"); process.exit(1);
  }
  const stages = a.declared?.stages ?? {};
  if (!stages.spec?.gate) { console.error("no declared triage gate"); process.exit(1); }
  if (!a.declared?.mergePolicy) { console.error("no declared merge policy"); process.exit(1); }
  if (!a.everEnabled && a.updatedAt !== null) {
    console.error("an unrecorded autonomy state invented a timestamp"); process.exit(1);
  }
  if (a.lastEvent && !String(a.lastEvent.type).startsWith("autonomy.")) {
    console.error(`lastEvent is not autonomy.*: ${a.lastEvent.type}`); process.exit(1);
  }
' || fail "autonomy read assertions failed"
pass "GET /autonomy returns the declared policy, live state and newest autonomy event"

cancel_created="$(api -X POST "$API_URL/work-items" \
  -H 'content-type: application/json' \
  -d '{"factory":"example","title":"smoke: cancel me","harness":"fake"}')"
cancel_id="$(printf '%s' "$cancel_created" | jget workItem.id)"
[ -n "$cancel_id" ] || fail "no work item id for cancellation: $cancel_created"
for _ in $(seq 1 120); do
  cancel_detail="$(api "$API_URL/work-items/$cancel_id")"
  cancel_gate="$(printf '%s' "$cancel_detail" | jget pendingGate.stage)"
  [ -n "$cancel_gate" ] && break
  sleep 0.5
done
[ -n "${cancel_gate:-}" ] || fail "work item $cancel_id never reached a gate"

cancel_resp="$(api -X POST "$API_URL/work-items/$cancel_id/cancel" \
  -H 'content-type: application/json' \
  -d '{"actor":"smoke","reason":"smoke: cancel the parked item"}')"
[ "$(printf '%s' "$cancel_resp" | jget eventRecorded)" = "true" ] \
  || fail "cancel did not record the request: $cancel_resp"

cancelled=0
for _ in $(seq 1 120); do
  cancel_detail="$(api "$API_URL/work-items/$cancel_id")"
  [ "$(printf '%s' "$cancel_detail" | jget workItem.status)" = "cancelled" ] && { cancelled=1; break; }
  sleep 0.5
done
[ "$cancelled" = "1" ] || fail "work item $cancel_id did not end cancelled"

printf '%s' "$cancel_detail" | bun -e '
  const d = JSON.parse(await Bun.stdin.text());
  const events = d.events ?? [];
  const cancelledEvents = events.filter((e) => e.type === "work_item.cancelled");
  if (cancelledEvents.length !== 1) {
    console.error(`expected exactly one work_item.cancelled, got ${cancelledEvents.length}`);
    process.exit(1);
  }
  if (!events.some((e) => e.type === "cancel.requested")) {
    console.error("no cancel.requested event"); process.exit(1);
  }
  if (d.workItem.cancelActor !== "smoke") { console.error("cancel actor not recorded"); process.exit(1); }
  if (!d.workItem.cancelReason) { console.error("cancel reason not recorded"); process.exit(1); }
' || fail "cancel event assertions failed"

repeat_cancel="$(api -X POST "$API_URL/work-items/$cancel_id/cancel" \
  -H 'content-type: application/json' \
  -d '{"actor":"smoke","reason":"smoke: repeat cancel"}')"
[ "$(printf '%s' "$repeat_cancel" | jget alreadyCancelled)" = "true" ] \
  || fail "repeat cancel was not idempotent: $repeat_cancel"
[ "$(printf '%s' "$repeat_cancel" | jget eventRecorded)" = "false" ] \
  || fail "repeat cancel emitted a second event: $repeat_cancel"
pass "work item $cancel_id cancelled cooperatively (one work_item.cancelled, repeat is a no-op)"

rebuild_out="$(DATABASE_URL="$DATABASE_URL" bun packages/cli/src/index.ts rebuild --from runs --dry-run 2>&1)" \
  || fail "factory rebuild --dry-run failed: $rebuild_out"
printf '%s' "$rebuild_out" | grep -q 'dry run: no rows written' \
  || fail "rebuild dry run did not report that it wrote nothing: $rebuild_out"
printf '%s' "$rebuild_out" | grep -q 'orphaned:' \
  || fail "rebuild dry run did not report the diff: $rebuild_out"
pass "factory rebuild --from runs --dry-run replays the logs and reports the diff without writing"

log "SMOKE PASSED"

