#!/usr/bin/env bash
# Permission non-blocking smoke test (ADR-013).
#
#   docker compose up -d --build
#   bash scripts/smoke.sh              # invokes this script at the end
#   bash scripts/smoke-permissions.sh  # or run it standalone
#
# The defect this guards: the worker used to hold an activity slot for every run waiting on
# a human permission decision, so eight abandoned permission-blocked runs starved the queue
# and no new run started. Now the wait lives in workflow state (Temporal Update/Signal), so:
#
#   1. eight runs park on a pending permission and stay `running` (zero activity cost)
#   2. a ninth run starts, gets its permission approved and reaches `ok` — while the eight
#      are still waiting (no starvation)
#   3. cancelling a blocked run ends it `cancelled` (durable wait is cancellable)
#   4. denying the rest resolves the waits and the runs continue to `ok`
#   5. the canonical `permission.requested` event is persisted exactly once per run
#
# Re-runnable: every invocation creates fresh runs.

set -euo pipefail
cd "$(dirname "$0")/.."

API_URL="${API_URL:-http://localhost:8080}"
# Every public resource route is versioned (ADR-030); /health stays unversioned.
API="${API_URL}/api/v1"
TMP_DIR="$(mktemp -d)"
BLOCKED=()

log() { printf '[smoke-permissions] %s\n' "$*"; }
fail() { printf '[smoke-permissions] FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf '[smoke-permissions] ok: %s\n' "$*"; }
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

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

create_run() {
  local label="$1"
  local created run_id
  created="$(api -X POST "$API/chat" \
    -H 'content-type: application/json' \
    -d "{\"factory\":\"example\",\"harness\":\"fake\",\"prompt\":\"smoke-permissions: $label\"}")"
  run_id="$(printf '%s' "$created" | jget run.id)"
  [ -n "$run_id" ] || fail "could not create run '$label': $created"
  printf '%s' "$run_id"
}

run_detail() { api "$API/runs/$1"; }

# Waits until the run has a pending permission and prints the request id.
wait_pending_permission() {
  local run_id="$1"
  local request_id=""
  for _ in $(seq 1 120); do
    request_id="$(run_detail "$run_id" | jget pendingPermissions.0.request_id)"
    if [ -n "$request_id" ]; then printf '%s' "$request_id"; return 0; fi
    sleep 0.25
  done
  fail "run $run_id never surfaced a pending permission"
}

wait_status() {
  local run_id="$1" expected="$2" status=""
  for _ in $(seq 1 240); do
    status="$(run_detail "$run_id" | jget run.status)"
    if [ "$status" = "$expected" ]; then return 0; fi
    sleep 0.25
  done
  fail "run $run_id did not reach '$expected' (last: ${status:-none})"
}

decide() {
  local run_id="$1" request_id="$2" decision="$3" response
  response="$(api -X POST "$API/runs/$run_id/permissions/$request_id" \
    -H 'content-type: application/json' -d "{\"decision\":\"$decision\"}")"
  [ "$(printf '%s' "$response" | jget decision)" = "$decision" ] \
    || fail "decision '$decision' for $run_id/$request_id failed: $response"
}

# ------------------------------------------------ 1. eight permission-blocked runs
log "parking eight runs on a pending permission"
for index in $(seq 1 8); do
  run_id="$(create_run "blocked-$index")"
  BLOCKED+=("$run_id")
done
for run_id in "${BLOCKED[@]}"; do
  request_id="$(wait_pending_permission "$run_id")"
  [ "$(run_detail "$run_id" | jget run.status)" = "running" ] \
    || fail "blocked run $run_id is not running"
  [ -n "$request_id" ] || fail "blocked run $run_id has no permission request"
done
pass "eight runs are waiting on a human decision (status running)"

# ------------------------------------------------------ 2. a ninth run still completes
log "starting a ninth run while eight are blocked"
ninth="$(create_run "ninth")"
ninth_request="$(wait_pending_permission "$ninth")"
decide "$ninth" "$ninth_request" "allow"
wait_status "$ninth" "ok"
pass "ninth run $ninth reached ok while eight runs were still blocked"

# The blocked runs must not have been disturbed (no starvation, no auto-deny).
for run_id in "${BLOCKED[@]}"; do
  detail="$(run_detail "$run_id")"
  [ "$(printf '%s' "$detail" | jget run.status)" = "running" ] \
    || fail "blocked run $run_id changed state while the ninth run executed"
  [ -n "$(printf '%s' "$detail" | jget pendingPermissions.0.request_id)" ] \
    || fail "blocked run $run_id lost its pending permission"
done
pass "all eight blocked runs are still waiting and unaffected"

# The canonical permission event must exist exactly once for the ninth run.
events="$(api "$API/runs/$ninth/events")"
permission_events="$(printf '%s' "$events" | grep -c '^event: permission.requested' || true)"
terminal_events="$(printf '%s' "$events" | grep -c '^event: run.completed' || true)"
[ "$permission_events" -eq 1 ] || fail "expected one permission.requested event, got $permission_events"
[ "$terminal_events" -eq 1 ] || fail "expected one terminal event, got $terminal_events"
pass "ninth run has exactly one permission.requested and one terminal event"

# ------------------------------------------- 3. cancellation while waiting on a permission
log "cancelling one permission-blocked run"
cancelled="${BLOCKED[0]}"
cancel_resp="$(api -X POST "$API/runs/$cancelled/cancel" \
  -H 'content-type: application/json' -d '{"reason":"smoke-permissions"}')"
[ "$(printf '%s' "$cancel_resp" | jget cancelled)" = "true" ] \
  || fail "cancel was not accepted: $cancel_resp"
wait_status "$cancelled" "cancelled"
cancelled_events="$(api "$API/runs/$cancelled/events")"
[ "$(printf '%s' "$cancelled_events" | grep -c '^event: run.completed')" -eq 1 ] \
  || fail "cancelled run did not emit exactly one terminal event"
pass "cancellation while waiting ended $cancelled as cancelled"

# ----------------------------------------------------- 4. deny resolves the remaining waits
log "denying the remaining blocked runs"
for run_id in "${BLOCKED[@]:1}"; do
  request_id="$(run_detail "$run_id" | jget pendingPermissions.0.request_id)"
  [ -n "$request_id" ] || fail "run $run_id lost its pending permission"
  decide "$run_id" "$request_id" "deny"
done
for run_id in "${BLOCKED[@]:1}"; do
  wait_status "$run_id" "ok"
done
pass "deny decisions resolved the remaining waits and every run continued to ok"

log "SMOKE-PERMISSIONS PASSED"
