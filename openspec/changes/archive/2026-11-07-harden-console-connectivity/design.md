# Design

## Decisions

1. **Three states, not two.** `/auth/me` can answer with a user, answer without one, or not
   answer at all. `authGateDecision` redirects only for an answered no-user/401/403; a network
   or 5xx failure renders the shell. This breaks the redirect loop without weakening auth.
2. **Health probe is the single liveness signal.** The browser polls the same-origin
   `/api/v1/health` proxy. That path is public and covers both an API restart (502 from the
   proxy) and a web-server restart (fetch failure). The banner is a client component mounted
   by the root layout, so it survives page-level render failures.
3. **Auto-refresh is gated by liveness.** `AutoRefresh` reads the connection context and stops
   its interval while offline, avoiding repeated `router.refresh()` calls against a dead
   backend. It resumes automatically when the banner reports online.
4. **Error boundaries at both levels.** `app/error.tsx` keeps the shell (sidebar/banner) and
   offers retry; `app/global-error.tsx` handles a root-layout failure with inline styling so
   the page is never blank even if the global stylesheet did not load.
5. **Bounded server reads.** `apiGet`/`apiPost` use `AbortSignal.timeout` (default 10s,
   overridable with `API_TIMEOUT_MS`). A timeout becomes a normal degraded read.

## Risks

- A health probe every 15s is cheap; while offline it is every 5s. It is a small local-only
  request and does not touch Temporal or the database beyond the health check.
- A 5xx from an unrelated API route does not necessarily mean the whole backend is down; the
  banner uses `/health`, which is the authoritative readiness signal.
