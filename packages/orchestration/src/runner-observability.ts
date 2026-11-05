import { randomBytes } from 'node:crypto';
import { getSql } from './db';
import { expireLeases } from './runner-hosts';

/**
 * Worker-side observability sweep. Heartbeat ingest evaluates metric thresholds in the
 * API process; this loop covers what ingest cannot see: a host that stopped heartbeating
 * and leases that outlived their TTL.
 */
export async function sweepRunnerObservability(): Promise<{
  hosts: number;
  alerts: number;
  expiredLeases: number;
}> {
  const sql = getSql();
  const now = Date.now();

  const rules = (await sql`
    select id, metric, comparison, threshold, severity, duration_seconds
    from runner_alert_rules
    where enabled = true and metric = 'heartbeat_age_seconds'
  `) as {
    id: string;
    metric: string;
    comparison: 'gt' | 'lt';
    threshold: number;
    severity: 'warning' | 'critical';
    duration_seconds: number;
  }[];

  const hosts = (await sql`
    select id, name, last_heartbeat, status
    from runner_hosts
    where status not in ('deleting')
  `) as {
    id: string;
    name: string;
    last_heartbeat: Date | string | null;
    status: string;
  }[];

  let alerts = 0;
  for (const host of hosts) {
    if (!host.last_heartbeat) continue;
    const ageSeconds = Math.max(
      0,
      (now - new Date(host.last_heartbeat).getTime()) / 1000,
    );

    for (const rule of rules) {
      const firing = rule.comparison === 'gt' ? ageSeconds > rule.threshold : ageSeconds < rule.threshold;
      const dedupeKey = `${host.id}:${rule.id}`;
      if (firing) {
        const value = ageSeconds;
        await sql`
          insert into runner_alerts (
            id, host_id, rule_id, metric, severity, state, value, message, dedupe_key,
            first_seen, last_seen
          ) values (
            ${`al_${randomBytes(12).toString('hex')}`}, ${host.id}, ${rule.id}, ${rule.metric},
            ${rule.severity}, 'firing', ${value},
            ${`runner ${host.name} has not heartbeated for ${Math.round(value)}s`},
            ${dedupeKey}, now(), now()
          )
          on conflict (dedupe_key) where resolved_at is null
          do update set
            value = excluded.value,
            message = excluded.message,
            last_seen = now(),
            state = case
              when runner_alerts.state = 'silenced' and runner_alerts.silenced_until > now()
                then 'silenced'
              when runner_alerts.state = 'acknowledged' then 'acknowledged'
              else 'firing'
            end
        `;
        alerts += 1;
      } else {
        await sql`
          update runner_alerts
          set state = 'resolved', resolved_at = now()
          where dedupe_key = ${dedupeKey} and resolved_at is null
        `;
      }
    }

    const critical = rules
      .filter((rule) => rule.severity === 'critical')
      .reduce((max, rule) => Math.max(max, rule.threshold), 0);
    const warning = rules
      .filter((rule) => rule.severity === 'warning')
      .reduce((min, rule) => Math.min(min, rule.threshold), Number.POSITIVE_INFINITY);
    const offlineAfter = Number.isFinite(warning) ? warning : critical || 90;
    if (ageSeconds > offlineAfter && host.status !== 'unreachable' && host.status !== 'maintenance') {
      await sql`
        update runner_hosts
        set status = 'unreachable', updated_at = now()
        where id = ${host.id}
      `;
    }
  }

  const expired = await expireLeases();
  return { hosts: hosts.length, alerts, expiredLeases: expired.length };
}
