import {
  DEFAULT_PRESIGN_EXPIRY_SECONDS,
  DEFAULT_S3_REGION,
  MAX_PRESIGN_EXPIRY_SECONDS,
  MIN_PRESIGN_EXPIRY_SECONDS,
  presignS3Delete,
  presignS3Get,
  presignS3Put,
} from './s3-presign';

/**
 * Artifact store abstraction (ADR-047, spec `artifact-store`).
 *
 * RustFS is the default S3-compatible backend; S3/R2 are selected by configuration. The
 * control plane owns bucket + credentials and only ever hands agents short-lived presigned
 * grants. Storage is off unless `ARTIFACT_STORE=s3` *and* endpoint/bucket/credentials are
 * present, so an unconfigured deployment keeps the metadata-only behaviour.
 */

export type ArtifactStoreMode = 's3' | 'none';

export interface ArtifactStoreConfig {
  mode: ArtifactStoreMode;
  /** Endpoint agents use for presigned uploads (must be reachable from runner hosts). */
  endpoint?: string;
  /** Endpoint browsers use for presigned downloads; defaults to `endpoint`. */
  publicEndpoint?: string;
  /** Server-side endpoint for optional HEAD verification; defaults to `endpoint`. */
  internalEndpoint?: string;
  bucket?: string;
  accessKey?: string;
  secretKey?: string;
  region: string;
  forcePathStyle: boolean;
  presignExpirySeconds: number;
  /** Per-artifact size cap; larger blobs are refused before a grant is issued. */
  maxArtifactBytes: number;
}

/** Default cap: 50 MiB per artifact. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
/** A single collect command may request at most this many upload grants. */
export const MAX_ARTIFACTS_PER_RUN = 64;

const MAX_KEY_LENGTH = 512;

