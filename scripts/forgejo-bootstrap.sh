#!/usr/bin/env bash
# Provisions the local forge (spec `forge` › Bootstrap, ADR-032).
#
#   docker compose up -d
#   bash scripts/forgejo-bootstrap.sh
#
# Idempotent: waits for health, ensures the admin, reuses or creates an API token, creates
# the organization and the repository (with an initial commit), registers the token as a
# secret *name*, records the factory's forge integration and points the api/worker at the
# forge. The token value is written to `.env` only — it is never printed, never stored in a
# definition and never sent to a log.
#
# Re-runnable: a second invocation changes nothing and exits 0.
#
# Environment:
#   FORGEJO_ENABLED=0        skip (the forge is off; nothing to bootstrap)
#   FORGEJO_ADMIN_USER       default `factory`
#   FORGEJO_ADMIN_PASSWORD   default: generated once and stored in `.env`
#   FORGEJO_ORG              default `acme`
#   FORGEJO_REPO             default `hello-nextjs`
#   FORGEJO_FACTORY          factory whose integration is wired, default `hello-nextjs`
#   FORGEJO_PUBLIC_URL       default `http://localhost:3000/extras/forgejo` (through the console)

set -euo pipefail
cd "$(dirname "$0")/.."

WEB_URL="${WEB_URL:-http://localhost:3000}"
API_URL="${API_URL:-http://localhost:8080}"
API="${API_URL}/api/v1"
FORGE_PUBLIC="${FORGEJO_PUBLIC_URL:-${WEB_URL}/extras/forgejo}"
FORGE_API="${FORGE_PUBLIC}/api/v1"
ADMIN_USER="${FORGEJO_ADMIN_USER:-factory}"
ADMIN_EMAIL="${FORGEJO_ADMIN_EMAIL:-factory@localhost}"
ORG="${FORGEJO_ORG:-acme}"
REPO="${FORGEJO_REPO:-hello-nextjs}"
FACTORY="${FORGEJO_FACTORY:-hello-nextjs}"
ENV_FILE=".env"

log() { printf '[forgejo] %s\n' "$*"; }
fail() { printf '[forgejo] FAIL: %s\n' "$*" >&2; exit 1; }

if [ "${FORGEJO_ENABLED:-1}" = "0" ]; then
  log "FORGEJO_ENABLED=0 — the local forge is off, nothing to bootstrap"
  exit 0
fi

# ---------------------------------------------------------------- .env helpers
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | head -1
}

# Sets KEY=VALUE in `.env` without echoing the value (secrets stay out of the terminal).
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if [ -f "$ENV_FILE" ]; then
    grep -v "^${key}=" "$ENV_FILE" >"$tmp" || true
  fi
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  mv "$tmp" "$ENV_FILE"
}

# ---------------------------------------------------------------- 1. health
log "waiting for the forge at ${FORGE_PUBLIC}/"
healthy=""
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "${FORGE_PUBLIC}/api/healthz" || true)"
  if [ "$code" = "200" ]; then healthy="yes"; break; fi
  sleep 2
done
[ -n "$healthy" ] || fail "forge is not healthy through the console proxy (start it with: docker compose up -d forgejo web)"
pass_health="$(curl -s "${FORGE_PUBLIC}/api/healthz" || true)"
log "forge healthy: ${pass_health}"

forgejo() { docker compose exec -T -u git forgejo forgejo "$@"; }

# ---------------------------------------------------------------- 2. admin
if forgejo admin user list 2>/dev/null | awk 'NR>1 {print $2}' | grep -qx "$ADMIN_USER"; then
  log "admin '${ADMIN_USER}' already exists"
else
  password="$(env_get FORGEJO_ADMIN_PASSWORD)"
  if [ -z "$password" ]; then
    password="$(openssl rand -hex 24)"
    env_set FORGEJO_ADMIN_PASSWORD "$password"
    log "generated the admin password (stored in ${ENV_FILE})"
  fi
  forgejo admin user create \
    --username "$ADMIN_USER" \
    --password "$password" \
    --email "$ADMIN_EMAIL" \
    --admin \
    --must-change-password=false >/dev/null
  log "admin '${ADMIN_USER}' created"
fi

# ---------------------------------------------------------------- 3. token
token="$(env_get GITHUB_TOKEN)"
token_ok=""
if [ -n "$token" ]; then
  status="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token ${token}" "${FORGE_API}/user" || true)"
  if [ "$status" = "200" ]; then token_ok="yes"; fi
fi

if [ -n "$token_ok" ]; then
  log "existing API token still resolves; reusing it"
else
  # `--raw` prints the token alone. Captured, never echoed (spec: token handling).
  token="$(forgejo admin user generate-access-token \
    --username "$ADMIN_USER" \
    --token-name factory-bootstrap \
    --scopes all \
    --raw 2>/dev/null | tr -d '\r\n')"
  [ -n "$token" ] || fail "could not generate an API token for '${ADMIN_USER}'"
  env_set GITHUB_TOKEN "$token"
  log "created a new API token (written to ${ENV_FILE}, value not printed)"
fi

