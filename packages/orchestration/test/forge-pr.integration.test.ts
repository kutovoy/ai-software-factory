import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeForge } from '@factory/forge';
import { forgeOpenPullRequest, setForge } from '../src/activities/forge';
import { ensureRunDir, patchPath } from '../src/run-dir';

/**
 * `forgeOpenPullRequest` must commit the code the implement stage produced, not the diff
 * text. This suite drives the activity directly against a seeded `FakeForge`: no Temporal,
 * no Postgres, no credentials. It pins the regression where every PR carried only
 * `changes/<workItemId>.patch` and QA never saw the actual change on the PR branch.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const FACTORY_ROOT = join(REPO_ROOT, 'factories', 'example');
const REPO = { owner: 'acme', name: 'api-service' };

const PATCH = [
  'diff --git a/README.md b/README.md',
  'index 1111111..2222222 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1,2 @@',
  ' # api-service',
  '+Managed by the factory.',
  'diff --git a/site/app/page.tsx b/site/app/page.tsx',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/site/app/page.tsx',
  '@@ -0,0 +1,3 @@',
  '+export default function Page() {',
  '+  return <h1>Hello, world!</h1>;',
  '+}',
  'diff --git a/docs/old.md b/docs/old.md',
  'deleted file mode 100644',
  '--- a/docs/old.md',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-old',
  '',
].join('\n');

let runsDir: string;
let forge: FakeForge;
let previousRunsDir: string | undefined;
let previousCodeForge: string | undefined;

async function writeRunPatch(runId: string, patch: string): Promise<void> {
  await ensureRunDir(runsDir, runId);
  await writeFile(patchPath(runsDir, runId), patch, 'utf8');
}

function open(workItemId: string, runId: string) {
  return forgeOpenPullRequest({
    workItemId,
    factory: 'example',
    factoryRoot: FACTORY_ROOT,
    title: 'Add the landing page',
    body: `Work item ${workItemId}`,
    runId,
  });
}

describe('forgeOpenPullRequest commits the applied change', () => {
  beforeAll(async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'factory-forge-pr-'));
    previousRunsDir = process.env.RUNS_DIR;
    previousCodeForge = process.env.CODE_FORGE;
    process.env.RUNS_DIR = runsDir;
    // The test hook (`setForge`) only applies when CODE_FORGE is unset.
    delete process.env.CODE_FORGE;
  });

  afterAll(async () => {
    if (previousRunsDir === undefined) delete process.env.RUNS_DIR;
    else process.env.RUNS_DIR = previousRunsDir;
    if (previousCodeForge === undefined) delete process.env.CODE_FORGE;
    else process.env.CODE_FORGE = previousCodeForge;
    await rm(runsDir, { recursive: true, force: true });
  });

  afterEach(() => {
    setForge('fake', null);
  });

  function seededForge(): FakeForge {
    const backend = new FakeForge();
    backend.seedRepo(REPO, { 'README.md': '# api-service\n', 'docs/old.md': 'old\n' });
    setForge('fake', backend);
    return backend;
  }

  test('branch and PR carry the real files instead of changes/*.patch', async () => {
    forge = seededForge();
    await writeRunPatch('run_implement_1', PATCH);

    const opened = await open('wi_test_1', 'run_implement_1');
    expect(opened.branch).toBe('factory/wi_test_1');
    expect(opened.prUrl).toContain('/pull/');

    const branch = await forge.checkout({ repo: REPO, ref: opened.branch });
    expect(branch.files['site/app/page.tsx']).toBe(
      'export default function Page() {\n  return <h1>Hello, world!</h1>;\n}\n',
    );
    expect(branch.files['README.md']).toBe('# api-service\nManaged by the factory.\n');
    expect(branch.files['docs/old.md']).toBeUndefined();
    expect(Object.keys(branch.files).some((path) => path.startsWith('changes/'))).toBe(false);

    const pull = forge.listPullRequests(REPO).find((candidate) => candidate.workItemId === 'wi_test_1');
    expect(pull?.head).toBe(opened.branch);
    expect(pull?.state).toBe('open');
  });

  test('a missing patch fails with patch_missing instead of committing a placeholder', async () => {
    forge = seededForge();
    await expect(open('wi_test_2', 'run_implement_2')).rejects.toMatchObject({
      type: 'patch_missing',
    });
  });

  test('an empty patch fails with patch_missing', async () => {
    forge = seededForge();
    await writeRunPatch('run_implement_3', '');
    await expect(open('wi_test_3', 'run_implement_3')).rejects.toMatchObject({
      type: 'patch_missing',
    });
  });

  test('a patch that does not apply fails with patch_apply_failed', async () => {
    forge = seededForge();
    await writeRunPatch(
      'run_implement_4',
      [
        'diff --git a/missing.txt b/missing.txt',
        '--- a/missing.txt',
        '+++ b/missing.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n'),
    );
    await expect(open('wi_test_4', 'run_implement_4')).rejects.toMatchObject({
      type: 'patch_apply_failed',
    });
  });
});
