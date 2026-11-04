import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ValidationCheck,
  ValidationConfig,
  ValidationContract,
  ValidationTier,
} from './types';

/**
 * Deterministic validation-contract builder (roadmap item 1). It reads only `package.json`
 * and a few well-known config files from the target repository — no model, no shell.
 */

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(repoRoot: string): PackageJson | null {
  const path = join(repoRoot, 'package.json');
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

function packageManager(repoRoot: string): 'bun' | 'pnpm' | 'yarn' | 'npm' {
  if (existsSync(join(repoRoot, 'bun.lockb')) || existsSync(join(repoRoot, 'bun.lock'))) return 'bun';
  if (existsSync(join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function hasPlaywright(repoRoot: string, pkg: PackageJson | null): boolean {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (deps['@playwright/test'] || deps.playwright) return true;
  return [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.cjs',
    'playwright.config.mts',
  ].some((file) => existsSync(join(repoRoot, file)));
}

const SCRIPT_CHECKS: {
  id: string;
  title: string;
  tier: ValidationTier;
  scripts: string[];
}[] = [
  { id: 'typecheck', title: 'Typecheck', tier: 'unit', scripts: ['typecheck'] },
  { id: 'lint', title: 'Lint', tier: 'unit', scripts: ['lint'] },
  { id: 'test', title: 'Unit and component tests', tier: 'unit', scripts: ['test'] },
  { id: 'build', title: 'Build', tier: 'integration', scripts: ['build'] },
  { id: 'e2e', title: 'End-to-end tests', tier: 'e2e', scripts: ['e2e', 'test:e2e'] },
];

/** Infers command checks from `package.json` scripts plus Playwright detection. */
export function inferValidationChecks(repoRoot: string): ValidationCheck[] {
  const pkg = readPackageJson(repoRoot);
  const scripts = pkg?.scripts ?? {};
  const pm = packageManager(repoRoot);
  const checks: ValidationCheck[] = [];

  for (const definition of SCRIPT_CHECKS) {
    const script = definition.scripts.find((candidate) => typeof scripts[candidate] === 'string');
    if (!script) continue;
    checks.push({
      id: definition.id,
      title: definition.title,
      tier: definition.tier,
      required: true,
      evidence: 'command',
      command: `${pm} run ${script}`,
      expected: 'exit code 0',
    });
  }

  if (!checks.some((check) => check.id === 'e2e') && hasPlaywright(repoRoot, pkg)) {
    checks.push({
      id: 'e2e',
      title: 'End-to-end tests',
      tier: 'e2e',
      required: true,
      evidence: 'command',
      command: `${pm === 'npm' ? 'npx' : pm} playwright test`,
      expected: 'exit code 0',
    });
  }

  return checks;
}

export interface BuildValidationContractInput {
  workItemId: string;
  factory: string;
  definitionCommit: string;
  createdAt: string;
  title: string;
  repoRoot: string;
  config?: ValidationConfig;
}

function manualAcceptanceCheck(title: string): ValidationCheck {
  return {
    id: 'manual-acceptance',
    title: `Manual acceptance: ${title}`,
    tier: 'manual',
    required: true,
    evidence: 'manual',
    expected: 'a reviewer confirms the acceptance criterion',
  };
}

/**
 * Builds the persisted contract. Explicit factory checks win; otherwise the builder infers
 * command checks and always adds a required manual acceptance check for the item title.
 * `enforce` defaults to false so existing factories keep working until they opt in.
 */
export function buildValidationContract(input: BuildValidationContractInput): ValidationContract {
  const explicit = input.config?.checks ?? [];
  const checks =
    explicit.length > 0
      ? explicit.map((check) => ({ ...check }))
      : [...inferValidationChecks(input.repoRoot), manualAcceptanceCheck(input.title)];

  // Defensive: the builder contract promises at least one check.
  if (checks.length === 0) checks.push(manualAcceptanceCheck(input.title));

  return {
    version: 'v1alpha1',
    workItemId: input.workItemId,
    factory: input.factory,
    definitionCommit: input.definitionCommit,
    createdAt: input.createdAt,
    enforce: input.config?.enforce ?? false,
    checks,
    risks: [],
    source: explicit.length > 0 ? 'factory' : 'inferred',
  };
}