# The api/worker reach the forge on the compose network; the browser uses the console URL.
env_set GITHUB_API_BASE_URL "http://forgejo:3000/api/v1"
env_set FORGEJO_ADMIN_USER "$ADMIN_USER"
[ -n "$(env_get FORGEJO_PUBLIC_URL)" ] || env_set FORGEJO_PUBLIC_URL "$FORGE_PUBLIC"

auth=(-H "Authorization: token ${token}" -H 'content-type: application/json')

# ---------------------------------------------------------------- 4. organization
org_status="$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "${FORGE_API}/orgs/${ORG}")"
if [ "$org_status" = "200" ]; then
  log "organization '${ORG}' already exists"
else
  created="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${auth[@]}" \
    -d "{\"username\":\"${ORG}\",\"visibility\":\"public\"}" "${FORGE_API}/orgs")"
  [ "$created" = "201" ] || fail "could not create organization '${ORG}' (HTTP ${created})"
  log "organization '${ORG}' created"
fi

# ---------------------------------------------------------------- 5. repository
repo_json="$(curl -s "${auth[@]}" "${FORGE_API}/repos/${ORG}/${REPO}" || true)"
repo_status="$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "${FORGE_API}/repos/${ORG}/${REPO}")"
if [ "$repo_status" = "200" ]; then
  log "repository '${ORG}/${REPO}' already exists"
else
  created="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${auth[@]}" \
    -d "{\"name\":\"${REPO}\",\"private\":false,\"auto_init\":true,\"default_branch\":\"main\"}" \
    "${FORGE_API}/orgs/${ORG}/repos")"
  [ "$created" = "201" ] || fail "could not create repository '${ORG}/${REPO}' (HTTP ${created})"
  log "repository '${ORG}/${REPO}' created with an initial commit"
fi

# An existing but empty repository cannot be cloned; seed it so a PR can be opened.
if printf '%s' "$repo_json" | grep -q '"empty":true'; then
  readme_b64="$(printf '# %s\n\nManaged by the factory loop.\n' "$REPO" | base64 | tr -d '\n')"
  seeded="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${auth[@]}" \
    -d "{\"content\":\"${readme_b64}\",\"message\":\"Initial commit\",\"branch\":\"main\",\"new_branch\":\"main\"}" \
    "${FORGE_API}/repos/${ORG}/${REPO}/contents/README.md")"
  case "$seeded" in
    201|200) log "seeded '${ORG}/${REPO}' with an initial commit" ;;
    *) fail "could not seed '${ORG}/${REPO}' (HTTP ${seeded})" ;;
  esac
fi

# ---------------------------------------------------------------- 6. secret + integration
# Console auth is on in compose, so the API calls below need a session. Sign in once as the
# bootstrap admin; the forge calls above stay token-authenticated and untouched.
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT
API_ADMIN_EMAIL="${FACTORY_ADMIN_EMAIL:-admin@factory.local}"
API_ADMIN_PASSWORD="${FACTORY_ADMIN_PASSWORD:-factory-admin}"
login_body="$(API_ADMIN_EMAIL="$API_ADMIN_EMAIL" API_ADMIN_PASSWORD="$API_ADMIN_PASSWORD" bun -e '
  process.stdout.write(JSON.stringify({ email: process.env.API_ADMIN_EMAIL, password: process.env.API_ADMIN_PASSWORD }));
')"
login_code="$(curl -sS -o /dev/null -w '%{http_code}' -c "$COOKIE_JAR" \
  -X POST -H 'content-type: application/json' -d "$login_body" "${API}/auth/login")"
[ "$login_code" = "200" ] \
  || fail "API login failed (HTTP ${login_code}); set FACTORY_ADMIN_EMAIL / FACTORY_ADMIN_PASSWORD"

# Metadata only: the registry stores the *name*; the value stays in the environment (ADR-026).
curl -s -o /dev/null -b "$COOKIE_JAR" -X POST -H 'content-type: application/json' \
  -d '{"name":"GITHUB_TOKEN","provider":"env","scope":"factory","description":"Local forge (Forgejo) API token"}' \
  "${API}/secrets" || true

integration="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" -X POST -H 'content-type: application/json' \
  -d "{\"factory\":\"${FACTORY}\",\"secretRef\":\"GITHUB_TOKEN\",\"repos\":[{\"owner\":\"${ORG}\",\"name\":\"${REPO}\"}],\"events\":[\"issues\"],\"labels\":[\"factory-ready\"],\"dryRun\":false,\"mergeQueue\":false,\"enabled\":true}" \
  "${API}/integrations/github")"
case "$integration" in
  200|201) log "integration for '${FACTORY}' points at ${ORG}/${REPO} (secret GITHUB_TOKEN)" ;;
  *) fail "could not record the integration for '${FACTORY}' (HTTP ${integration})" ;;
esac

# ---------------------------------------------------------------- 7. restart api + worker
log "applying the forge settings to api + worker"
docker compose up -d api worker >/dev/null
for _ in $(seq 1 60); do
  health="$(curl -s "${API_URL}/health" || true)"
  if printf '%s' "$health" | grep -q '"status":"ok"'; then break; fi
  sleep 2
done

log "done — forge: ${FORGE_PUBLIC}/  repo: ${FORGE_PUBLIC}/${ORG}/${REPO}"
log "clone: git clone ${FORGE_PUBLIC}/${ORG}/${REPO}.git"
