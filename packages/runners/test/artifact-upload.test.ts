import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contentTypeForArtifactKind,
  safeArtifactFilePath,
  uploadArtifacts,
  type AgentArtifactUploadOptions,
} from '../src/artifact-upload';
import type { Artifact } from '../src/protocol';

/**
 * Agent artifact upload (ADR-047), exercised with an injected `fetch`: no network, no S3.
 * Covers success, disabled storage, presign failure, checksum/size mismatch, oversized
 * artifacts and an expired/rejected grant.
 */

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const options: AgentArtifactUploadOptions = {
  apiUrl: 'https://api.test/',
  agentToken: 'agent-token',
};

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-upload-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function artifact(path: string, body: string, kind: Artifact['kind'] = 'log'): Artifact {
  return { path, bytes: Buffer.byteLength(body), sha256: sha256(body), kind };
}

describe('uploadArtifacts', () => {
  test('requests a grant, uploads the blob and returns object metadata', async () => {
    await withTempDir(async (dir) => {
      const log = artifact('artifacts/build.log', 'build ok\n');
      const patch = artifact('patch.diff', 'diff --git a b\n', 'patch');
      await mkdir(join(dir, 'artifacts'), { recursive: true });
      await writeFile(join(dir, log.path), 'build ok\n');
      await writeFile(join(dir, patch.path), 'diff --git a b\n');

      const presignBodies: Array<Record<string, unknown>> = [];
      const puts: Array<{ url: string; headers: Record<string, string>; body: Uint8Array }> = [];

      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === 'https://api.test/api/v1/runner-agent/artifacts/presign') {
          expect(init?.method).toBe('POST');
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer agent-token');
          presignBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json({
            uploads: [
              {
                path: log.path,
                key: 'tenants/default/runs/run_1/artifacts/build.log',
                bucket: 'factory-artifacts',
                url: 'https://s3.test/log?sig=1',
                headers: { 'content-type': 'text/plain; charset=utf-8' },
              },
              {
                path: patch.path,
                key: 'tenants/default/runs/run_1/patch.diff',
                bucket: 'factory-artifacts',
                url: 'https://s3.test/patch?sig=2',
                headers: { 'content-type': 'text/x-diff; charset=utf-8' },
              },
            ],
          });
        }
        if (url.startsWith('https://s3.test/')) {
          puts.push({
            url,
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body: init?.body as Uint8Array,
          });
          return new Response(null, { status: 200 });
        }
        throw new Error(`unexpected request ${url}`);
      }) as typeof fetch;

      const result = await uploadArtifacts([log, patch], { runnerId: 'factory-run_1', runId: 'run_1', destDir: dir }, {
        ...options,
        fetchImpl,
      });

      expect(result.uploadErrors).toEqual([]);
      expect(presignBodies).toHaveLength(1);
      expect(presignBodies[0]).toMatchObject({
        runnerId: 'factory-run_1',
        runId: 'run_1',
        artifacts: [
          { path: log.path, kind: 'log', contentType: 'text/plain; charset=utf-8' },
          { path: patch.path, kind: 'patch', contentType: 'text/x-diff; charset=utf-8' },
        ],
      });

      expect(puts).toHaveLength(2);
      expect(puts[0]?.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(Buffer.from(puts[0]?.body as Uint8Array).toString('utf8')).toBe('build ok\n');

      const uploadedLog = result.artifacts.find((entry) => entry.path === log.path);
      expect(uploadedLog).toMatchObject({
        storageKey: 'tenants/default/runs/run_1/artifacts/build.log',
        bucket: 'factory-artifacts',
        contentType: 'text/plain; charset=utf-8',
        bytes: log.bytes,
        sha256: log.sha256,
      });
      expect(result.artifacts.find((entry) => entry.path === patch.path)?.storageKey).toBe(
        'tenants/default/runs/run_1/patch.diff',
      );
    });
  });

  test('storage disabled (`uploads: []`) keeps metadata only and reports no errors', async () => {
    await withTempDir(async (dir) => {
      const log = artifact('build.log', 'ok\n');
      await writeFile(join(dir, log.path), 'ok\n');

      const fetchImpl = (async () => json({ uploads: [] })) as unknown as typeof fetch;
      const result = await uploadArtifacts([log], { runnerId: 'r', runId: 'run_1', destDir: dir }, {
        ...options,
        fetchImpl,
      });

      expect(result.uploadErrors).toEqual([]);
      expect(result.artifacts).toEqual([log]);
      expect(result.artifacts[0]?.storageKey).toBeUndefined();
    });
  });

  test('a failed presign keeps the artifact metadata and reports the error', async () => {
    await withTempDir(async (dir) => {
      const log = artifact('build.log', 'ok\n');
      await writeFile(join(dir, log.path), 'ok\n');

      const fetchImpl = (async () =>
        json({ code: 'artifact_lease_mismatch', message: 'no lease' }, 403)) as unknown as typeof fetch;
      const result = await uploadArtifacts([log], { runnerId: 'r', runId: 'run_1', destDir: dir }, {
        ...options,
        fetchImpl,
      });

      expect(result.artifacts).toEqual([log]);
      expect(result.uploadErrors).toHaveLength(1);
      expect(result.uploadErrors[0]).toContain('presign failed');
      expect(result.uploadErrors[0]).toContain('no lease');
    });
  });

  test('a checksum/size mismatch is not uploaded', async () => {
    await withTempDir(async (dir) => {
      const log = artifact('build.log', 'expected\n');
      await writeFile(join(dir, log.path), 'tampered\n');

      let puts = 0;
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/artifacts/presign')) {
          return json({
            uploads: [
              { path: log.path, key: 'k', url: 'https://s3.test/put', headers: {} },
            ],
          });
        }
        puts += 1;
        return new Response(null, { status: 200 });
      }) as typeof fetch;

      const result = await uploadArtifacts([log], { runnerId: 'r', runId: 'run_1', destDir: dir }, {
        ...options,
        fetchImpl,
      });

      expect(puts).toBe(0);
      expect(result.artifacts[0]?.storageKey).toBeUndefined();
      expect(result.uploadErrors[0]).toMatch(/checksum\/size mismatch/);
    });
  });

  test('an artifact over the size cap is not granted or uploaded', async () => {
    await withTempDir(async (dir) => {
      const big = artifact('big.bin', 'x'.repeat(64));
      await writeFile(join(dir, big.path), 'x'.repeat(64));

      let presignCalls = 0;
      const fetchImpl = (async () => {
        presignCalls += 1;
        return json({ uploads: [] });
      }) as unknown as typeof fetch;

      const result = await uploadArtifacts([big], { runnerId: 'r', runId: 'run_1', destDir: dir }, {
        ...options,
        fetchImpl,
        maxBytes: 8,
      });

      expect(presignCalls).toBe(0);
      expect(result.uploadErrors[0]).toMatch(/limit is 8/);
    });
  });

  test('a rejected PUT (expired grant) is an upload error, not a lost artifact', async () => {
    await withTempDir(async (dir) => {
      const log = artifact('build.log', 'ok\n');
      await writeFile(join(dir, log.path), 'ok\n');

      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/artifacts/presign')) {
          return json({
            uploads: [{ path: log.path, key: 'k', url: 'https://s3.test/put', headers: {} }],
          });
        }
        return new Response('expired', { status: 403 });
      }) as typeof fetch;

      const result = await uploadArtifacts([log], { runnerId: 'r', runId: 'run_1', destDir: dir }, {
        ...options,
        fetchImpl,
      });

      expect(result.artifacts[0]).toEqual(log);
      expect(result.uploadErrors[0]).toMatch(/HTTP 403/);
    });
  });

  test('a path that escapes the collect directory is refused', async () => {
    await withTempDir(async (dir) => {
      const evil: Artifact = { path: '../../etc/passwd', bytes: 1, sha256: 'a'.repeat(64), kind: 'file' };
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/artifacts/presign')) {
          return json({
            uploads: [{ path: evil.path, key: 'k', url: 'https://s3.test/put', headers: {} }],
          });
        }
        return new Response(null, { status: 200 });
      }) as typeof fetch;

      const result = await uploadArtifacts([evil], { runnerId: 'r', runId: 'run_1', destDir: dir }, {
        ...options,
        fetchImpl,
      });

      expect(result.uploadErrors[0]).toMatch(/escapes/);
    });
  });
});

describe('artifact upload helpers', () => {
  test('content types per kind', () => {
    expect(contentTypeForArtifactKind('patch')).toBe('text/x-diff; charset=utf-8');
    expect(contentTypeForArtifactKind('log')).toBe('text/plain; charset=utf-8');
    expect(contentTypeForArtifactKind('screenshot')).toBe('image/png');
    expect(contentTypeForArtifactKind('file')).toBe('application/octet-stream');
  });

  test('safeArtifactFilePath keeps paths inside the directory', () => {
    expect(safeArtifactFilePath('/tmp/run', 'artifacts/a.log')).toBe('/tmp/run/artifacts/a.log');
    expect(safeArtifactFilePath('/tmp/run', '../secret')).toBeNull();
    expect(safeArtifactFilePath('/tmp/run', '/etc/passwd')).toBeNull();
  });
});
