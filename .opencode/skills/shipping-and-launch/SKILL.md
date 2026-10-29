---
name: shipping-and-launch
description: Prepares a release with a pre-launch checklist, staged rollout thresholds, monitoring and a rollback plan. Use when preparing to deploy, when asking what must be in place before shipping, or when a factory verify/deploy gate needs a go/no-go verdict with evidence.
license: MIT
compatibility: opencode
metadata:
  source: https://github.com/addyosmani/agent-skills
  upstream: skills/shipping-and-launch
  vendored: "2026-10-28"
  modifications: trimmed; JS/React examples removed; repo verification commands and factory merge-policy wording added
---

# Shipping and Launch

## Overview

The goal is not just to deploy — it is to deploy safely, with monitoring in place, a rollback plan
ready, and a clear definition of success. Every launch should be reversible, observable, incremental.

## When to Use

- Deploying a feature or a significant change; opening a beta
- Data or infrastructure migrations
- Any `verify` or `deploy` gate in a factory run
- When asked "what has to be true before we ship this?"

## Pre-Launch Checklist

**Code quality** — full suite passes; `bun run typecheck` (or documented equivalent) clean; lint clean;
reviewed and approved; no unresolved TODOs; no debug output; error paths handled.

**Security** — no secrets in code or history; native audit shows no reachable critical/high; input
validated at boundaries; authn/authz on every protected endpoint; headers and CORS configured; rate
limits on auth endpoints. (See `security-and-hardening`.)

**Performance** — no N+1 in critical paths; indexes for hot queries; bundle within budget; caching for
static assets and repeated queries; pagination on list endpoints.

**Accessibility** (user-facing surfaces) — keyboard reachable, screen-reader sane, contrast ≥ 4.5:1,
focus managed, errors associated with fields.

**Infrastructure** — env vars set in production; migrations applied or ready; DNS/SSL; logging and error
reporting configured; health check exists and responds.

**Documentation** — setup docs current; API docs current; ADR for architectural decisions; changelog;
status doc updated.

## Feature Flags

Decouple deploy from release: ship dark, enable for team, then ramp.

```
1. DEPLOY with flag OFF
2. ENABLE for team/beta
3. RAMP 5% → 25% → 50% → 100%, monitoring at each step
4. MONITOR error rate, latency, behaviour
5. CLEAN UP flag and dead path within two weeks of full rollout
```

Every flag has an owner and an expiration date. Don't nest flags. Test both states in CI.

## Rollout Decision Thresholds

| Metric | Advance | Hold and investigate | Roll back |
|---|---|---|---|
| Error rate | within 10% of baseline | 10–100% above | >2x baseline |
| P95 latency | within 20% | 20–50% above | >50% above |
| New client errors | none | <0.1% of sessions | >0.1% of sessions |
| Business metric | neutral/positive | decline <5% | decline >5% |

Roll back immediately on: error rate >2x, P95 >+50%, data-integrity issues, or a discovered vulnerability.

## Error Budget Gate

```
>20% remaining  → ship normally, monitor closely
0–20%           → slow rollouts only, no high-risk changes
exhausted       → freeze feature work, fix reliability
```

A burn rate above baseline during a canary is a hold signal even when the point-in-time thresholds are
green.

## Rollback Plan (write it before deploying)

```markdown
Triggers:      error rate > 2x, P95 > X ms, specific user reports
Steps:         disable flag, or revert + redeploy; verify; notify
Database:      migration rollback verified; data written by the feature preserved or cleaned
Time:          flag < 1 min, redeploy < 5 min, DB rollback < 15 min
```

## Post-Deploy Verification (first hour)

1. Health check returns 200
2. Error dashboard shows no new error types
3. Latency has not regressed
4. Critical flow exercised manually or by smoke test
5. Logs flowing and readable
6. Rollback verified or dry-run

## Factory Mapping

- `mergePolicy: auto_on_green` still requires the checklist above to be green — automation lowers the
  human gate, not the evidence bar.
- A `policy:<name>` gate must cite which checklist sections it enforced and what it observed.
- Never let a run declare "shipped" on "tests pass" alone; record the evidence in the run event log.

## Common Rationalisations

| Excuse | Reality |
|---|---|
| "It works in staging" | Production has different data, traffic and edge cases. Monitor after deploy. |
| "We don't need a flag" | Every change benefits from a kill switch. |
| "Monitoring is overhead" | Without it you learn about problems from users. |
| "Rolling back is failure" | Shipping broken code is the failure. |
| "It's Friday, let's ship" | Risk without a monitoring window is not courage. |

## Red Flags

- Deploy with no rollback plan; no monitoring or error reporting
- Big-bang release, no staging pass
- Flags with no owner or expiry
- Production config set from memory, not code
- "Shipped" declared on tests alone

## Verification

- [ ] Pre-launch checklist green, with the commands and outputs recorded
- [ ] Flag configured and its cleanup owner named (if applicable)
- [ ] Rollback plan documented and exercised or dry-run
- [ ] Monitoring dashboards and alerts live before the deploy
- [ ] Post-deploy checks pass in the first hour
