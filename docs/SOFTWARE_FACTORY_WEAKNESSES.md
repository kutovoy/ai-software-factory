# Software Factory Weaknesses and Quality Workstream

**Status:** research + implementation record (2026-11-07). P0 is **implemented and archived** as OpenSpec
`2026-11-07-harden-factory-quality` (ADR-052); the anti-slop P0 (slop budgets, proof, context packs, packet v2)
is implemented as `2026-11-25-add-anti-slop-budgets-and-proof` (ADR-053). The P1/P2 backlog below remains. The live checks
are recorded in `docs/STATUS.md`.

**Purpose:** capture why “lights-off” software factories fail, separate the strong claims from the
overstated ones, and turn the useful parts into a concrete P0 plan for this repository.

**Primary source:** Dex Horthy (HumanLayer), *Why Software Factories Fail* — AI Engineer World’s Fair 2026,
19:18. <https://www.youtube.com/watch?v=Ib5GBkD555M>  
The transcript bundle (auto-ASR, corrected against the AI Engineer edited transcript) is in
`research/videos/Ib5GBkD555M/`.

---

## 1. Executive summary

The talk’s useful core is not “AI coding does not work.” It is:

> **Generation is now abundant; verification and human comprehension are the scarce resources.**

A factory can generate code faster than it can review, test, understand and safely change it. When the
review gate is removed, throughput looks better for a few months and then the bill arrives as incidents,
unmaintainable code and “comprehension debt” — code that works but nobody understands.

The talk’s strongest claims:

1. **Verification is the bottleneck.** Autonomy cannot exceed the capacity to verify cheaply and reliably.
2. **Models are trained to pass tests, not to preserve maintainability.** Binary test rewards do not
   penalise poor architecture, coupling, or future change cost.
3. **Architecture debt is delayed.** A bad design decision can pass every test and only hurt months later,
   so the reward signal cannot reach the original coding episode.
4. **Lights-off fails on complex/brownfield work.** The failure is quiet: code keeps shipping, tests stay
   green, and understanding decays until an incident forces a human back into code they stopped reading.
5. **Move judgment upstream.** Product review → system architecture → program design → vertical slices →
   implementation → human review is cheaper than discovering intent mismatches in a 2,000-line diff.
6. **Small, cheap-to-verify loops can stay dark.** The talk is not anti-automation; it is against
   *unverified* automation.

The talk’s weaker parts:

- “No amount of harness engineering” is too absolute. A harness cannot supply missing model judgment, but
  it can enforce architecture, types, tests, review rubrics and blast-radius limits. It raises the floor.
- “Lights-off fails” is context-dependent. Horthy’s evidence is largely one four-month brownfield
  experience plus industry telemetry. Narrow, reversible, cheaply verified dark loops are still viable.
- “3–6 months” is a heuristic, not a measured law. Model capability and benchmarks are moving.
- The evidence is directional, not causal. Faros is vendor telemetry; GitClear is correlational; METR’s
  original RCT used early-2025 models. The AI Engineer talk page itself calls Faros’s findings “reported
  warning signs, not proof that coding agents caused every deterioration.”
- The last few minutes are a HumanLayer product pitch; treat that as commercial framing, not evidence.

The practical conclusion:

> **Dark factories fail when they remove human judgment from high-cost, hard-to-verify, long-lived
> decisions. Lit factories work when judgment moves upstream and verification stays honest.**

---

## 2. Evidence base

