-- Intake sources (roadmap item 8).
--
-- Work items can now enter from Sentry, PostHog, Linear, Jira and the generic API intake
-- route, not only GitHub/Slack/cron/manual. The source stays a text key; the external
-- delivery id is deduped in webhook_deliveries.

alter table work_items drop constraint if exists work_items_source_check;
alter table work_items add constraint work_items_source_check
  check (source in ('forge', 'slack', 'cron', 'manual', 'sentry', 'posthog', 'linear', 'jira', 'api'));
