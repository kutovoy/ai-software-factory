import { describe, expect, test } from 'bun:test';
import { runGuardHooks } from '../src/guard';

function check(report: ReturnType<typeof runGuardHooks>, id: string) {
  const found = report.checks.find((candidate) => candidate.id === id);
  expect(found, `guard check ${id} is missing`).toBeDefined();
  return found!;
}

describe('guard hooks', () => {
  test('passes a contained, secret-free patch on a feature branch', () => {
    const report = runGuardHooks({
      branch: 'feature/add-export',
      files: { 'src/export.ts': 'export const ok = true;\n' },
    });

    expect(report.passed).toBe(true);
    expect(report.changedFiles).toBe(1);
    expect(report.patchBytes).toBe(Buffer.byteLength('export const ok = true;\n'));
    expect(report.checks.map((item) => item.id)).toEqual([
      'protected-branch',
      'path-containment',
      'secret-scan',
      'changed-files',
      'patch-bytes',
      'binary-files',
    ]);
    expect(report.checks.every((item) => item.status === 'pass')).toBe(true);
  });

  test('fails on protected branches, including refs/heads form', () => {
    for (const branch of ['main', 'master', 'refs/heads/main']) {
      const report = runGuardHooks({ branch, files: { 'src/a.ts': 'ok' } });
      expect(report.passed).toBe(false);
      expect(check(report, 'protected-branch').status).toBe('fail');
    }
  });

  test('honours a custom protected branch list', () => {
    const report = runGuardHooks({
      branch: 'release',
      files: { 'src/a.ts': 'ok' },
      config: { protectedBranches: ['release'] },
    });
    expect(report.passed).toBe(false);
    expect(check(report, 'protected-branch').detail).toContain('release');
  });

  test('fails absolute paths, parent traversal and .git paths', () => {
    const report = runGuardHooks({
      branch: 'feature/x',
      files: {
        '/etc/passwd': 'x',
        'src/../../secrets.txt': 'x',
        '.git/config': 'x',
        'src/ok.ts': 'x',
      },
    });

    expect(report.passed).toBe(false);
    const detail = check(report, 'path-containment').detail;
    expect(detail).toContain('/etc/passwd');
    expect(detail).toContain('..');
    expect(detail).toContain('.git/config');
  });

  test('reports secret pattern names and files without the value', () => {
    const token = `ghp_${'A'.repeat(36)}`;
    const report = runGuardHooks({
      branch: 'feature/x',
      files: { 'src/config.ts': `const token = '${token}';` },
    });

    expect(report.passed).toBe(false);
    const secret = check(report, 'secret-scan');
    expect(secret.status).toBe('fail');
    expect(secret.detail).toContain('github-classic-token');
    expect(secret.detail).toContain('src/config.ts');
    expect(secret.detail).not.toContain(token);
  });

  test('detects each narrow secret pattern', () => {
    const samples: Record<string, string> = {
      'github-fine-grained-token': `github_pat_${'B'.repeat(24)}`,
      'openai-api-key': `sk-${'C'.repeat(24)}`,
      'aws-access-key-id': 'AKIAABCDEFGHIJKLMNOP',
      'private-key': '-----BEGIN RSA PRIVATE KEY-----',
      'slack-token': `xoxb-${'1'.repeat(12)}`,
      'google-api-key': `AIza${'D'.repeat(35)}`,
    };

    for (const [name, value] of Object.entries(samples)) {
      const report = runGuardHooks({
        branch: 'feature/x',
        files: { 'src/leak.txt': value },
      });
      expect(report.passed).toBe(false);
      expect(check(report, 'secret-scan').detail).toContain(name);
    }
  });

  test('enforces changed-file, patch-byte and binary-file limits', () => {
    const tooManyFiles = runGuardHooks({
      branch: 'feature/x',
      files: { 'a.ts': 'a', 'b.ts': 'b' },
      config: { maxChangedFiles: 1 },
    });
    expect(tooManyFiles.passed).toBe(false);
    expect(check(tooManyFiles, 'changed-files').status).toBe('fail');

    const tooManyBytes = runGuardHooks({
      branch: 'feature/x',
      files: { 'a.ts': '0123456789' },
      config: { maxPatchBytes: 5 },
    });
    expect(tooManyBytes.passed).toBe(false);
    expect(check(tooManyBytes, 'patch-bytes').status).toBe('fail');

    const tooManyBinaries = runGuardHooks({
      branch: 'feature/x',
      files: { 'a.bin': '\u0000\u0001', 'b.bin': '\u0000\u0002' },
      config: { binaryFileLimit: 1 },
    });
    expect(tooManyBinaries.passed).toBe(false);
    expect(check(tooManyBinaries, 'binary-files').status).toBe('fail');
  });

  test('disabled config skips every check and passes', () => {
    const report = runGuardHooks({
      branch: 'main',
      files: { '/etc/passwd': `ghp_${'A'.repeat(36)}` },
      config: { enabled: false },
    });

    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(6);
    expect(report.checks.every((item) => item.status === 'skipped')).toBe(true);
  });

  test('secret scan can be skipped independently', () => {
    const report = runGuardHooks({
      branch: 'feature/x',
      files: { 'src/leak.txt': `ghp_${'A'.repeat(36)}` },
      config: { secretScan: false },
    });

    expect(report.passed).toBe(true);
    expect(check(report, 'secret-scan').status).toBe('skipped');
  });
});
