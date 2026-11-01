/**
 * Failure presentation helpers for the run detail page.
 *
 * The API stores the text `describeFailure()` produced (`<code>: <message>`), so the code
 * does not need a schema change: it is parsed from the prefix. Old rows that still hold the
 * Temporal wrapper (`Activity task failed`) simply have no code and fall back to the generic
 * hint.
 */

/** Codes the console knows how to explain. */
export type KnownFailureCode =
  | 'docker_unavailable'
  | 'model_unresolved'
  | 'runner_unavailable'
  | 'permission_timeout';

const CODE_PREFIX = /^\s*([a-z][a-z0-9_]*)\s*:/;

/** Extracts `<code>` from a `<code>: <message>` failure text, when present. */
export function failureCode(text: string | null | undefined): string | undefined {
  const match = CODE_PREFIX.exec(text ?? '');
  return match?.[1];
}

/** Removes the code prefix so the panel shows the human message once, not twice. */
export function failureMessage(text: string | null | undefined): string {
  const value = (text ?? '').trim();
  if (!value) return 'run failed';
  const match = CODE_PREFIX.exec(value);
  return match ? value.slice(match[0].length).trim() : value;
}

const HINTS: Record<KnownFailureCode, string> = {
  docker_unavailable:
    'The worker cannot reach the Docker CLI or the daemon, so it cannot lease a sandbox. ' +
    'Rebuild the worker image (docker compose up -d --build worker) and confirm ' +
    '/var/run/docker.sock is mounted: `docker compose exec worker docker version` must print a server version.',
  model_unresolved:
    'The model reference did not resolve. Check FACTORY_MODEL (and the definition’s env:FACTORY_* ' +
    'reference) against the model list served by the configured provider base URL.',
  runner_unavailable:
    'The runner sandbox could not be created. Build the runner image ' +
    '(`docker build -t factory-runner:local packages/runners/docker`) and check that the ' +
    'harness install (opencode) succeeded inside it.',
  permission_timeout:
    'The run waited for a permission decision past the SLA, so it was auto-denied and failed. ' +
    'Decide faster in the Inbox, raise PERMISSION_TIMEOUT_MS, or set autoAllowPermissions for ' +
    'unattended stage runs.',
};

const GENERIC_HINT =
  'Open the workflow history in Temporal (link above) and look at the failing activity. ' +
  'Fix the cause, then use "Retry as new run" below — it starts a fresh run with the same input ' +
  'and leaves this record unchanged.';

/** Remediation hint for a failure code; generic advice for anything unknown or missing. */
export function remediationFor(code: string | null | undefined): string {
  if (code && code in HINTS) return HINTS[code as KnownFailureCode];
  return GENERIC_HINT;
}

/** Temporal UI deep link for a workflow, e.g. `http://localhost:8233/namespaces/default/workflows/<id>`. */
export function temporalWorkflowUrl(workflowId: string | null | undefined): string | null {
  if (!workflowId) return null;
  const base = process.env.NEXT_PUBLIC_TEMPORAL_UI_URL ?? 'http://localhost:8233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  return `${base.replace(/\/$/, '')}/namespaces/${encodeURIComponent(namespace)}/workflows/${encodeURIComponent(workflowId)}`;
}

/** 12-character commit SHA: enough to identify a version, short enough for a metadata cell. */
export function shortSha(commit: string | null | undefined): string {
  if (!commit) return '—';
  return commit.slice(0, 12);
}
