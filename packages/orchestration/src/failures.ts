/**
 * Cause-preserving failure text.
 *
 * Temporal wraps every activity error in an `ActivityFailure` whose message is the useless
 * wrapper `Activity task failed`; the real cause lives in `cause` (an `ApplicationFailure`
 * carrying the original message, its `type` and any `details`). Storing the wrapper alone
 * turns every failure into the same sentence, so the run page cannot explain what broke and
 * an operator cannot tell `docker_unavailable` from `model_unresolved`.
 *
 * `describeFailure` walks the `cause` chain (bounded, cycle-safe), keeps the informative
 * messages, drops Temporal wrappers and duplicates, and prefixes the error code when one is
 * available — `docker_unavailable: docker CLI/server is not available`.
 *
 * Pure and dependency-free: it is imported by workflow code, so it must stay deterministic
 * (no `instanceof`, no node builtins — Temporal failures are plain objects after decoding).
 */

/** How deep a `cause` chain is walked before giving up (cycles are bounded by this too). */
const MAX_DEPTH = 10;

/** Upper bound on the stored text so a pathological chain cannot bloat the run row. */
const MAX_LENGTH = 2_000;

/** Temporal wrapper messages: they say "something failed", never what. */
const WRAPPER_MESSAGES = new Set([
  'activity task failed',
  'activity task timed out',
  'activity task canceled',
  'child workflow execution failed',
  'workflow execution failed',
  'workflow task failed',
  'workflow task timed out',
]);

/**
 * Factory codes are lower_snake_case (`docker_unavailable`); Node/system errors are ALL CAPS
 * (`ECONNRESET`, `ENOENT`). Error *types* that are class names (`RunnerError`, `Error`) match
 * neither and must not be shown as a code.
 */
const CODE_PATTERN = /^(?:[a-z][a-z0-9_]*|[A-Z][A-Z0-9_]*)$/;

export interface FailureLink {
  /** Machine-readable code, when the chain carries one. */
  code?: string;
  /** Human-readable message, when it is not a Temporal wrapper. */
  message?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function codeCandidate(value: unknown): string | undefined {
  const text = nonEmpty(value);
  return text && CODE_PATTERN.test(text) ? text : undefined;
}

/** Reads one link of the chain: `code` (RunnerError), `type` (ApplicationFailure) or `details[0].code`. */
function linkOf(error: unknown): FailureLink {
  const record = asRecord(error);
  if (!record) {
    // A thrown string/number is its own message.
    const text = nonEmpty(error);
    return text ? { message: text } : {};
  }

  const details = Array.isArray(record.details) ? asRecord(record.details[0]) : undefined;

  const code =
    codeCandidate(record.code) ??
    codeCandidate(details?.code) ??
    // `type` is the ApplicationFailure type: a code when we set it from a RunnerError code.
    codeCandidate(record.type);

  const message =
    nonEmpty(record.message) ?? nonEmpty(details?.message);

  return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

function isWrapper(message: string): boolean {
  return WRAPPER_MESSAGES.has(message.toLowerCase());
}

/**
 * Collapses duplicates: a message that is contained in another kept message adds nothing
 * (`docker CLI/server is not available` inside `lease failed: docker CLI/server is not
 * available`), and an exact repeat is dropped outright.
 */
function uniqueMessages(messages: string[]): string[] {
  const kept: string[] = [];
  for (const message of messages) {
    const lower = message.toLowerCase();
    if (kept.some((existing) => existing.toLowerCase() === lower)) continue;
    if (kept.some((existing) => existing.toLowerCase().includes(lower))) continue;
    kept.push(message);
  }
  return kept;
}

/**
 * Turns any thrown value into one line an operator can act on.
 *
 * @example
 * describeFailure(new RunnerError('docker_unavailable', 'docker CLI/server is not available'))
 * // 'docker_unavailable: docker CLI/server is not available'
 */
export function describeFailure(error: unknown): string {
  const links: FailureLink[] = [];

  let current: unknown = error;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (current === undefined || current === null) break;
    const link = linkOf(current);
    if (link.message || link.code) links.push(link);
    current = asRecord(current)?.cause;
  }

  if (links.length === 0) return 'run failed';

  const code = links.find((link) => link.code)?.code;

  // Deepest first: the root cause is what the operator needs; outer messages are context.
  const ordered = [...links].reverse();
  const messages = uniqueMessages(
    ordered
      .map((link) => link.message)
      .filter((message): message is string => message !== undefined && !isWrapper(message)),
  );

  const deepest = messages[0];
  const context = messages.slice(1);

  let text: string;
  if (deepest) {
    text = context.length > 0 ? `${deepest} (${context.join(' · ')})` : deepest;
    // Node's fetch errors already carry their code in the message ("ECONNRESET: the socket…");
    // do not repeat it.
    if (code && !text.toLowerCase().startsWith(`${code.toLowerCase()}:`)) {
      text = `${code}: ${text}`;
    }
  } else if (code) {
    text = code;
  } else {
    // Only wrapper messages in the chain: keep the outermost one rather than inventing text.
    text = ordered.find((link) => link.message)?.message ?? 'run failed';
  }

  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text;
}
