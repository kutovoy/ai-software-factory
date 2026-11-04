import type { GuardCheck, GuardConfig, GuardReport } from './types';

/**
 * Pure guard hooks: no shell command, network request or filesystem write. Fail-closed:
 * any failing check makes the report fail.
 */

export interface RunGuardHooksInput {
  branch: string;
  /** Path -> UTF-8 content of every file the patch applied. */
  files: Record<string, string>;
  config?: GuardConfig;
}

interface ResolvedGuardConfig {
  enabled: boolean;
  secretScan: boolean;
  protectedBranches: string[];
  maxChangedFiles: number;
  maxPatchBytes: number;
  binaryFileLimit: number;
}

export const DEFAULT_GUARD_CONFIG: ResolvedGuardConfig = {
  enabled: true,
  secretScan: true,
  protectedBranches: ['main', 'master'],
  maxChangedFiles: 200,
  maxPatchBytes: 1_000_000,
  binaryFileLimit: 5,
};

/**
 * Narrow secret patterns: known token prefixes and private-key headers only. The report
 * names the pattern and the file, never the matched value.
 */
const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'github-classic-token', pattern: /ghp_[A-Za-z0-9]{36}/ },
  { name: 'github-fine-grained-token', pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'openai-api-key', pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'aws-access-key-id', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'private-key', pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/ },
  { name: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'google-api-key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
];

const CHECK_IDS = [
  'protected-branch',
  'path-containment',
  'secret-scan',
  'changed-files',
  'patch-bytes',
  'binary-files',
] as const;

function resolveConfig(config: GuardConfig | undefined): ResolvedGuardConfig {
  return {
    enabled: config?.enabled ?? DEFAULT_GUARD_CONFIG.enabled,
    secretScan: config?.secretScan ?? DEFAULT_GUARD_CONFIG.secretScan,
    protectedBranches: config?.protectedBranches ?? DEFAULT_GUARD_CONFIG.protectedBranches,
    maxChangedFiles: config?.maxChangedFiles ?? DEFAULT_GUARD_CONFIG.maxChangedFiles,
    maxPatchBytes: config?.maxPatchBytes ?? DEFAULT_GUARD_CONFIG.maxPatchBytes,
    binaryFileLimit: config?.binaryFileLimit ?? DEFAULT_GUARD_CONFIG.binaryFileLimit,
  };
}

function normalizeBranch(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
}

function isProtected(branch: string, protectedBranches: string[]): boolean {
  const normalized = normalizeBranch(branch);
  return protectedBranches.some(
    (candidate) => normalizeBranch(candidate) === normalized,
  );
}

function pathProblem(rawPath: string): string | null {
  const path = rawPath.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) {
    return 'absolute path';
  }
  const segments = path.split('/');
  if (segments.includes('..')) return '".." segment';
  if (segments.includes('.git')) return '.git/ path';
  return null;
}

function scanSecrets(files: Record<string, string>): string[] {
  const findings: string[] = [];
  for (const path of Object.keys(files).sort()) {
    const content = files[path];
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(content)) findings.push(`${name} in ${path}`);
    }
  }
  return findings;
}

function binaryFileCount(files: Record<string, string>): number {
  return Object.values(files).filter((content) => content.includes('\u0000')).length;
}

export function runGuardHooks(input: RunGuardHooksInput): GuardReport {
  const config = resolveConfig(input.config);
  const paths = Object.keys(input.files);
  const changedFiles = paths.length;
  const patchBytes = Object.values(input.files).reduce(
    (total, content) => total + Buffer.byteLength(content, 'utf8'),
    0,
  );

  if (!config.enabled) {
    return {
      passed: true,
      branch: input.branch,
      changedFiles,
      patchBytes,
      checks: CHECK_IDS.map((id) => ({
        id,
        status: 'skipped',
        detail: 'guard hooks disabled',
      })),
    };
  }

  const checks: GuardCheck[] = [];

  checks.push({
    id: 'protected-branch',
    status: isProtected(input.branch, config.protectedBranches) ? 'fail' : 'pass',
    detail: isProtected(input.branch, config.protectedBranches)
      ? `branch ${input.branch} is protected; agents may not commit to ${config.protectedBranches.join(', ')}`
      : `branch ${input.branch} is not protected`,
  });

  const pathProblems = paths
    .map((path) => ({ path, problem: pathProblem(path) }))
    .filter((entry) => entry.problem !== null);
  checks.push({
    id: 'path-containment',
    status: pathProblems.length > 0 ? 'fail' : 'pass',
    detail:
      pathProblems.length > 0
        ? pathProblems.map((entry) => `${entry.path} (${entry.problem})`).join(', ')
        : `${changedFiles} file path(s) are contained in the repository`,
  });

  if (!config.secretScan) {
    checks.push({ id: 'secret-scan', status: 'skipped', detail: 'secret scan disabled' });
  } else {
    const findings = scanSecrets(input.files);
    checks.push({
      id: 'secret-scan',
      status: findings.length > 0 ? 'fail' : 'pass',
      detail:
        findings.length > 0
          ? `secret pattern(s) found: ${findings.join(', ')}`
          : `no secret patterns found in ${changedFiles} file(s)`,
    });
  }

  checks.push({
    id: 'changed-files',
    status: changedFiles > config.maxChangedFiles ? 'fail' : 'pass',
    detail:
      changedFiles > config.maxChangedFiles
        ? `${changedFiles} changed files exceed the limit of ${config.maxChangedFiles}`
        : `${changedFiles} changed files within the limit of ${config.maxChangedFiles}`,
  });

  checks.push({
    id: 'patch-bytes',
    status: patchBytes > config.maxPatchBytes ? 'fail' : 'pass',
    detail:
      patchBytes > config.maxPatchBytes
        ? `${patchBytes} patch bytes exceed the limit of ${config.maxPatchBytes}`
        : `${patchBytes} patch bytes within the limit of ${config.maxPatchBytes}`,
  });

  const binaryFiles = binaryFileCount(input.files);
  checks.push({
    id: 'binary-files',
    status: binaryFiles > config.binaryFileLimit ? 'fail' : 'pass',
    detail:
      binaryFiles > config.binaryFileLimit
        ? `${binaryFiles} binary files exceed the limit of ${config.binaryFileLimit}`
        : `${binaryFiles} binary files within the limit of ${config.binaryFileLimit}`,
  });

  return {
    passed: checks.every((item) => item.status !== 'fail'),
    branch: input.branch,
    changedFiles,
    patchBytes,
    checks,
  };
}