| Source | What it reports | How to read it |
|---|---|---|
| [Faros AI — AI code review burden](https://www.faros.ai/blog/ai-code-quality-senior-engineer-review-burden) | Under high AI adoption: PRs ~51% larger, bugs per PR +54%, median PR review time +441%, ~31% more PRs merged with no review. | Vendor telemetry from high-adoption cohorts; directionally strong, not a controlled causal study. |
| [Faros AI — Acceleration Whiplash](https://www.faros.ai/blog/ai-acceleration-whiplash-takeaways) | Throughput up, but incidents per PR tripled and monthly incidents +57.9%; review and rework burden rising. | Same caveat: cohort composition and adoption maturity may confound. |
| [GitClear — 2026 maintainability gap](https://www.gitclear.com/the_ai_code_quality_maintainability_gap) | Block duplication rose from 40.3 to 73.0 per million changed lines (2023 → 2026), ~81% increase; churn elevated. | Correlational code-history analysis; useful as a maintainability warning, not proof of causation. |
| [METR — 2025 RCT](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) | Experienced developers were 19% slower with early-2025 AI tools while believing they were faster. | 16 developers, early-2025 models; METR has newer 2026 data. Treat as a snapshot and a perception-gap warning. |
| [CodeRabbit report, summarised by Faros](https://www.faros.ai/blog/ai-code-quality-senior-engineer-review-burden) | AI-written code produced ~1.7× more issues than human code in 470 open-source PRs; logic/correctness errors up 75%. | Useful signal; sample and vendor context matter. |
| [JetBrains ICSE 2026 study, summarised by Faros](https://blog.jetbrains.com/research/2026/04/ai-impact-developer-workflows/) | AI users showed ~14× more delete/undo actions than non-AI users, while self-reports said behaviour did not change. | IDE telemetry; rework signal, not a direct quality verdict. |
| [Addy Osmani — Software Factories, Light and Dark](https://addyo.substack.com/p/software-factories-light-and-dark) | Review gate is where judgment lives; removing it creates comprehension debt; autonomy must be earned by cheap, hard-to-fake verification. | Strong synthesis; not peer-reviewed, but consistent with the evidence above. |
| [AI Engineer talk page](https://ai.engineer/talks/Ib5GBkD555M-why-software-factories-fail) | Edited transcript and chaptering; explicitly notes Faros is warning signs, not proof. | Best source for precise claims and caveats. |
| [HN discussion](https://news.ycombinator.com/item?id=49023019) | Practitioner debate: intent, architecture, maintainability and platform engineering. | Anecdotal; useful for counterpoints and failure stories. |

Additional grounding for the P0 design:

- [DORA metrics](https://dora.dev/guides/dora-metrics/) now include **deployment rework rate** alongside
  change failure rate; both are relevant to “did the factory make the codebase better or worse?”
- [Architecture fitness functions](https://www.infoq.com/articles/fitness-functions-architecture/) turn
  architectural qualities (layering, dependency direction, coupling) into automated checks.
- [Risk-based code review](https://www.cortex.io/post/risk-based-code-review) and
  [Pragmatic Engineer’s review analysis](https://newsletter.pragmaticengineer.com/p/what-is-happening-with-code-reviews)
  support routing human attention by blast radius rather than reviewing every diff equally.
- [Comprehension debt](https://www.faros.ai/blog/comprehension-debt-in-software-engineering) and
  [Addy’s comprehension-debt essay](https://medium.com/@addyosmani/comprehension-debt-the-hidden-cost-of-ai-generated-code-285a25dac57e)
  describe the gap between shipped code and human understanding.
- [Vertical-slice architecture for AI-generated code](https://managed-code.com/blog-post/vertical-slice-architecture-for-ai-generated-code)
  supports organising work around end-to-end features rather than horizontal technical layers.
- Emerging long-horizon/quality benchmarks: [SWE-Marathon](https://arxiv.org/abs/2606.07682),
  [DeepSWE](https://deepswe.datacurve.ai/), [FrontierCode](https://cognition.com/blog/frontier-code).

---

## 3. Failure modes in detail

### 3.1 Verification bottleneck / back pressure

Generation is cheap; review, testing, understanding and incident recovery are not. Speeding up
implementation without widening verification just builds a larger queue of unverified changes. The correct
rule is **autonomy ≤ verification capacity**, not “more tokens”.

### 3.2 Test-pass reward and Goodhart’s law

Coding-agent RL often rewards “the test passes” and “no regression”. That does not reward clear interfaces,
low coupling, replaceable modules or future change cost. The model learns to satisfy the oracle, including
shortcuts: unnecessary try/catch, casts, weakened tests, duplicated code, hidden coupling. Passing tests is
necessary but not sufficient.

### 3.3 Maintainability and architecture debt

Maintainability is the ability to change one part of the system without unexpectedly breaking others
(Fowler’s “shotgun surgery” smell). Architecture costs are delayed by months or years, so a short training
episode cannot assign credit to the original design decision. This is why “tests green” can coexist with a
codebase that is getting harder to change.

### 3.4 Comprehension debt

If nobody reads the code, nobody understands it. The team can still ship, but incident diagnosis, design
changes and safe refactoring become archaeology. Comprehension debt compounds faster than technical debt
because the humans who could fix the system no longer hold its model in their heads.

### 3.5 Review overload and the senior-engineer tax

AI-generated code often looks clean while hiding intent mismatches and edge-case errors. Senior engineers
spend more time reconstructing what the code was supposed to do. Review queues grow, review comments get
longer, and more PRs merge without review. The cost lands on the people whose judgment is most valuable.

### 3.6 Horizontal plans and PR volume

A plan split into “add package.json”, “add layout”, “add test”, “add README” is horizontal: each feature is
a technical layer, not a verifiable behavior. It creates many small PRs, each needing review, without any
single feature proving an end-to-end outcome. The talk’s alternative is **vertical slices**: each feature
delivers a runnable, testable behavior and the plan says how to check it.

### 3.7 Lights-off overreach / binary thinking

The dark/light framing is useful but easy to misuse. “Full autonomy” is not a property of a whole company;
it is a property of a specific loop with a specific verification oracle and blast radius. Low-risk,
reversible loops (lint fixes, dependency bumps with green CI, one small anti-pattern fix) can be dark.
Auth, billing, data migrations, public APIs and security-sensitive code should stay lit.

### 3.8 Model/harness co-training gap

A harness builder that cannot update model weights cannot RL the model in its own harness. Model labs that
train against their distributed harness have an advantage in tool-use fluency. A harness-agnostic factory
can still choose models trained for their harness, but it should not assume its own harness can compensate
for a model trained on a different one.

### 3.9 Benchmark gap

Most agent benchmarks measure issue resolution or test pass, not “would a maintainer merge this and still
be able to change it in six months?” Emerging benchmarks (SWE-Marathon, DeepSWE, FrontierCode) improve the
signal, but the gap is real. A factory that gates autonomy on a task-success benchmark alone is measuring
the wrong thing for long-lived code.

### 3.10 Loop maxing / token maxing

More loops can move the bottleneck rather than remove it: more PRs, more review, more fix features, more
tokens, more code churn. Budget caps and validation rounds help, but without quality stop conditions the
loop can optimise for “green” while eroding the codebase.

### 3.11 Context deprivation

Agents generate against a narrow slice of what a senior engineer knows: repo history, ADRs, architectural
patterns, test standards, prior failures, product intent. Faros’s controlled test suggests repo-specific
context can matter more than raw model strength: a previous-generation model with context outperformed a
stronger model without it. Context is not a substitute for judgment, but it improves first-pass quality.

### 3.12 Production feedback not wired into the factory

If incidents, user complaints and rework metrics do not feed the queue and the scorers, the factory cannot
learn which changes were actually good. The loop must include production signals, not just CI.

---

## 4. What holds up, and what to challenge

### Holds up

- Verification/back-pressure model.
- Test-pass reward does not measure maintainability.
- Delayed architecture cost and credit assignment.
- Review overload and comprehension debt.
- Upstream product/architecture/program design reduces review cost.
- Vertical slices over horizontal layers.
- Risk-tiered autonomy: small, cheap-to-verify loops can be dark; high-blast-radius work stays lit.

### Challenge

- “No amount of harness engineering” → “harness raises the floor and bounds blast radius; it does not
  replace human judgment for long-horizon design.”
- “Lights-off fails” → “lights-off fails when verification is weak and the work is complex/long-lived.”
- “3–6 months” → a useful heuristic, not a universal threshold.
- “30 minutes of planning saves hours” → plausible mechanism, not a controlled measurement.
- “Models cannot maintain code” → currently under-measured; model progress and better benchmarks may change
  the answer. The safe current position is: **do not grant autonomy you cannot verify.**

---

## 5. Implications for this repository

### What we already have that aligns

- Durable missions with a plan gate, validation contract, milestones and checkpoints.
- Benchmark gate + audited override before full autonomy.
- Review committee + judge, merge queue, event log and fix features.
- Mission budget caps, validation-round caps, progress watchdog and no-progress cancellation.
- Build/e2e evidence in mission validation.
- Mission Control plan/validation/evidence views.

### Gaps exposed by the talk

1. **Factory-wide autonomy is too coarse.** `autonomyLevel: full` is a single switch; it should be
   risk-tiered per loop/change.
2. **Maintainability is not a first-class assertion.** Build + Playwright can pass while coupling,
   duplication or architecture worsen.
3. **The mission plan lacks upstream design artifacts.** It has a contract, milestones and features, but not
   product review, architecture contracts, program design or vertical slices.
4. **Mission features can be horizontal.** The live `hello-nextjs` plan split package metadata, layout/page,
   tests and README into separate features. That is convenient for the workflow, but not a vertical slice.
5. **Agent review can become the sole gate.** Review agents raise the floor; they inherit the same
   intent-reconstruction problem. High-blast-radius changes need human judgment.
6. **Greenfield demos do not prove brownfield maintainability.** A successful `hello-nextjs` lights-off run
   is evidence for a small greenfield goal, not for a ten-year-old codebase.
7. **No comprehension-debt or review-burden metric.** We measure runs, cost, gates and validation, but not
   how much shipped code no human understands.

---

## 6. P0 implementation record

P0 is the minimum set that makes the factory’s autonomy claim defensible. It is intentionally scoped to
schema, planner, workflow, UI and tests — not a new benchmark platform.

### P0.1 — Risk-tiered autonomy

**Goal:** replace factory-wide “full” with per-loop risk tiers and route human attention by blast radius.

Proposed governance shape (backward-compatible defaults):

```yaml
governance:
  autonomyLevel: full          # existing kill-switch semantics remain
  risk:
    defaultTier: low
    tiers:
      low:
        planApproval: auto
        review: agent
        merge: auto_on_green
      medium:
        planApproval: human
        review: agent
        merge: auto_on_green
      high:
        planApproval: human
        review: human
        merge: human
    highRiskPaths:
      - "auth/**"
      - "billing/**"
      - "migrations/**"
      - "public-api/**"
      - "security/**"
```

Behavior:

- Auto-approve a mission plan only when the plan’s risk tier is `low`, autonomy is enabled/unpaused,
  `autonomyLevel: full`, and the benchmark gate is satisfied.
- `medium` and `high` require a human plan gate even under full autonomy.
- `high` requires a human review gate and a human ship gate; never auto-merge.
- Derive risk from explicit plan/feature tier plus path globs, change size and touched areas.
- Record the tier and the reasons in the plan, the `mission.plan.approved` event, the review packet and the
  work item source ref.

Files likely touched:

- `packages/core/src/schema/factory.ts`
- `packages/core/src/missions/types.ts`, `schema.ts`, `plan.ts`
- `packages/orchestration/src/activities/mission.ts`
- `packages/orchestration/src/workflows/mission.ts`
- `packages/orchestration/src/workflows/factory.ts`
- `apps/web/src/app/factories/[id]/missions/[missionId]/page.tsx`
- `apps/web/src/lib/types.ts`, `help.ts`
- tests: schema, planner, mission workflow, web E2E.

Acceptance:

- A `high`-risk plan cannot be auto-approved; the gate is human and the event records the reason.
- A `low`-risk full-autonomy plan still auto-approves.
- A high-risk work item cannot auto-merge.
- Existing factories validate with defaults (`low` or `medium` as chosen).

### P0.2 — Maintainability and architecture assertions

**Goal:** make “the codebase got better, not just greener” part of the validation contract.

Add validation tiers:

```ts
VALIDATION_TIERS = [
  'unit', 'component', 'integration', 'e2e', 'manual',
  'architecture', 'maintainability',
]
```

Add built-in check templates:

- **architecture:** dependency direction/layering, dependency cycles, public API/schema stability,
  component boundary violations. Prefer a repo script (`arch:check` / dependency-cruiser / import-linter)
  or an agent inspection with a concrete report.
- **maintainability:** duplication, complexity, churn, rework, mutation score where available, diff size and
  dependency count thresholds. Use explicit thresholds in `expected`, not vibes.

Planner rules:

- For `medium`/`high` risk runnable goals, the contract must include at least one `architecture` assertion
  and one `maintainability` assertion.
- For high-risk changes, missing required architecture/maintainability evidence blocks the verify gate.
- Evidence should carry metrics where possible (`metrics: Record<string, number>`) so thresholds are
  auditable, not prose.

Files likely touched:

- `packages/core/src/validation/types.ts`, `schema.ts`, `build.ts`
- `packages/core/src/missions/types.ts`, `schema.ts`
- `packages/orchestration/src/models/mission-planner.ts`
- verify/validation workflow and UI panels
- tests: schema, contract evaluation, planner, UI.

Acceptance:

- A medium/high plan without architecture/maintainability assertions fails plan validation.
- A verify gate refuses approval when required maintainability evidence is missing.
- The mission detail page shows the assertion tier, threshold and evidence.
- Existing contracts remain valid (new tiers are additive).

### P0.3 — Planning artifacts

**Goal:** put product, architecture and program design in the mission plan before code exists.

Add optional plan fields (strict schema, defaults empty for old plans):

```ts
interface MissionPlan {
  // existing fields...
  productReview?: {
    problem: string;
    desiredBehavior: string[];
    mockups: string[];
  };
  architecture?: {
    summary: string;
    components: Array<{ name: string; responsibility: string; contracts: string[] }>;
    dataModels: string[];
    constraints: string[];
  };
  programDesign?: {
    modules: Array<{ name: string; path: string; responsibility: string; publicApi: string[] }>;
    callGraph: string[];
  };
  verticalSlices?: Array<{
    name: string;
    order: number;
    featureIds: string[];
    checks: string[];
  }>;
}
```

Planner prompt:

- Produce product review first: problem, desired behavior, acceptance examples.
- Produce system architecture: components, contracts, data models, constraints.
- Produce program design: modules, types/signatures, call graph, layout.
- Then milestones/features as vertical slices, not horizontal layers.
- For small changes, these sections may be brief; do not require ceremony for a one-line fix.

UI:

- Mission plan card shows Product review, Architecture, Program design, Vertical slices.
- Plan gate review shows these before approval.
- Empty/optional sections render honestly, not as fabricated content.

Acceptance:

- A non-trivial planner run produces the artifacts; deterministic planner produces sensible defaults.
- Plan gate UI shows them; E2E covers it.
- Existing plans without the fields still validate and render.

### P0.4 — Vertical slices

**Goal:** every mission feature delivers a runnable/testable behavior or a clearly justified enabler.

Add to `MissionFeaturePlan`:

```ts
verticalSlice: string;      // the end-to-end behavior this feature delivers
kind?: 'slice' | 'enabler'; // enabler must explain why it cannot ship a behavior yet
```

Planner rules:

- Prefer `slice` features. A `enabler` feature must state what it unblocks and which later slice verifies it.
- Avoid “add package.json” as a standalone feature; group scaffolding with the first runnable slice.
- Each feature claims acceptance assertions that can be exercised after the feature merges (or at the
  milestone boundary for enablers).

Acceptance:

- Planner validation rejects a plan with no `slice` feature.
- `hello-nextjs`-style plans group scaffolding into a runnable slice.
- UI shows slice/enabler and the checks.

### P0.5 — Review packet and human review for high risk

**Goal:** make human review cheap and route it to the changes that need it.

Add a deterministic review packet, stored as a work-item event/artifact:

```ts
type ReviewPacket = {
  riskTier: 'low' | 'medium' | 'high';
  intent: string;
  planRef: string;
  changedFiles: number;
  diffStats: { additions: number; deletions: number };
  assertions: Array<{ id: string; status: string; evidence: string }>;
  architectureImpact: string[];
  openQuestions: string[];
  reviewerChecklist: string[];
};
```

Behavior:

- Generate the packet after review/verify evidence is available.
- UI shows a compact packet on work-item detail and in the Inbox; full diff remains available.
- For `high` risk, a human review gate is mandatory before ship; agent review is triage, not the sole gate.
- For `low` risk, agent review + auto-merge can proceed when the verification oracle is cheap and reliable.
- For `medium`, agent review + auto-merge on green, with human spot-check sampling (configurable).

Acceptance:

- High-risk work items cannot reach ship without a human review decision.
- The packet appears in the UI and contains the plan link, evidence and risk reasons.
- The Inbox shows the packet summary, not just a raw diff link.
- E2E covers a high-risk gate and a low-risk auto path.

---

## 7. P1/P2 backlog (not P0)

- **Context pack per feature:** ADRs, prior PRs, test standards, failure history, architecture constraints.
- **Longitudinal brownfield benchmark:** repeated changes over months; measure rework, churn, duplication,
  review time, change failure rate.
- **Comprehension-debt metric:** unread diff volume, modules not human-touched, review coverage; use as an
  autonomy gate.
- **Quality stop conditions:** max diff size/files, max new dependencies, no duplication/dependency-cycle
  increase, stop on repeated rework.
- **Safe dark loops:** nightly lint/anti-pattern fixer opening one small PR.
- **Model routing by harness:** prefer models trained against their harness; benchmark per harness/model.
- **Language:** “risk-tiered autonomy” / “lit factory” instead of universal “lights off”.

---

## 8. Verification plan for P0

- Schema round-trip: old and new factory definitions validate; `factories/example`, `example-lights-off`,
  `hello-nextjs` still pass.
- Planner tests: artifacts, risk tier, vertical slices, architecture/maintainability assertions.
- Mission workflow tests: auto-approval only low risk; medium/high human gate; high human review/ship.
- Validation tests: missing architecture/maintainability evidence blocks verify.
- Web E2E: plan artifacts render; review packet renders; high-risk gate requires human decision.
- `bun run ci`, `openspec validate --all`, `bash scripts/smoke.sh`.
- Live check: one low-risk full-autonomy mission and one high-risk human-gated mission on `hello-nextjs`.

---

## 9. Open questions

1. Should `medium` require a human plan gate, or only human review? The talk implies upstream judgment is
   cheap; default to human plan for medium, but allow a factory override with an audited benchmark attestation.
2. Which paths are high-risk by default? Start with auth, billing, migrations, public API and security; make
   the list configurable.
3. Do we add a DB column for work-item risk tier, or keep it in `sourceRef`/plan JSON for P0? Prefer
   `sourceRef`/plan JSON first; add a migration only if filtering/indexing needs it.
4. Should architecture/maintainability checks be deterministic scripts, agent reports, or both? Both:
   deterministic where the repo has a script; agent inspection with a report otherwise.
5. How do we measure comprehension debt without surveillance? Use aggregate review coverage and unread-diff
   volume, not individual developer metrics.

---

## 10. Sources

- Dex Horthy, *Why Software Factories Fail*, AI Engineer World’s Fair 2026:
  <https://www.youtube.com/watch?v=Ib5GBkD555M>
- AI Engineer talk page (edited transcript/chapters):
  <https://ai.engineer/talks/Ib5GBkD555M-why-software-factories-fail>
- Faros AI, *AI-generated code is creating a code review burden for senior engineers*:
  <https://www.faros.ai/blog/ai-code-quality-senior-engineer-review-burden>
- Faros AI, *AI Acceleration Whiplash*:
  <https://www.faros.ai/blog/ai-acceleration-whiplash-takeaways>
- GitClear, *The Maintainability Gap*:
  <https://www.gitclear.com/the_ai_code_quality_maintainability_gap>
- METR, *Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity*:
  <https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/>
- METR, 2026 update: <https://metr.org/blog/2026-02-24-uplift-update/>
- Addy Osmani, *Software Factories, Light and Dark*:
  <https://addyo.substack.com/p/software-factories-light-and-dark>
- Addy Osmani, *Comprehension Debt*:
  <https://medium.com/@addyosmani/comprehension-debt-the-hidden-cost-of-ai-generated-code-285a25dac57e>
- Faros AI, *Comprehension debt in software engineering*:
  <https://www.faros.ai/blog/comprehension-debt-in-software-engineering>
- DORA metrics: <https://dora.dev/guides/dora-metrics/>
- Architecture fitness functions: <https://www.infoq.com/articles/fitness-functions-architecture/>
- Risk-based code review: <https://www.cortex.io/post/risk-based-code-review>
- Pragmatic Engineer, *What is happening with code reviews?*:
  <https://newsletter.pragmaticengineer.com/p/what-is-happening-with-code-reviews>
- Vertical-slice architecture for AI-generated code:
  <https://managed-code.com/blog-post/vertical-slice-architecture-for-ai-generated-code>
- SWE-Marathon: <https://arxiv.org/abs/2606.07682>
- DeepSWE: <https://deepswe.datacurve.ai/>
- FrontierCode: <https://cognition.com/blog/frontier-code>
- StrongDM software factory:
  <https://www.strongdm.com/blog/the-strongdm-software-factory-building-software-with-ai>
- Hacker News discussion: <https://news.ycombinator.com/item?id=49023019>
