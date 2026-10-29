#!/usr/bin/env bash
# End-to-end smoke test for Phase 2a (task 6.3 / 6.5).
#
#   docker compose up -d
#   bash scripts/smoke.sh
#
# Asserts, against a running stack:
#   1. /health is green (db + temporal)
#   2. migrations apply (idempotent)
#   3. POST /chat starts a fake-harness run (no model, no network)
#   4. GET /runs/:id/events streams >= 3 events including exactly one terminal event
#   5. an interactive permission is approved and execution continues
#   6. the run directory contains events.jsonl (+ patch.diff) on the host
#   7. Last-Event-ID replay returns only seq > header value
#   8. the inference proxy works with a per-run token against the stub upstream,
#      rejects a disallowed model, and the run detail never leaks the provider key
#
# Re-runnable: every invocation creates a fresh run; migrations and the proxy stub are
# idempotent. Exits non-zero on any failure.

set -euo pipefail
cd "$(dirname "$0")/.."

API_URL="${API_URL:-http://localhost:8080}"
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

log "SMOKE PASSED"
