-- Canary promotion deployment state (harden-runtime, task 5.3).
--
-- Merging the candidate PR changes the definition repo, not the local checkout (ADR-012).
-- Promotion therefore records whether the change actually reached a deployment:
--   deployed                 a `deployHook` ran successfully
--   promoted_pending_deploy  a `deployHook` was configured but failed (error recorded)
--   promotion_pending_deploy no hook is configured; the checkout was NOT updated
-- The rollout status itself stays `promoted` (routing/terminal state) so existing readers
-- and the routing queries keep working.

alter table canary_rollouts add column if not exists deployment_status text
  check (deployment_status in ('deployed', 'promoted_pending_deploy', 'promotion_pending_deploy'));
alter table canary_rollouts add column if not exists deployed_at timestamptz;
alter table canary_rollouts add column if not exists deploy_hook text;
alter table canary_rollouts add column if not exists deploy_error text;
