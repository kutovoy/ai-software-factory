import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FactoryDefinition, Resource } from '../loader/load';
import type { AgentDef } from '../schema/agent';
import type { FactoryManifest } from '../schema/factory';
import type {
  ReadinessCheck,
  ReadinessReport,
  ReadinessSection,
  ReadinessStatus,
  ReadinessThresholds,
} from './types';

/**
 * Deterministic readiness scan (roadmap item 2): repository hygiene plus factory-loop
 * hygiene. No model calls, no shell commands; filesystem reads and the loaded definition
 * only.
 */

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface ScanReadinessInput {
  repoRoot: string;
  definition: FactoryDefinition;
  thresholds?: Partial<ReadinessThresholds>;
}

const DEFAULT_THRESHOLDS: ReadinessThresholds = { ready: 80, warn: 60 };

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function readPackageJson(root: string): PackageJson | null {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

function exists(root: string, relPath: string): boolean {
  return existsSync(join(root, relPath));
}

function firstExisting(root: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (exists(root, candidate)) return candidate;
  }
  return null;
}

function listDir(root: string, relPath: string): string[] {
  const path = join(root, relPath);
  if (!existsSync(path)) return [];
  try {
    if (!statSync(path).isDirectory()) return [];
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

function check(
  id: string,
  label: string,
  section: 'repository' | 'factory',
  passed: boolean,
  weight: number,
  evidence: string,
  remediation: string,
): ReadinessCheck {
  return { id, label, section, passed, weight, evidence, remediation };
}

function hasDep(pkg: PackageJson | null, names: string[]): string | null {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  for (const name of names) {
    if (deps[name]) return name;
  }
  return null;
}

function script(pkg: PackageJson | null, name: string): string | null {
  const value = pkg?.scripts?.[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function repositoryChecks(root: string, pkg: PackageJson | null): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];

  const lintScript = script(pkg, 'lint');
  const lintConfig = firstExisting(root, [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    '.eslintrc',
    '.eslintrc.json',
    '.eslintrc.js',
    'biome.json',
    'biome.jsonc',
    '.prettierrc',
    '.prettierrc.json',
  ]);
  const lintDep = hasDep(pkg, ['eslint', 'prettier', '@biomejs/biome']);
  checks.push(
    check(
      'style',
      'Style and lint',
      'repository',
      Boolean(lintScript || lintConfig || lintDep),
      1,
      lintScript
        ? `package.json scripts.lint = "${lintScript}"`
        : lintConfig
          ? `lint config found: ${lintConfig}`
          : lintDep
            ? `lint dependency found: ${lintDep}`
            : 'not found: no lint script, lint config or ESLint/Prettier/Biome dependency',
      'Add a lint script (for example "lint": "eslint .") and a lint config.',
    ),
  );

  const buildScript = script(pkg, 'build');
  const buildConfig = firstExisting(root, [
    'vite.config.ts',
    'vite.config.js',
    'next.config.js',
    'next.config.mjs',
    'next.config.ts',
    'webpack.config.js',
    'rollup.config.js',
  ]);
  checks.push(
    check(
      'build',
      'Build',
      'repository',
      Boolean(buildScript || buildConfig),
      1,
      buildScript
        ? `package.json scripts.build = "${buildScript}"`
        : buildConfig
          ? `build config found: ${buildConfig}`
          : 'not found: no build script or bundler config',
      'Add a build script that produces the deployable artifact.',
    ),
  );

  const testScript = script(pkg, 'test');
  const testRunner = hasDep(pkg, ['vitest', 'jest', 'mocha', '@playwright/test']);
  const testDir = firstExisting(root, ['test', 'tests', 'src']);
  const hasTestFiles =
    testDir !== null &&
    listDir(root, testDir).some((entry) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry));
  checks.push(
    check(
      'tests',
      'Automated tests',
      'repository',
      Boolean(testScript || testRunner || hasTestFiles),
      2,
      testScript
        ? `package.json scripts.test = "${testScript}"`
        : testRunner
          ? `test runner dependency found: ${testRunner}`
          : hasTestFiles
            ? `test files found in ${testDir}`
            : 'not found: no test script, test runner or test files',
      'Add a test script and at least one automated test.',
    ),
  );

  const typecheckScript = script(pkg, 'typecheck');
  const hasTsconfig = exists(root, 'tsconfig.json');
  const hasTypescript = Boolean(hasDep(pkg, ['typescript']));
  checks.push(
    check(
      'typecheck',
      'Typecheck',
      'repository',
      Boolean(typecheckScript || (hasTsconfig && hasTypescript)),
      1,
      typecheckScript
        ? `package.json scripts.typecheck = "${typecheckScript}"`
        : hasTsconfig && hasTypescript
          ? 'tsconfig.json and the typescript dependency are present'
          : 'not found: no typecheck script and no tsconfig.json + typescript pair',
      'Add a typecheck script (for example "typecheck": "tsc --noEmit").',
    ),
  );

  const readme = firstExisting(root, ['README.md', 'README.rst', 'README']);
  const docsDir = firstExisting(root, ['docs']);
  checks.push(
    check(
      'docs',
      'Documentation',
      'repository',
      Boolean(readme || docsDir),
      1,
      readme ? `documentation found: ${readme}` : docsDir ? `documentation found: ${docsDir}/` : 'not found: no README or docs directory',
      'Add a README describing how to run, test and deploy the project.',
    ),
  );

  const devEnv = firstExisting(root, [
    '.env.example',
    '.env.sample',
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yaml',
    'compose.yml',
    '.devcontainer/devcontainer.json',
    '.nvmrc',
    '.tool-versions',
  ]);
  checks.push(
    check(
      'dev-env',
      'Dev environment',
      'repository',
      devEnv !== null,
      1,
      devEnv ? `dev environment found: ${devEnv}` : 'not found: no .env.example, compose file, devcontainer or toolchain pin',
      'Add a reproducible dev environment (.env.example, compose file or devcontainer).',
    ),
  );

  const observabilityDep = hasDep(pkg, [
    '@opentelemetry/api',
    '@opentelemetry/sdk-node',
    '@sentry/node',
    'prom-client',
    'pino',
    'winston',
  ]);
  const observabilityFile = firstExisting(root, [
    'src/telemetry.ts',
    'src/observability.ts',
    'src/otel.ts',
    'observability.ts',
    'telemetry.ts',
    'otel.ts',
  ]);
  checks.push(
    check(
      'observability',
      'Observability',
      'repository',
      Boolean(observabilityDep || observabilityFile),
      1,
      observabilityDep
        ? `observability dependency found: ${observabilityDep}`
        : observabilityFile
          ? `observability module found: ${observabilityFile}`
          : 'not found: no telemetry/logging/metrics dependency or module',
      'Add structured logging, metrics or tracing so agent runs are observable.',
    ),
  );

  const securityFile = firstExisting(root, [
    'SECURITY.md',
    '.github/dependabot.yml',
    '.github/dependabot.yaml',
    '.gitleaks.toml',
    '.snyk',
    '.github/workflows/codeql.yml',
  ]);
  const auditScript = script(pkg, 'audit');
  const securityDep = hasDep(pkg, ['helmet', 'express-rate-limit', 'dompurify']);
  checks.push(
    check(
      'security',
      'Security',
      'repository',
      Boolean(securityFile || auditScript || securityDep),
      1,
      securityFile
        ? `security configuration found: ${securityFile}`
        : auditScript
          ? `package.json scripts.audit = "${auditScript}"`
          : securityDep
            ? `security dependency found: ${securityDep}`
            : 'not found: no security policy, dependency-update config, audit script or hardening dependency',
      'Add a security policy and automated dependency updates (for example SECURITY.md and Dependabot).',
    ),
  );

  const taskFile = firstExisting(root, ['TODO.md', 'BACKLOG.md', 'docs/tasks.md', 'docs/backlog.md']);
  const issueTemplates = exists(root, '.github/ISSUE_TEMPLATE') ? '.github/ISSUE_TEMPLATE' : null;
  const backlogDir = firstExisting(root, ['backlog', 'tasks']);
  checks.push(
    check(
      'task-discovery',
      'Task discovery',
      'repository',
      Boolean(taskFile || issueTemplates || backlogDir),
      1,
      taskFile
        ? `task list found: ${taskFile}`
        : issueTemplates
          ? `issue templates found: ${issueTemplates}`
          : backlogDir
            ? `task directory found: ${backlogDir}/`
            : 'not found: no task list, issue template or backlog directory',
      'Add a task list, issue templates or a backlog directory so work intake is discoverable.',
    ),
  );

  return checks;
}

function agentDoc(resource: Resource): AgentDef {
  return resource.doc as AgentDef;
}

function agentName(resource: Resource): string {
  return resource.name;
}

function hasQaAgent(resources: Resource[]): string | null {
  for (const resource of resources) {
    if (resource.kind !== 'agent') continue;
    const name = agentName(resource).toLowerCase();
    const role = String(agentDoc(resource).role ?? '').toLowerCase();
    const description = String(agentDoc(resource).description ?? '').toLowerCase();
    if (name.includes('qa') || role.includes('qa') || description.includes('quality')) {
      return agentName(resource);
    }
  }
  return null;
}

function factoryChecks(definition: FactoryDefinition): ReadinessCheck[] {
  const manifest: FactoryManifest = definition.manifest;
  const resources = definition.resources;
  const agents = resources.filter((resource) => resource.kind === 'agent');
  const agentNames = agents.map(agentName).sort();
  const checks: ReadinessCheck[] = [];

  const qaAgent = hasQaAgent(resources);
  checks.push(
    check(
      'qa-agent',
      'QA agent',
      'factory',
      qaAgent !== null,
      2,
      qaAgent
        ? `QA agent found: ${qaAgent}`
        : `not found: none of the agents (${agentNames.join(', ') || 'none'}) has "qa" in its name or role`,
      'Add a QA/verify agent whose name or role identifies it as QA.',
    ),
  );

  const reviewStage = manifest.stages?.find((stage) => stage.name === 'review');
  const reviewers = reviewStage?.reviewers ?? 0;
  checks.push(
    check(
      'reviewers',
      'Independent reviewers',
      'factory',
      reviewers >= 2,
      2,
      reviewStage
        ? reviewers >= 2
          ? `review stage declares ${reviewers} reviewers`
          : `not found: review stage declares ${reviewers} reviewer(s); at least 2 are required`
        : 'not found: no stage named "review" with reviewers',
      'Declare a review stage with at least two independent reviewers.',
    ),
  );

  const declaredGates = Object.entries(manifest.gates).filter(([, value]) => value !== undefined);
  checks.push(
    check(
      'gates',
      'Stage gates',
      'factory',
      declaredGates.length > 0,
      1,
      declaredGates.length > 0
        ? `gates: ${declaredGates.map(([stage, value]) => `${stage}=${String(value)}`).join(', ')}`
        : 'not found: no stage gates declared on the factory',
      'Declare at least one stage gate (human, agent or policy).',
    ),
  );

  checks.push(
    check(
      'merge-policy',
      'Merge policy',
      'factory',
      manifest.mergePolicy !== 'disabled',
      1,
      manifest.mergePolicy !== 'disabled'
        ? `mergePolicy = ${manifest.mergePolicy}`
        : 'not found: mergePolicy is disabled; agents cannot land changes',
      'Enable a merge policy (human, auto_on_green or auto_after_n_approvals).',
    ),
  );

  checks.push(
    check(
      'agent-verdict',
      'Required agent verdict',
      'factory',
      manifest.agentVerdict === 'required',
      1,
      manifest.agentVerdict === 'required'
        ? 'agentVerdict = required'
        : `not found: agentVerdict = ${manifest.agentVerdict}; missing verdicts do not request changes`,
      'Set agentVerdict: required so an agent gate cannot pass without a verdict.',
    ),
  );

  const scorers = resources.filter((resource) => resource.kind === 'scorer').map(agentName).sort();
  checks.push(
    check(
      'scorers',
      'Scorers',
      'factory',
      scorers.length > 0,
      1,
      scorers.length > 0
        ? `scorers found: ${scorers.join(', ')}`
        : 'not found: no scorer resources in the definition',
      'Add at least one scorer so runs can be evaluated.',
    ),
  );

  const benchmarks = resources
    .filter((resource) => resource.kind === 'benchmark')
    .map(agentName)
    .sort();
  checks.push(
    check(
      'benchmarks',
      'Benchmarks',
      'factory',
      benchmarks.length > 0,
      1,
      benchmarks.length > 0
        ? `benchmarks found: ${benchmarks.join(', ')}`
        : 'not found: no benchmark suites in the definition',
      'Add a benchmark suite so changes can be compared before they land.',
    ),
  );

  const agentSecrets = agents
    .map((resource) => ({ name: agentName(resource), secrets: agentDoc(resource).secrets ?? [] }))
    .filter((entry) => entry.secrets.length > 0);
  checks.push(
    check(
      'secrets',
      'Secret references',
      'factory',
      manifest.secrets.length > 0 || agentSecrets.length > 0,
      1,
      manifest.secrets.length > 0
        ? `factory secrets: ${manifest.secrets.join(', ')}`
        : agentSecrets.length > 0
          ? `agent secrets: ${agentSecrets.map((entry) => `${entry.name}(${entry.secrets.join(', ')})`).join(', ')}`
          : 'not found: no factory or agent secret references',
      'Reference the secrets the agents need by name (values stay out of definitions).',
    ),
  );

  const mcp = manifest.mcp ?? manifest.mcpServers;
  checks.push(
    check(
      'mcp',
      'MCP servers',
      'factory',
      Boolean(mcp),
      1,
      mcp
        ? 'MCP configuration found on the factory'
        : 'not found: no mcp or mcpServers block',
      'Declare MCP servers (or explicitly none) so tool access is auditable.',
    ),
  );

  return checks;
}

function weightedScore(checks: ReadinessCheck[]): number {
  const total = checks.reduce((sum, item) => sum + item.weight, 0);
  if (total === 0) return 0;
  const passed = checks
    .filter((item) => item.passed)
    .reduce((sum, item) => sum + item.weight, 0);
  return round((passed / total) * 100);
}

function statusFor(score: number, thresholds: ReadinessThresholds): ReadinessStatus {
  if (score >= thresholds.ready) return 'ready';
  if (score >= thresholds.warn) return 'warn';
  return 'not_ready';
}

function section(
  id: 'repository' | 'factory',
  label: string,
  checks: ReadinessCheck[],
): ReadinessSection {
  return { id, label, score: weightedScore(checks), checks };
}

export function scanReadiness(input: ScanReadinessInput): ReadinessReport {
  const thresholds: ReadinessThresholds = {
    ready: input.thresholds?.ready ?? DEFAULT_THRESHOLDS.ready,
    warn: input.thresholds?.warn ?? DEFAULT_THRESHOLDS.warn,
  };

  const pkg = readPackageJson(input.repoRoot);
  const repoChecks = repositoryChecks(input.repoRoot, pkg);
  const factory = factoryChecks(input.definition);
  const checks = [...repoChecks, ...factory];
  const score = weightedScore(checks);
  const status = statusFor(score, thresholds);
  const passed = checks.filter((item) => item.passed).length;

  const sections: ReadinessSection[] = [
    section('repository', 'Repository', repoChecks),
    section('factory', 'Factory', factory),
  ];

  return {
    root: input.repoRoot,
    generatedAt: new Date().toISOString(),
    score,
    status,
    thresholds,
    sections,
    checks,
    summary: `${score}/100 — ${passed}/${checks.length} checks passed; status ${status}.`,
  };
}
