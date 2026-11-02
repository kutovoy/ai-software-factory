# Design

## Decisions

1. **JSON first, text second.** Parse the last fenced ```json block containing `verdict`; accept
   `approve|pass|ok`, `request_changes|changes_requested|changes`, `reject|fail`. If absent, scan the last
   ~40 lines for explicit signals (`VERDICT: FAIL`, a line starting `FAIL`, `REQUEST_CHANGES`). Otherwise
   `unknown`.
2. **Policy is a definition field.** `agentVerdict: advisory` (default) approves on `unknown`; `required`
   requests changes on `unknown`. This keeps existing factories working and lets a lights-off factory be strict.
3. **Verdict drives the existing gate semantics.** `approve` → automatic approve; `request_changes` → feedback
   text passed to the gate decision (factory loop retries or escalates); `reject` → reject.
4. **Audit, not just a string.** `gate_decisions.verdict` stores `{decision, source, summary, findings}` so the
   inbox can show why an agent gate passed or failed. `feedback` stays human-readable.
5. **Prompt is additive.** The instruction is appended to the stage prompt only when the gate is `agent`; human
   gates are unchanged.
