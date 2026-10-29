-- Merge queue idempotency key: a queue item is identified by the *branch* it will merge
-- (`factory/<workItemId>`), not by the pull request number. The branch is unique per work
-- item, while a PR number only restarts when the forge state is reset (fake forge, demos),
-- which would otherwise dedupe a fresh PR against a stale merged row.

drop index if exists merge_batch_items_unique_pr_idx;

create unique index if not exists merge_batch_items_unique_head_idx
  on merge_batch_items (factory, head) where status <> 'reverted';

create index if not exists merge_batch_items_head_idx
  on merge_batch_items (factory, head);
