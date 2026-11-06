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
  S3_ACCESS_KEY: 'rustfs',
  S3_SECRET_KEY: 'rustfs-secret',
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
      S3_INTERNAL_ENDPOINT: 'http://rustfs:9000',
      S3_PRESIGN_EXPIRY_SECONDS: '999999',
      S3_MAX_ARTIFACT_BYTES: '1024',
    });
    expect(config.internalEndpoint).toBe('http://rustfs:9000');
    expect(config.presignExpirySeconds).toBe(7 * 24 * 60 * 60);
    expect(config.maxArtifactBytes).toBe(1024);
  });

  test('separates the agent upload endpoint from the browser download endpoint', () => {
    const config = resolveArtifactStoreConfig({
      ...configured,
      S3_ENDPOINT: 'http://host.docker.internal:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
    });
    expect(config.endpoint).toBe('http://host.docker.internal:9000');
    expect(config.publicEndpoint).toBe('http://localhost:9000');
    // The internal endpoint still defaults to the upload endpoint.
    expect(config.internalEndpoint).toBe('http://host.docker.internal:9000');
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

  test('uses the public endpoint for downloads but the upload endpoint for grants', () => {
    const split = new S3ArtifactStore(
      resolveArtifactStoreConfig({
        ...configured,
        S3_ENDPOINT: 'http://host.docker.internal:9000',
        S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      }),
      () => FIXED_NOW,
    );
    const grant = split.presignUpload({
      tenant: 'default',
      runId: 'run_1',
      path: 'patch.diff',
      contentType: 'text/x-diff',
    });
    expect(grant.url.startsWith('http://host.docker.internal:9000/')).toBe(true);
    const download = split.presignDownload({ key: grant.key });
    expect(download.startsWith('http://localhost:9000/')).toBe(true);
  });

  test('a disabled store cannot be constructed', () => {
    expect(() => new S3ArtifactStore(resolveArtifactStoreConfig({} as NodeJS.ProcessEnv))).toThrow(
      /disabled/,
    );
  });

  test('presigns a DELETE against the internal endpoint', () => {
    const store = new S3ArtifactStore(
      resolveArtifactStoreConfig({ ...configured, S3_INTERNAL_ENDPOINT: 'http://rustfs:9000' }),
      () => FIXED_NOW,
    );
    const url = store.presignDelete({ key: 'tenants/default/runs/run_1/patch.diff' });
    expect(url.startsWith('http://rustfs:9000/factory-artifacts/tenants/default/runs/run_1/patch.diff?')).toBe(true);
    expect(url).toContain('X-Amz-Signature=');
  });

  test('deleteStoredObject sends a signed DELETE and treats 404 as already gone', async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const deleted = await store.deleteStoredObject('tenants/default/runs/run_1/a.log', fetchImpl);
    expect(deleted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toContain('/factory-artifacts/tenants/default/runs/run_1/a.log?');
    expect(calls[0]?.url).toContain('X-Amz-Signature=');

    const gone = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    expect(await store.deleteStoredObject('tenants/default/runs/run_1/a.log', gone)).toBe(true);
  });

  test('deleteStoredObject reports a failure without throwing', async () => {
    const failing = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    expect(await store.deleteStoredObject('tenants/default/runs/run_1/a.log', failing)).toBe(false);

    const offline = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    expect(await store.deleteStoredObject('tenants/default/runs/run_1/a.log', offline)).toBe(false);
    expect(await store.deleteStoredObject('', offline)).toBe(false);
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
