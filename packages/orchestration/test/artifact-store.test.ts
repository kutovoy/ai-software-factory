import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_ARTIFACT_BYTES,
  S3ArtifactStore,
  artifactObjectKey,
  artifactStoreEnabled,
  artifactStoreFromConfig,
  defaultArtifactContentType,
  resolveArtifactStoreConfig,
  sanitizeArtifactPath,
  sanitizeKeySegment,
  verifyArtifactMetadata,
  verifyStoredMetadata,
} from '../src/artifact-store';

const FIXED_NOW = new Date('2026-11-04T00:00:00.000Z');

const configured = {
  ARTIFACT_STORE: 's3',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'factory-artifacts',
  S3_ACCESS_KEY: 'minio',
  S3_SECRET_KEY: 'minio-secret',
  S3_REGION: 'us-east-1',
  S3_FORCE_PATH_STYLE: '1',
  S3_PRESIGN_EXPIRY_SECONDS: '900',
} as NodeJS.ProcessEnv;

describe('resolveArtifactStoreConfig', () => {
  test('is disabled by default (safe unconfigured deployment)', () => {
    const config = resolveArtifactStoreConfig({} as NodeJS.ProcessEnv);
    expect(config.mode).toBe('none');
    expect(artifactStoreEnabled(config)).toBe(false);
    expect(artifactStoreFromConfig(config)).toBeNull();
    expect(config.maxArtifactBytes).toBe(DEFAULT_MAX_ARTIFACT_BYTES);
    expect(config.forcePathStyle).toBe(true);
  });

  test('a partial configuration stays disabled', () => {
    const config = resolveArtifactStoreConfig({
      ARTIFACT_STORE: 's3',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'factory-artifacts',
    } as NodeJS.ProcessEnv);
    expect(config.mode).toBe('none');
  });

  test('ARTIFACT_STORE=none wins even when credentials exist', () => {
    const config = resolveArtifactStoreConfig({ ...configured, ARTIFACT_STORE: 'none' });
    expect(config.mode).toBe('none');
  });

  test('a complete configuration enables S3 and defaults the internal endpoint', () => {
    const config = resolveArtifactStoreConfig(configured);
    expect(config.mode).toBe('s3');
    expect(config.internalEndpoint).toBe('http://localhost:9000');
    expect(config.presignExpirySeconds).toBe(900);
    expect(artifactStoreEnabled(config)).toBe(true);
  });

  test('clamps expiry and honours an internal endpoint override', () => {
    const config = resolveArtifactStoreConfig({
      ...configured,
      S3_INTERNAL_ENDPOINT: 'http://minio:9000',
      S3_PRESIGN_EXPIRY_SECONDS: '999999',
      S3_MAX_ARTIFACT_BYTES: '1024',
    });
    expect(config.internalEndpoint).toBe('http://minio:9000');
    expect(config.presignExpirySeconds).toBe(7 * 24 * 60 * 60);
    expect(config.maxArtifactBytes).toBe(1024);
  });
});

describe('artifact keys', () => {
  test('builds a tenant/run prefix and sanitizes traversal', () => {
    expect(
      artifactObjectKey({ tenant: 'default', runId: 'run_1', path: 'artifacts/build.log' }),
    ).toBe('tenants/default/runs/run_1/artifacts/build.log');

    expect(
      artifactObjectKey({ tenant: 'Acme Corp', runId: 'run/../1', path: '../../etc/passwd' }),
    ).toBe('tenants/Acme-Corp/runs/run-1/etc/passwd');
  });

  test('sanitizeArtifactPath refuses paths with no usable segment', () => {
    expect(() => sanitizeArtifactPath('/')).toThrow();
    expect(() => sanitizeArtifactPath('../..')).toThrow();
    expect(sanitizeArtifactPath('a b/c d.log')).toBe('a-b/c-d.log');
  });

  test('sanitizeKeySegment falls back when nothing survives', () => {
    expect(sanitizeKeySegment('///')).toBe('default');
    expect(sanitizeKeySegment('', 'run')).toBe('run');
  });
});

describe('S3ArtifactStore', () => {
  const store = new S3ArtifactStore(resolveArtifactStoreConfig(configured), () => FIXED_NOW);

  test('presigns a run-scoped PUT grant with the artifact content type', () => {
    const grant = store.presignUpload({
      tenant: 'default',
      runId: 'run_1',
      path: 'artifacts/build.log',
      contentType: defaultArtifactContentType('log'),
    });

    expect(grant.path).toBe('artifacts/build.log');
    expect(grant.key).toBe('tenants/default/runs/run_1/artifacts/build.log');
    expect(grant.bucket).toBe('factory-artifacts');
    expect(grant.url.startsWith('http://localhost:9000/factory-artifacts/tenants/default/runs/run_1/')).toBe(true);
    expect(grant.url).toContain('X-Amz-Signature=');
    expect(grant.headers?.['content-type']).toBe('text/plain; charset=utf-8');
  });

  test('presigns a GET download for a stored key', () => {
    const url = store.presignDownload({ key: 'tenants/default/runs/run_1/patch.diff' });
    expect(url.startsWith('http://localhost:9000/factory-artifacts/tenants/default/runs/run_1/patch.diff?')).toBe(true);
    expect(url).toContain('X-Amz-Expires=900');
  });

  test('a disabled store cannot be constructed', () => {
    expect(() => new S3ArtifactStore(resolveArtifactStoreConfig({} as NodeJS.ProcessEnv))).toThrow(
      /disabled/,
    );
  });
});

describe('artifact metadata verification', () => {
  const artifact = {
    path: 'patch.diff',
    bytes: 10,
    sha256: 'a'.repeat(64),
    kind: 'patch',
  };

  test('accepts valid metadata and enforces the size cap', () => {
    expect(verifyArtifactMetadata(artifact)).toBeNull();
    expect(verifyArtifactMetadata(artifact, { maxBytes: 10 })).toBeNull();
    expect(verifyArtifactMetadata(artifact, { maxBytes: 9 })).toMatch(/limit/);
  });

  test('rejects malformed metadata', () => {
    expect(verifyArtifactMetadata({ ...artifact, path: '' })).toMatch(/path/);
    expect(verifyArtifactMetadata({ ...artifact, bytes: -1 })).toMatch(/byte size/);
    expect(verifyArtifactMetadata({ ...artifact, sha256: 'nope' })).toMatch(/sha256/);
  });

  test('a size or checksum mismatch is an upload error', () => {
    expect(verifyStoredMetadata(artifact, { bytes: 10, sha256: 'a'.repeat(64) })).toBeNull();
    expect(verifyStoredMetadata(artifact, { bytes: 11 })).toMatch(/size mismatch/);
    expect(verifyStoredMetadata(artifact, { sha256: 'b'.repeat(64) })).toMatch(/checksum/);
  });
});
