-- Work item cancellation (harden-runtime, task 1.2).
--
-- Cancellation is cooperative like run cancellation (ADR-013): the API records the
-- request (actor, reason, timestamp) in the read model and Signals `cancelWorkItem`; the
-- workflow cancels the in-flight stage child and ends `cancelled`. `cancel_requested_at`
-- is also read before every dispatch, so a lost Signal cannot resurrect a cancelled item.
-- The columns are additive; a repeat cancel is a no-op (only the first request is kept).

alter table work_items add column if not exists cancel_requested_at timestamptz;
alter table work_items add column if not exists cancel_actor text;
alter table work_items add column if not exists cancel_reason text;

create index if not exists work_items_cancel_idx
  on work_items (factory) where cancel_requested_at is not null;
