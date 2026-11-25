# Design

## Slop budgets

`quality.slopBudget` is a per-risk-tier object. Defaults:

- low: 200 diff lines, 5 files, 0 new dependencies, 0.5% duplication delta, 5 complexity delta
- medium: 400 lines, 10 files, 1 dependency, 1% duplication, 10 complexity
- high: 800 lines, 20 files, 2 dependencies, 2% duplication, 20 complexity

Metrics are deterministic and come from the captured patch, package.json diff and validation evidence. An
unknown metric is reported as unknown, never as zero. Overages are recorded as `slop.budget_exceeded`; an
agent review gate resolves `request_changes`, and a human gate shows the overage with an explicit waiver path.

## Review packet v2

The packet remains deterministic. New fields:

- `slopBudget`, `slopActual`, `slopStatus`
- `blastRadius` (paths, high-risk paths, public API/schema changes)
- `proofArtifacts` (kind, path, commit, hash, label)
- `readFirst` (ordered files and why)
- `decisions` (gate decisions and review verdicts)
- `reviewerRoles` (correctness, architecture, security, product)
- `comprehension` (estimated read minutes, files without tests, modules without owner)

A separate `review.explainer` artifact may carry model prose (executive summary / HTML page); it is clearly
labelled and never replaces deterministic packet facts.

## Proof artifacts

Proof is collected from `runs/<id>/artifacts/` and the artifact store. A proof record is bound to the run and
commit; a missing required proof makes the verify projection incomplete. UI/behavioral assertions declare an
`artifactKind` (screenshot, video, html, curl, report).

## Context pack

A deterministic, bounded markdown bundle:

- relevant ADRs from `docs/DECISIONS.md` scored by keyword overlap
- architecture constraints from the mission plan
- prior work items/PRs touching the same paths (when available)
- test standards/commands from package.json and config files
- relevant files and owners

It is passed into feature/stage prompts and referenced from the review packet. No embeddings in P0.

## Plan depth

`planDepth` is `none`, `light` or `full`; `expectedPain` is `low`, `medium` or `high`. Selection:

- low risk + small diff + reversible: `light` or `none`
- medium risk or data/API/schema change: `light`/`full`
- high risk: `full` + human plan gate

`leverage` is a short statement of the smallest change that unlocks the outcome.
