import { describe, expect, test } from 'bun:test';
import { applyPatch, PatchError } from '../src/activities/patch';

/**
 * `applyPatch` is what turns the implement stage's `patch.diff` into the files the forge
 * commits. A PR must contain code, never the diff text itself, so these tests pin the
 * added/modified/deleted mapping and the stable failure codes.
 */

const ADD_FILE = [
  'diff --git a/site/app/page.tsx b/site/app/page.tsx',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/site/app/page.tsx',
  '@@ -0,0 +1,3 @@',
  '+export default function Page() {',
  '+  return <h1>Hello, world!</h1>;',
  '+}',
  '',
].join('\n');

const MODIFY_FILE = [
  'diff --git a/README.md b/README.md',
  'index 1111111..2222222 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1,2 @@',
  ' # Factory',
  '+More docs.',
  '',
].join('\n');

const DELETE_FILE = [
  'diff --git a/docs/old.md b/docs/old.md',
  'deleted file mode 100644',
  '--- a/docs/old.md',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-old',
  '',
].join('\n');

describe('applyPatch', () => {
  test('adds new files with their content', async () => {
    const changes = await applyPatch({ 'README.md': '# Factory\n' }, ADD_FILE);
    expect(changes).toEqual([
      {
        path: 'site/app/page.tsx',
        content: 'export default function Page() {\n  return <h1>Hello, world!</h1>;\n}\n',
      },
    ]);
  });

  test('modifies existing files and keeps their new content', async () => {
    const changes = await applyPatch({ 'README.md': '# Factory\n' }, MODIFY_FILE);
    expect(changes).toEqual([{ path: 'README.md', content: '# Factory\nMore docs.\n' }]);
  });

  test('deletes files with content:null', async () => {
    const changes = await applyPatch(
      { 'README.md': '# Factory\n', 'docs/old.md': 'old\n' },
      DELETE_FILE,
    );
    expect(changes).toEqual([{ path: 'docs/old.md', content: null }]);
  });

  test('omits files the patch leaves untouched', async () => {
    const changes = await applyPatch(
      { 'README.md': '# Factory\n', 'keep.txt': 'keep\n' },
      ADD_FILE,
    );
    expect(changes.map((change) => change.path)).toEqual(['site/app/page.tsx']);
  });

  test('treats a patch that is already applied as a no-op', async () => {
    const changes = await applyPatch(
      {
        'README.md': '# Factory\n',
        'site/app/page.tsx':
          'export default function Page() {\n  return <h1>Hello, world!</h1>;\n}\n',
      },
      ADD_FILE,
    );
    expect(changes).toEqual([]);
  });

  test('rejects an empty patch', async () => {
    await expect(applyPatch({}, '')).rejects.toMatchObject({ code: 'patch_empty' });
    await expect(applyPatch({}, '  \n\n')).rejects.toBeInstanceOf(PatchError);
  });

  test('rejects a malformed patch that does not apply', async () => {
    const malformed = [
      'diff --git a/missing.txt b/missing.txt',
      '--- a/missing.txt',
      '+++ b/missing.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    await expect(applyPatch({ 'README.md': '# Factory\n' }, malformed)).rejects.toMatchObject({
      code: 'patch_apply_failed',
    });
  });

  test('rejects binary patches', async () => {
    const binary = [
      'diff --git a/logo.png b/logo.png',
      'new file mode 100644',
      'GIT binary patch',
      'literal 3',
      'KcmZ?',
      '',
    ].join('\n');
    await expect(applyPatch({}, binary)).rejects.toMatchObject({
      code: 'patch_binary_unsupported',
    });
  });
});
