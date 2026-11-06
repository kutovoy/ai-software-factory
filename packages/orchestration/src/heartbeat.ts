import { Context } from '@temporalio/activity';

/**
 * Heartbeat wrapper. Activities call it on every persisted event so Temporal can detect a
 * dead worker; when an activity function is invoked directly in a unit test there is no
 * activity context, and the call is a no-op instead of an exception.
 */
export function heartbeat(details?: Record<string, unknown>): void {
  try {
    Context.current().heartbeat(details);
  } catch {
    // no activity context (unit tests, scripts)
  }
}

/**
 * Keeps a long activity alive while it is blocked on a slow external operation (a remote
 * command poll, a large `docker cp`, a quiet shell command). The returned function stops
 * the pulse. Calls are no-ops without an activity context.
 */
export function heartbeatPulse(
  details: Record<string, unknown> = {},
  intervalMs = 5_000,
): () => void {
  const timer = setInterval(() => heartbeat(details), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
