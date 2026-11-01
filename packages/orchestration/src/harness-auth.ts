import { createHash } from 'node:crypto';

/**
 * Per-run password for the opencode server (`OPENCODE_SERVER_PASSWORD`).
 *
 * opencode v2's `serve` **generates a random password** on startup and prints it to the
 * container log ("server password <...>"); every `/api/*` call then needs HTTP basic auth
 * as `opencode:<password>`. Without a password the adapter's readiness probe gets
 * `401 Authentication required`, and the run fails with `harness_unreachable` even though
 * the sandbox is healthy.
 *
 * The password is therefore *derived*, not exchanged: the runner activity puts the same
 * value into the harness command's environment and the harness activity hands it to the
 * adapter, so the two activities agree across worker restarts without putting the secret
 * into workflow history. The value is visible to `docker inspect` on the harness container
 * — the same trust boundary as the per-run proxy token (ADR-011).
 *
 * Set `FACTORY_HARNESS_SECRET` to make the derivation host-specific; the default is a
 * fixed local-development value, which is fine because the password only guards a
 * short-lived server on an internal docker network.
 */
export function harnessPasswordFor(runId: string): string {
  const secret = process.env.FACTORY_HARNESS_SECRET ?? 'factory-local-harness';
  return createHash('sha256').update(`${secret}:${runId}`).digest('hex').slice(0, 32);
}
