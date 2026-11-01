-- Agent gate verdicts (change `add-agent-verdicts`).
--
-- An agent gate now decides from the stage's structured verdict instead of approving
-- whenever the run ends `ok`. The parsed verdict is kept next to the decision so the inbox
-- can show why an automatic gate passed or failed:
--
--   {"decision":"approve|request_changes|reject|unknown",
--    "source":"structured|textual|none",
--    "summary":"...", "findings":[...]}
--
-- `feedback` stays human-readable; `verdict` is the audit record. Null for human gates and
-- for gates decided before this migration.

alter table gate_decisions add column if not exists verdict jsonb;
