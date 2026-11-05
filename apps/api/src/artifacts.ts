import { extname, resolve, sep } from 'node:path';
import { runDir, type RunArtifact } from '@factory/orchestration';

/**
 * Artifact download helpers (spec `artifact-store` › Download).
 *
 * A stored artifact is served as a short-lived presigned GET; a local artifact falls back to
 * the file in `runs/<runId>/<path>`. The path check is deliberately pure so it can be tested
 * without a database: nothing outside the run directory is ever served.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.diff': 'text/x-diff; charset=utf-8',
  '.patch': 'text/x-diff; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml',
  '.csv': 'text/csv; charset=utf-8',
};

export function contentTypeForArtifactPath(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolves `artifactPath` under the run directory, refusing absolute paths and any `..`
 * traversal. Returns null when the path escapes the run directory.
 */
export function resolveLocalArtifactPath(
  runsDir: string,
  runId: string,
  artifactPath: string,
): string | null {
  if (typeof artifactPath !== 'string' || artifactPath.trim() === '') return null;
  const base = resolve(runDir(runsDir, runId));
  const target = resolve(base, artifactPath);
  if (target !== base && !target.startsWith(`${base}${sep}`)) return null;
  return target;
}

export type ArtifactDownloadPlan =
  | { kind: 'redirect'; url: string }
  | { kind: 'file'; path: string; contentType: string };

/**
 * Chooses the download path for one run artifact: object storage when the artifact carries
 * a `storageKey` (the API signs a GET), otherwise the local run-directory file. Returns null
 * when a local path would escape the run directory.
 */
export function planArtifactDownload(input: {
  artifact: RunArtifact;
  runsDir: string;
  runId: string;
  presignGet?: (storageKey: string) => string;
}): ArtifactDownloadPlan | null {
  if (input.artifact.storageKey) {
    if (!input.presignGet) return null;
    return { kind: 'redirect', url: input.presignGet(input.artifact.storageKey) };
  }
  const path = resolveLocalArtifactPath(input.runsDir, input.runId, input.artifact.path);
  if (!path) return null;
  return {
    kind: 'file',
    path,
    contentType: input.artifact.contentType ?? contentTypeForArtifactPath(input.artifact.path),
  };
}

/** `attachment; filename="..."` without letting the artifact name break the header. */
export function contentDispositionForArtifact(path: string): string {
  const name = path.split('/').at(-1) ?? 'artifact';
  const safe = name.replace(/["\\\r\n]/g, '_').slice(0, 200) || 'artifact';
  return `attachment; filename="${safe}"`;
}
