# Tasks

## 1. Artifact store foundation

- [x] 1.1 Add artifact-store config (`ARTIFACT_STORE`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`,
  `S3_INTERNAL_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`,
  `S3_FORCE_PATH_STYLE`, expiry/size limits).
- [x] 1.2 Implement S3 SigV4 presigning (PUT/GET) with path-style MinIO support and tests.
- [x] 1.3 Implement `ArtifactStore` metadata/verification helpers.
- [x] 1.4 Add MinIO + bucket-init services to `compose.yaml`; document env and public endpoint.
- [x] 1.5 Add artifact metadata fields (`storageKey`, `bucket`, `contentType`) without breaking
  existing run JSON.

## 2. Agent artifact upload

- [x] 2.1 Add presign request/response wire types and an agent upload client.
- [x] 2.2 Upload collected artifacts after `collectArtifacts`; keep `patch.diff` inline.
- [x] 2.3 Return upload errors without losing metadata/patch; record errors centrally.
- [x] 2.4 Unit tests for upload success, expired grant, checksum/size failure and fallback.

## 3. Central artifact path

- [x] 3.1 Generate presigned PUT grants for a host/run/lease after bearer auth.
- [x] 3.2 Persist artifact object keys in run artifacts; verify size/checksum where possible.
- [x] 3.3 Add an authenticated artifact download route (presigned GET for object storage,
  local file fallback with traversal protection).
- [x] 3.4 Add console download links and show storage-backed artifacts honestly.
- [x] 3.5 Update OpenAPI and API tests.

## 4. Windows agent

- [x] 4.1 Platform-aware backend defaults (`docker` on Linux, `local` on Windows/macOS).
- [x] 4.2 PowerShell shell/quoting and Windows process-tree termination in the local backend.
- [x] 4.3 Windows metrics (CPU, memory, logical disks, uptime, process count).
- [x] 4.4 PowerShell preflight + install command generation.
- [x] 4.5 Enable Windows in the Runners wizard and update copy/help.
- [x] 4.6 Unit tests for command rendering and metric parsing.

## 5. macOS agent

- [x] 5.1 macOS native backend defaults and `sandbox-exec` availability handling.
- [x] 5.2 macOS swap/process metrics and preflight checks (Xcode CLT, Bun, git, curl, disk).
- [x] 5.3 macOS preflight + install command generation (nohup; launchd documented).
- [x] 5.4 Enable macOS in the Runners wizard and update copy/help.
- [x] 5.5 Unit tests for command rendering and metric parsing.

## 6. Playwright E2E

- [x] 6.1 Add `apps/web/e2e/runners.spec.ts` covering enrollment, commands, host list/detail,
  heartbeat metrics, alert firing/ack and deletion.
- [x] 6.2 Track and clean up hosts/enrollments in `afterEach`.
- [x] 6.3 Run the Runners spec against the compose stack (or document why it cannot run).
  Rebuilt API/worker/web and ran `bunx playwright test e2e/runners.spec.ts`: 3 passed.

## 7. Verification and docs

- [x] 7.1 Update OpenAPI, help, menu reference, runner README, STATUS, HANDOVER, ROADMAP,
  DECISIONS and `.env.example`.
- [x] 7.2 Run `bun run typecheck`, `bun test`, `openspec validate --all`, `bun run ci`.
- [x] 7.3 Rebuild compose services and retest the `hello-nextjs` lights-off cycle.
  `hello-nextjs` work item `wi_01M6ND4MXH6Z68W513XPDF8F87` reached `done/ship`, PR #11 merged,
  all stage runs `ok`, no worker errors and zero managed runner containers.
- [x] 7.4 Confirm no provider keys or object-store credentials land on remote hosts.
  Install commands carry only the API URL, enrollment token and runner settings; agents receive
  short-lived presigned URLs, never `OPENAI_*` provider keys or MinIO access/secret keys.
