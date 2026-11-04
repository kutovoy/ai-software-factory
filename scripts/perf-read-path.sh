#!/usr/bin/env bash
# Repeatable read-path benchmark for the console SLOs in docs/PERFORMANCE.md.
#
#   bash scripts/perf-read-path.sh
#   API_BASE_URL=http://localhost:8080 WEB_BASE_URL=http://localhost:3000 \
#   FACTORY_ADMIN_EMAIL=admin@factory.local FACTORY_ADMIN_PASSWORD=factory-admin \
#   bash scripts/perf-read-path.sh
#
# It signs in once, discovers a factory id, and measures warm requests. The thresholds are
# deliberately generous (they catch regressions, not micro-jitter). For a load profile use
# k6 against the same routes; this script is the fast, dependency-free gate.
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:8080}"
WEB_BASE_URL="${WEB_BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${FACTORY_ADMIN_EMAIL:-admin@factory.local}"
ADMIN_PASSWORD="${FACTORY_ADMIN_PASSWORD:-factory-admin}"
ROUNDS="${PERF_ROUNDS:-5}"

COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

fail() {
  echo "[perf] FAIL: $*" >&2
  exit 1
}

login() {
  local status
  status="$(curl -sS -o /dev/null -w '%{http_code}' -c "$COOKIE_JAR" \
    -X POST "$API_BASE_URL/api/v1/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
  [ "$status" = "200" ] || fail "login returned $status (set FACTORY_ADMIN_EMAIL/PASSWORD)"
}

factory_id() {
  curl -sS -b "$COOKIE_JAR" "$API_BASE_URL/api/v1/factories" |
    python3 -c 'import json,sys; d=json.load(sys.stdin); f=d["factories"][0]; print(f["id"] or f["key"])'
}

# median of the per-request times printed by curl
measure() {
  local url="$1"
  local values=()
  for _ in $(seq 1 "$ROUNDS"); do
    values+=("$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{time_total}' "$url")")
  done
  printf '%s\n' "${values[@]}" | sort -n | awk '
    { a[NR]=$1 }
    END {
      if (NR % 2) print a[(NR+1)/2]; else print (a[NR/2]+a[NR/2+1])/2
    }'
}

check() {
  local label="$1" actual="$2" limit="$3"
  local ok
  ok="$(awk -v a="$actual" -v l="$limit" 'BEGIN { print (a <= l) ? "ok" : "slow" }')"
  printf '[perf] %-42s %6.3fs  (limit %.3fs) %s\n' "$label" "$actual" "$limit" "$ok"
  [ "$ok" = "ok" ] || fail "$label exceeded its SLO"
}

login
FACTORY_ID="$(factory_id)"
[ -n "$FACTORY_ID" ] || fail "no factory is visible to this account"
ENCODED_ID="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$FACTORY_ID")"

# Warm the registry once (the first call may include a TTL sync).
curl -sS -b "$COOKIE_JAR" -o /dev/null "$API_BASE_URL/api/v1/factories"

check "GET /api/v1/factories (warm)" "$(measure "$API_BASE_URL/api/v1/factories")" 0.100
check "GET /api/v1/inbox" "$(measure "$API_BASE_URL/api/v1/inbox?limit=50")" 0.500
check "GET board projection" "$(measure "$API_BASE_URL/api/v1/factories/$ENCODED_ID/work-items?view=board&limit=40")" 0.500
check "GET /api/v1/factories/:id" "$(measure "$API_BASE_URL/api/v1/factories/$ENCODED_ID")" 0.100
check "GET /chat" "$(measure "$WEB_BASE_URL/chat")" 0.300
check "GET /inbox" "$(measure "$WEB_BASE_URL/inbox")" 0.500
check "GET work-items board" "$(measure "$WEB_BASE_URL/factories/$ENCODED_ID/work-items")" 0.500

echo "[perf] PASS: read-path SLOs hold over $ROUNDS warm rounds"