function trim(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

function intFromEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * Resolves store configuration from the environment. A partially configured store stays
 * disabled instead of failing at request time: the default must be safe.
 */
export function resolveArtifactStoreConfig(
  env: NodeJS.ProcessEnv = process.env,
): ArtifactStoreConfig {
  const endpoint = trim(env.S3_ENDPOINT) ?? trim(env.S3_PUBLIC_ENDPOINT);
  const publicEndpoint = trim(env.S3_PUBLIC_ENDPOINT) ?? endpoint;
  const internalEndpoint = trim(env.S3_INTERNAL_ENDPOINT) ?? endpoint;
  const bucket = trim(env.S3_BUCKET);
  const accessKey = trim(env.S3_ACCESS_KEY);
  const secretKey = trim(env.S3_SECRET_KEY);
  const requested = (env.ARTIFACT_STORE ?? '').trim().toLowerCase() === 's3';
  const configured = Boolean(endpoint && bucket && accessKey && secretKey);

  return {
    mode: requested && configured ? 's3' : 'none',
    ...(endpoint ? { endpoint } : {}),
    ...(publicEndpoint ? { publicEndpoint } : {}),
    ...(internalEndpoint ? { internalEndpoint } : {}),
    ...(bucket ? { bucket } : {}),
    ...(accessKey ? { accessKey } : {}),
    ...(secretKey ? { secretKey } : {}),
    region: trim(env.S3_REGION) ?? DEFAULT_S3_REGION,
    forcePathStyle: boolFromEnv(env.S3_FORCE_PATH_STYLE, true),
    presignExpirySeconds: intFromEnv(
      env.S3_PRESIGN_EXPIRY_SECONDS,
      DEFAULT_PRESIGN_EXPIRY_SECONDS,
      MIN_PRESIGN_EXPIRY_SECONDS,
      MAX_PRESIGN_EXPIRY_SECONDS,
    ),
    maxArtifactBytes: intFromEnv(
      env.S3_MAX_ARTIFACT_BYTES,
      DEFAULT_MAX_ARTIFACT_BYTES,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

export function artifactStoreEnabled(config: ArtifactStoreConfig): boolean {
  return config.mode === 's3';
}

/** A safe single object-key segment (tenant, run id). */
export function sanitizeKeySegment(value: string, fallback = 'default'): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 128);
  return sanitized === '' ? fallback : sanitized;
}

/**
 * Normalises an artifact path into a safe object-key suffix: no absolute paths, no `.`/`..`
 * segments, only `A-Za-z0-9._-` inside each segment, bounded length. The console/API keep
 * the original path in `RunArtifact.path`; this is only the storage key.
 */
export function sanitizeArtifactPath(path: string): string {
  const segments = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map((segment) =>
      segment
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 128),
    )
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');

  if (segments.length === 0) {
    throw new Error(`artifact path "${path}" has no usable segments`);
  }
  const joined = segments.join('/');
  if (joined.length > MAX_KEY_LENGTH) {
    throw new Error(`artifact path "${path}" exceeds ${MAX_KEY_LENGTH} characters`);
  }
  return joined;
}

/**
 * Per-run/tenant object prefix: `tenants/<tenant>/runs/<runId>/<sanitized-path>`.
 * Run-scoped grants can only write under this prefix (design: presign scoping).
 */
export function artifactObjectKey(input: {
  tenant?: string | null;
  runId: string;
  path: string;
}): string {
  return [
    'tenants',
    sanitizeKeySegment(input.tenant ?? 'default'),
    'runs',
    sanitizeKeySegment(input.runId, 'run'),
    sanitizeArtifactPath(input.path),
  ].join('/');
}

/** Default content type per artifact kind; a caller may override it. */
export function defaultArtifactContentType(kind: string): string {
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

export interface ArtifactUploadGrant {
  path: string;
  key: string;
  url: string;
  headers?: Record<string, string>;
  bucket?: string;
}

export interface ArtifactMetadata {
  path: string;
  bytes: number;
  sha256: string;
  kind?: string;
  contentType?: string;
}

/**
 * Pure metadata check shared by the presign route and the agent uploader. Returns an error
 * message, or null when the metadata is usable.
 */
export function verifyArtifactMetadata(
  artifact: ArtifactMetadata,
  options: { maxBytes?: number } = {},
): string | null {
  if (typeof artifact.path !== 'string' || artifact.path.trim() === '') {
    return 'artifact path is required';
  }
  if (!Number.isInteger(artifact.bytes) || artifact.bytes < 0) {
    return `invalid byte size for ${artifact.path}`;
  }
  if (!/^[0-9a-f]{64}$/i.test(artifact.sha256)) {
    return `invalid sha256 for ${artifact.path}`;
  }
  const maxBytes = options.maxBytes;
  if (maxBytes !== undefined && artifact.bytes > maxBytes) {
    return `artifact ${artifact.path} is ${artifact.bytes} bytes; the limit is ${maxBytes}`;
  }
  return null;
}

/** A metadata/HEAD mismatch (size or checksum) is an upload error, not a valid artifact. */
export function verifyStoredMetadata(
  artifact: ArtifactMetadata,
  head: { bytes?: number; sha256?: string },
): string | null {
  if (head.bytes !== undefined && head.bytes !== artifact.bytes) {
    return `size mismatch for ${artifact.path}: reported ${artifact.bytes}, stored ${head.bytes}`;
  }
  if (head.sha256 !== undefined && head.sha256.toLowerCase() !== artifact.sha256.toLowerCase()) {
    return `checksum mismatch for ${artifact.path}`;
  }
  return null;
}

/** S3-backed store: presigns grants and builds run-scoped keys. */
export class S3ArtifactStore {
  readonly bucket: string;

  private readonly config: ArtifactStoreConfig;
  private readonly clock: () => Date;

  constructor(config: ArtifactStoreConfig, clock: () => Date = () => new Date()) {
    if (!artifactStoreEnabled(config)) {
      throw new Error('artifact store is disabled');
    }
    this.config = config;
    this.bucket = config.bucket as string;
    this.clock = clock;
  }

  key(input: { tenant?: string | null; runId: string; path: string }): string {
    return artifactObjectKey(input);
  }

  /** Short-lived, run-scoped presigned PUT for one artifact. */
  presignUpload(input: {
    tenant?: string | null;
    runId: string;
    path: string;
    contentType?: string;
    contentLength?: number;
  }): ArtifactUploadGrant {
    const key = this.key(input);
    const contentType = input.contentType ?? defaultArtifactContentType('file');
    const signed = presignS3Put({
      endpoint: this.config.endpoint as string,
      bucket: this.bucket,
      key,
      accessKey: this.config.accessKey as string,
      secretKey: this.config.secretKey as string,
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle,
      expiresInSeconds: this.config.presignExpirySeconds,
      contentType,
      now: this.clock(),
    });
    return {
      path: input.path,
      key,
      url: signed.url,
      headers: { ...signed.headers },
      bucket: this.bucket,
    };
  }

  /** Short-lived presigned GET for a stored artifact (browser-facing endpoint by default). */
  presignDownload(input: { key: string; endpoint?: string }): string {
    return presignS3Get({
      endpoint:
        input.endpoint ?? this.config.publicEndpoint ?? (this.config.endpoint as string),
      bucket: this.bucket,
      key: input.key,
      accessKey: this.config.accessKey as string,
      secretKey: this.config.secretKey as string,
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle,
      expiresInSeconds: this.config.presignExpirySeconds,
      now: this.clock(),
    }).url;
  }

  /**
   * Best-effort HEAD verification against the server-side endpoint. A transport failure is
   * "unknown" (null), not a mismatch; only a reachable object with a different size fails.
   */
  async headStoredObject(
    key: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ bytes?: number } | null> {
    const url = this.presignDownload({
      key,
      endpoint: this.config.internalEndpoint ?? (this.config.endpoint as string),
    });
    try {
      const response = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return null;
      const length = response.headers.get('content-length');
      const bytes = length === null ? undefined : Number(length);
      return Number.isFinite(bytes) ? { ...(bytes === undefined ? {} : { bytes }) } : {};
    } catch {
      return null;
    }
  }

  /** Short-lived signed DELETE for one stored object (server-side endpoint by default). */
  presignDelete(input: { key: string; endpoint?: string }): string {
    return presignS3Delete({
      endpoint:
        input.endpoint ?? this.config.internalEndpoint ?? (this.config.endpoint as string),
      bucket: this.bucket,
      key: input.key,
      accessKey: this.config.accessKey as string,
      secretKey: this.config.secretKey as string,
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle,
      expiresInSeconds: this.config.presignExpirySeconds,
      now: this.clock(),
    }).url;
  }

  /**
   * Best-effort object deletion for retention (spec `retention`, artifact deletion scenario).
   * Returns `true` when the object is gone (2xx or `404` — already deleted), `false` on a
   * transport/authorization failure. Callers must not roll back metadata on `false`: the
   * next sweep retries and the bucket lifecycle rules are the backstop.
   */
  async deleteStoredObject(key: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
    if (typeof key !== 'string' || key.trim() === '') return false;
    const url = this.presignDelete({ key });
    try {
      const response = await fetchImpl(url, {
        method: 'DELETE',
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok || response.status === 404;
    } catch {
      return false;
    }
  }
}

/** Builds a store from resolved config, or null when storage is disabled. */
export function artifactStoreFromConfig(config: ArtifactStoreConfig): S3ArtifactStore | null {
  return artifactStoreEnabled(config) ? new S3ArtifactStore(config) : null;
}
