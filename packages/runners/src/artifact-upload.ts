import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Artifact } from './protocol';
import type {
  RemoteArtifactUploadGrant,
  RemoteArtifactUploadRequest,
} from './remote-protocol';

/**
 * Agent-side artifact upload (ADR-047).
 *
 * After `collectArtifacts` the agent asks the control plane for short-lived presigned PUT
 * grants, then uploads each blob directly to the S3-compatible store over outbound HTTPS.
 * No long-lived object-store credential is ever sent to the host: the API signs the URLs and
 * the agent only sees a run-scoped, expiring grant.
 *
 * A failed upload never loses the artifact metadata or the inline `patch.diff`: failures are
 * returned as `uploadErrors` and the central collect step records them.
 */

export const RUNNER_ARTIFACT_PRESIGN_PATH = '/api/v1/runner-agent/artifacts/presign';
export const DEFAULT_ARTIFACT_UPLOAD_TIMEOUT_MS = 60_000;
export const DEFAULT_ARTIFACT_MAX_BYTES = 50 * 1024 * 1024;

export interface AgentArtifactUploadOptions {
  /** Control-plane base URL (no trailing slash required). */
  apiUrl: string;
  /** Per-host bearer token; the agent already holds it after enrollment. */
  agentToken: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Per-artifact cap; mirrors `S3_MAX_ARTIFACT_BYTES` on the control plane. */
  maxBytes?: number;
}

export interface UploadArtifactsInput {
  runnerId: string;
  runId: string;
  /** Agent-side temp directory that received the collected files. */
  destDir: string;
}

export interface UploadArtifactsResult {
  artifacts: Artifact[];
  uploadErrors: string[];
}

/** MIME type per artifact kind; the API signs this exact value. */
export function contentTypeForArtifactKind(kind: Artifact['kind']): string {
  switch (kind) {
    case 'patch':
      return 'text/x-diff; charset=utf-8';
    case 'log':
      return 'text/plain; charset=utf-8';
    case 'screenshot':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

/** Resolves an artifact path under `destDir`, refusing anything that escapes it. */
export function safeArtifactFilePath(destDir: string, artifactPath: string): string | null {
  const base = resolve(destDir);
  const target = resolve(base, artifactPath);
  if (target !== base && !target.startsWith(`${base}${sep}`)) return null;
  return target;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asUploads(value: unknown): RemoteArtifactUploadGrant[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is RemoteArtifactUploadGrant =>
      entry !== null &&
      typeof entry === 'object' &&
      typeof (entry as RemoteArtifactUploadGrant).path === 'string' &&
      typeof (entry as RemoteArtifactUploadGrant).key === 'string' &&
      typeof (entry as RemoteArtifactUploadGrant).url === 'string',
  );
}

/**
 * Requests grants for `artifacts`, uploads each file and returns the metadata enriched with
 * `storageKey`/`bucket`/`contentType`. Never throws for an upload problem.
 */
export async function uploadArtifacts(
  artifacts: Artifact[],
  input: UploadArtifactsInput,
  options: AgentArtifactUploadOptions,
): Promise<UploadArtifactsResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_ARTIFACT_UPLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
  const uploadErrors: string[] = [];

  if (artifacts.length === 0) return { artifacts, uploadErrors };

  const requests: RemoteArtifactUploadRequest[] = [];
  for (const artifact of artifacts) {
    if (!Number.isInteger(artifact.bytes) || artifact.bytes < 0) {
      uploadErrors.push(`invalid byte size for ${artifact.path}`);
      continue;
    }
    if (artifact.bytes > maxBytes) {
      uploadErrors.push(`artifact ${artifact.path} is ${artifact.bytes} bytes; the limit is ${maxBytes}`);
      continue;
    }
    if (!/^[0-9a-f]{64}$/i.test(artifact.sha256)) {
      uploadErrors.push(`invalid sha256 for ${artifact.path}`);
      continue;
    }
    requests.push({
      path: artifact.path,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      kind: artifact.kind,
      contentType: contentTypeForArtifactKind(artifact.kind),
    });
  }

  if (requests.length === 0) return { artifacts, uploadErrors };

  let uploads: RemoteArtifactUploadGrant[];
  try {
    const response = await fetchImpl(`${apiBase}${RUNNER_ARTIFACT_PRESIGN_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.agentToken}`,
      },
      body: JSON.stringify({
        runnerId: input.runnerId,
        runId: input.runId,
        artifacts: requests,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      const message =
        typeof payload.message === 'string'
          ? payload.message
          : typeof payload.error === 'string'
            ? payload.error
            : `HTTP ${response.status}`;
      throw new Error(message);
    }
    uploads = asUploads(payload.uploads);
  } catch (error) {
    uploadErrors.push(`artifact presign failed: ${errorMessage(error)}`);
    return { artifacts, uploadErrors };
  }

  // `uploads: []` is the documented "storage is disabled" answer: keep metadata only.
  if (uploads.length === 0) return { artifacts, uploadErrors };

  const byPath = new Map(uploads.map((upload) => [upload.path, upload]));
  const enriched: Artifact[] = [];

  for (const artifact of artifacts) {
    const upload = byPath.get(artifact.path);
    if (!upload) {
      enriched.push(artifact);
      if (!uploadErrors.some((entry) => entry.includes(artifact.path))) {
        uploadErrors.push(`no upload grant for ${artifact.path}`);
      }
      continue;
    }

    const filePath = safeArtifactFilePath(input.destDir, artifact.path);
    if (!filePath) {
      enriched.push(artifact);
      uploadErrors.push(`artifact path escapes the collect directory: ${artifact.path}`);
      continue;
    }

    let body: Buffer;
    try {
      body = await readFile(filePath);
    } catch (error) {
      enriched.push(artifact);
      uploadErrors.push(`cannot read ${artifact.path}: ${errorMessage(error)}`);
      continue;
    }

    const sha256 = createHash('sha256').update(body).digest('hex');
    if (body.byteLength !== artifact.bytes || sha256.toLowerCase() !== artifact.sha256.toLowerCase()) {
      enriched.push(artifact);
      uploadErrors.push(`checksum/size mismatch for ${artifact.path}; not uploaded`);
      continue;
    }

    const contentType = artifact.contentType ?? contentTypeForArtifactKind(artifact.kind);
    const headers: Record<string, string> = { ...(upload.headers ?? {}) };
    if (!headers['content-type'] && !headers['Content-Type']) headers['content-type'] = contentType;

    try {
      const response = await fetchImpl(upload.url, {
        method: 'PUT',
        headers,
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        enriched.push(artifact);
        uploadErrors.push(`upload failed for ${artifact.path}: HTTP ${response.status}`);
        continue;
      }
    } catch (error) {
      enriched.push(artifact);
      uploadErrors.push(`upload failed for ${artifact.path}: ${errorMessage(error)}`);
      continue;
    }

    enriched.push({
      ...artifact,
      storageKey: upload.key,
      ...(upload.bucket ? { bucket: upload.bucket } : {}),
      contentType,
    });
  }

  return { artifacts: enriched, uploadErrors };
}
