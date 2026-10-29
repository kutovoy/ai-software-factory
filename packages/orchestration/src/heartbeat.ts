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
