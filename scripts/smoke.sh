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
detail="$(api "$API_URL/runs/$run_id")"
[ "$(printf '%s' "$detail" | jget run.status)" = "ok" ] || fail "run did not end ok: $(printf '%s' "$detail" | jget run.status)"
pass "run reached status ok"

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

log "SMOKE PASSED"
