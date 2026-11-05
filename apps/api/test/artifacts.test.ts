import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app';
import { loadApiConfig } from '../src/config';
import {
  contentDispositionForArtifact,
  contentTypeForArtifactPath,
  planArtifactDownload,
  resolveLocalArtifactPath,
} from '../src/artifacts';
import { req } from './helpers';

/**
 * Artifact route guards and download planning.
 *
 * The presign route authenticates the host before touching the body, so a missing bearer
 * token is refused without a database. Download planning is pure: it is where traversal
 * protection and the object-storage/local-fallback choice live.
 */

const repoRoot = resolve('.');
const config = loadApiConfig({
  ...process.env,
  FACTORY_ROOT: join(repoRoot, 'factories'),
  REPO_ROOT: repoRoot,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://factory:factory@localhost:5433/factory',
  AUTH_REQUIRED: '0',
  // Explicitly disabled: the route must answer 401 for an unauthenticated agent before any
  // store lookup, and the default must stay metadata-only.
  ARTIFACT_STORE: 'none',
});

const app = createApp(config);

describe('runner-agent presign authorization', () => {
  test('a missing bearer token is agent_unauthorized', async () => {
    const response = await req(app, '/runner-agent/artifacts/presign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runnerId: 'r', runId: 'run_1', artifacts: [] }),
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe('agent_unauthorized');
  });

  test('a malformed authorization header is agent_unauthorized', async () => {
    for (const authorization of ['Basic abc', 'Bearer', 'token abc']) {
      const response = await req(app, '/runner-agent/artifacts/presign', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify({ runnerId: 'r', runId: 'run_1', artifacts: [] }),
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { code: string }).code).toBe('agent_unauthorized');
    }
  });
});

describe('download path resolution', () => {
  const runsDir = '/var/factory/runs';

  test('a normal artifact path resolves inside the run directory', () => {
    expect(resolveLocalArtifactPath(runsDir, 'run_1', 'artifacts/build.log')).toBe(
      resolve('/var/factory/runs/run_1/artifacts/build.log'),
    );
    expect(resolveLocalArtifactPath(runsDir, 'run_1', 'patch.diff')).toBe(
      resolve('/var/factory/runs/run_1/patch.diff'),
    );
  });

  test('traversal and absolute paths are refused', () => {
    expect(resolveLocalArtifactPath(runsDir, 'run_1', '../run_2/patch.diff')).toBeNull();
    expect(resolveLocalArtifactPath(runsDir, 'run_1', '../../etc/passwd')).toBeNull();
    expect(resolveLocalArtifactPath(runsDir, 'run_1', '/etc/passwd')).toBeNull();
    expect(resolveLocalArtifactPath(runsDir, 'run_1', '')).toBeNull();
  });

  test('a storage-backed artifact redirects to a presigned GET', () => {
    const plan = planArtifactDownload({
      artifact: {
        path: 'artifacts/build.log',
        bytes: 10,
        sha256: 'a'.repeat(64),
        kind: 'log',
        storageKey: 'tenants/default/runs/run_1/artifacts/build.log',
        bucket: 'factory-artifacts',
        contentType: 'text/plain; charset=utf-8',
      },
      runsDir,
      runId: 'run_1',
      presignGet: (key) => `https://s3.test/${key}?sig=1`,
    });
    expect(plan).toEqual({
      kind: 'redirect',
      url: 'https://s3.test/tenants/default/runs/run_1/artifacts/build.log?sig=1',
    });
  });

  test('a storage-backed artifact without a configured store has no plan', () => {
    const plan = planArtifactDownload({
      artifact: {
        path: 'patch.diff',
        bytes: 1,
        sha256: 'a'.repeat(64),
        kind: 'patch',
        storageKey: 'tenants/default/runs/run_1/patch.diff',
      },
      runsDir,
      runId: 'run_1',
    });
    expect(plan).toBeNull();
  });

  test('a local artifact keeps the recorded content type or infers it', () => {
    expect(
      planArtifactDownload({
        artifact: {
          path: 'patch.diff',
          bytes: 1,
          sha256: 'a'.repeat(64),
          kind: 'patch',
          contentType: 'text/x-diff; charset=utf-8',
        },
        runsDir,
        runId: 'run_1',
      }),
    ).toEqual({
      kind: 'file',
      path: resolve('/var/factory/runs/run_1/patch.diff'),
      contentType: 'text/x-diff; charset=utf-8',
    });

    expect(
      planArtifactDownload({
        artifact: { path: 'artifacts/usage.json', bytes: 1, sha256: 'a'.repeat(64), kind: 'log' },
        runsDir,
        runId: 'run_1',
      }),
    ).toMatchObject({ kind: 'file', contentType: 'application/json' });
  });
});

describe('download response metadata', () => {
  test('content types by extension', () => {
    expect(contentTypeForArtifactPath('patch.diff')).toBe('text/x-diff; charset=utf-8');
    expect(contentTypeForArtifactPath('artifacts/build.log')).toBe('text/plain; charset=utf-8');
    expect(contentTypeForArtifactPath('shot.png')).toBe('image/png');
    expect(contentTypeForArtifactPath('blob.unknown')).toBe('application/octet-stream');
  });

  test('content-disposition sanitizes quotes and newlines', () => {
    expect(contentDispositionForArtifact('artifacts/build.log')).toBe(
      'attachment; filename="build.log"',
    );
    expect(contentDispositionForArtifact('evil"\r\nname.log')).toBe(
      'attachment; filename="evil___name.log"',
    );
  });
});
