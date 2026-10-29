/**
 * Structured logs only (JSON lines). Never log prompts, provider keys, or run tokens:
 * `redact` is applied to every field bag before it is written.
 */
const SECRET_KEYS = /^(authorization|api_?key|token|run_?token|password|secret)$/i;

export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEYS.test(key) ? '[redacted]' : value;
  }
  return out;
}

export function log(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level,
    event,
    ts: new Date().toISOString(),
    ...redact(fields),
  });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}
