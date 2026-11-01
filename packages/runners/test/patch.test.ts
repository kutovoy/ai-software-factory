import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitDiff, prepareWorkspace, runCommand, writePatch } from '../src';

/**
 * Stage hand-off regression tests.
 *
 * A stage agent creates brand-new files (a fresh `site/` directory), so the captured patch
 * must include untracked files — `git diff` alone returns nothing for them. Downstream
 * stages must then run on that patch, or verify/review inspect a clean tree.
 */

const dirs: string[] = [];

async function tempDir(prefix = 'factory-patch-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function seededRepo(): Promise<string> {
  const repo = await tempDir('factory-patch-repo-');
  await runCommand(['git', 'init', '-q', repo]);
  await runCommand(['git', '-C', repo, 'config', 'user.email', 'agent@factory.local']);
  await runCommand(['git', '-C', repo, 'config', 'user.name', 'factory-agent']);
  await writeFile(join(repo, 'README.md'), '# base\n', 'utf8');
  await runCommand(['git', '-C', repo, 'add', '-A']);
  await runCommand(['git', '-C', repo, 'commit', '-qm', 'initial']);
  return repo;
}

describe('patch capture', () => {
  test('gitDiff includes files the agent never tracked', async () => {
    const repo = await seededRepo();
    await mkdir(join(repo, 'site', 'app'), { recursive: true });
    await writeFile(join(repo, 'site', 'app', 'page.tsx'), '<h1>Hello, world!</h1>\n', 'utf8');

    const diff = await gitDiff(repo);
    expect(diff).toBeDefined();
    expect(diff).toContain('site/app/page.tsx');
    expect(diff).toContain('Hello, world!');
  });

  test('gitDiff includes changes the agent already staged', async () => {
    const repo = await seededRepo();
    await writeFile(join(repo, 'README.md'), '# changed\n', 'utf8');
    await runCommand(['git', '-C', repo, 'add', 'README.md']);

    const diff = await gitDiff(repo);
    expect(diff).toContain('+# changed');
  });

  test('writePatch writes the untracked-file diff into the run directory', async () => {
    const repo = await seededRepo();
    await mkdir(join(repo, 'site'), { recursive: true });
    await writeFile(join(repo, 'site', 'package.json'), '{}\n', 'utf8');
    const dest = await tempDir('factory-patch-dest-');

    expect(await writePatch(repo, dest)).toBe(true);
    expect(await readFile(join(dest, 'patch.diff'), 'utf8')).toContain('site/package.json');
  });

  test('gitDiff still captures work the agent committed', async () => {
    const repo = await seededRepo();
    const workspace = await tempDir();
    await prepareWorkspace({ path: repo }, workspace);

    await mkdir(join(workspace, 'site'), { recursive: true });
    await writeFile(join(workspace, 'site', 'page.tsx'), '<h1>Hello</h1>\n', 'utf8');
    await runCommand(['git', '-C', workspace, 'add', '-A']);
    await runCommand(['git', '-C', workspace, 'commit', '-qm', 'agent commit']);

    const diff = await gitDiff(workspace);
    expect(diff).toContain('site/page.tsx');
  });
});

describe('stage hand-off', () => {
  test('prepareWorkspace applies the upstream patch to a fresh checkout', async () => {
    const repo = await seededRepo();

    // Simulate the implement stage: create a new file and capture its patch.
    const implementWorkspace = await tempDir();
    await prepareWorkspace({ path: repo }, implementWorkspace);
    await mkdir(join(implementWorkspace, 'site'), { recursive: true });
    await writeFile(join(implementWorkspace, 'site', 'page.tsx'), '<h1>Hello</h1>\n', 'utf8');
    const patchDir = await tempDir();
    expect(await writePatch(implementWorkspace, patchDir)).toBe(true);

    // Simulate the verify stage: a fresh checkout at the same commit plus the patch.
    const verifyWorkspace = await tempDir();
    await prepareWorkspace(
      { path: repo, patch: join(patchDir, 'patch.diff') },
      verifyWorkspace,
    );

    expect(await readFile(join(verifyWorkspace, 'site', 'page.tsx'), 'utf8')).toContain('Hello');
  });

  test('prepareWorkspace fails loudly when the patch does not apply', async () => {
    const repo = await seededRepo();
    const bogus = join(await tempDir(), 'bogus.patch');
    await writeFile(
      bogus,
      [
        'diff --git a/missing.txt b/missing.txt',
        '--- a/missing.txt',
        '+++ b/missing.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(
      prepareWorkspace({ path: repo, patch: bogus }, await tempDir()),
    ).rejects.toThrow(/cannot apply the stage patch/);
  });
});
