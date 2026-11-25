import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_CONTEXT_PACK_CHARS,
  buildContextPack,
  contextKeywords,
  findRelevantFiles,
  selectTestScripts,
} from '../src/context-pack';
import type { MissionPlanData } from '../src/types';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'context-pack-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop() as string;
    await rm(root, { recursive: true, force: true });
  }
});

const DECISIONS = [
  '# Decisions',
  '',
  'Architecture decision records.',
  '',
  '## ADR-001: Billing provider',
  '',
  'Billing invoices are rendered by the invoice service. Never call the provider from the UI.',
  '',
  '## ADR-002: Authentication',
  '',
  'Authentication uses signed session cookies.',
  '',
  '## ADR-003: Invoice export format',
  '',
  'Invoice export writes CSV through the billing exporter, bounded to 10k rows.',
  '',
  '## ADR-004: Theming',
  '',
  'The theme is defined once in the design tokens file.',
  '',
  '## ADR-005: Billing retries',
  '',
  'Billing retries are idempotent and recorded in the invoice ledger.',
].join('\n');

function planWithConstraints(constraints: string[]): MissionPlanData {
  return {
    architecture: {
      summary: 'Layered service',
      components: [],
      dataModels: [],
      constraints,
    },
  } as unknown as MissionPlanData;
}

describe('context pack builder', () => {
  test('selects the most relevant ADRs by keyword overlap', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'DECISIONS.md'), DECISIONS);

    const pack = buildContextPack({
      factoryRoot: root,
      repoRoot: root,
      factory: 'example',
      title: 'Add billing invoice export',
      prompt: 'Export billing invoices as CSV from the invoice service.',
      definitionCommit: 'abc1234',
    });

    expect(pack.ref).toBe('example@abc1234#context-pack');
    expect(pack.markdown).toContain('## Relevant ADRs');
    expect(pack.markdown).toContain('## ADR-001: Billing provider');
    expect(pack.markdown).toContain('## ADR-003: Invoice export format');
    expect(pack.markdown).not.toContain('## ADR-004: Theming');
    expect(pack.sources).toContain('docs/DECISIONS.md#ADR-001: Billing provider');
    // At most three ADRs are included.
    const adrHeadings = pack.markdown.match(/## ADR-/g) ?? [];
    expect(adrHeadings.length).toBeLessThanOrEqual(3);
  });

  test('includes plan architecture constraints and repo test scripts', async () => {
    const root = await makeRoot();
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          typecheck: 'tsc --noEmit',
          lint: 'eslint .',
          test: 'bun test',
          build: 'bun build',
          e2e: 'playwright test',
          'anti-slop': 'bun scripts/anti-slop.ts',
          format: 'prettier --write .',
        },
      }),
    );

    const pack = buildContextPack({
      factoryRoot: root,
      repoRoot: root,
      factory: 'example',
      title: 'Add billing invoice export',
      prompt: 'Export billing invoices.',
      definitionCommit: 'abc1234',
      plan: planWithConstraints(['No upward imports', 'Billing owns the invoice ledger']),
    });

    expect(pack.markdown).toContain('## Architecture constraints');
    expect(pack.markdown).toContain('- No upward imports');
    expect(pack.markdown).toContain('## Test standards');
    expect(pack.markdown).toContain('- typecheck: tsc --noEmit');
    expect(pack.markdown).toContain('- anti-slop: bun scripts/anti-slop.ts');
    expect(pack.markdown).not.toContain('format: prettier');
    expect(pack.sources).toContain('plan.architecture.constraints');
    expect(pack.sources).toContain('package.json#scripts');
  });

  test('lists relevant files from a recursive walk and skips node_modules', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'src', 'billing'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'src', 'billing', 'invoice.ts'), 'export const x = 1;');
    await writeFile(join(root, 'src', 'billing', 'invoice.test.ts'), 'test();');
    await writeFile(join(root, 'src', 'auth.ts'), 'export const y = 2;');
    await writeFile(join(root, 'node_modules', 'pkg', 'invoice.js'), 'noise');

    const keywords = contextKeywords('Add billing invoice export', 'billing invoice');
    const found = findRelevantFiles(root, keywords);
    expect(found.files).toContain('src/billing/invoice.ts');
    expect(found.files).toContain('src/billing/invoice.test.ts');
    expect(found.files.some((file) => file.includes('node_modules'))).toBe(false);

    const pack = buildContextPack({
      factoryRoot: root,
      repoRoot: root,
      factory: 'example',
      title: 'Add billing invoice export',
      prompt: 'billing invoice',
      definitionCommit: 'abc1234',
    });
    expect(pack.markdown).toContain('## Relevant files');
    expect(pack.markdown).toContain('- src/billing/invoice.ts');
  });

  test('missing repo and docs produce honest empty sections without throwing', async () => {
    const root = await makeRoot();
    const missing = join(root, 'does-not-exist');

    const pack = buildContextPack({
      factoryRoot: missing,
      factory: 'example',
      title: 'Add billing invoice export',
      prompt: 'billing invoice',
      definitionCommit: 'abc1234',
    });

    expect(pack.markdown).toContain('## Architecture constraints');
    expect(pack.markdown).toContain('- none recorded in the plan');
    expect(pack.markdown).toContain('## Test standards');
    expect(pack.markdown).toContain('- no package.json scripts found');
    // No repo root: ADR and file sections are omitted, never invented.
    expect(pack.markdown).not.toContain('## Relevant ADRs');
    expect(pack.markdown).not.toContain('## Relevant files');
    expect(pack.sources).toEqual([]);
  });

  test('an empty DECISIONS.md match is reported honestly', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'DECISIONS.md'), DECISIONS);

    const pack = buildContextPack({
      factoryRoot: root,
      repoRoot: root,
      factory: 'example',
      title: 'Tune the build cache',
      prompt: 'Cache the build artifacts between runs.',
      definitionCommit: 'abc1234',
    });
    expect(pack.markdown).toContain('No ADR matched the request keywords.');
  });

  test('prior failures are bounded to three', async () => {
    const root = await makeRoot();
    const pack = buildContextPack({
      factoryRoot: root,
      factory: 'example',
      title: 'Fix the invoice export',
      prompt: 'invoice export fails',
      definitionCommit: 'abc1234',
      priorFailures: ['failure one', 'failure two', 'failure three', 'failure four'],
    });
    expect(pack.markdown).toContain('- failure one');
    expect(pack.markdown).toContain('- failure three');
    expect(pack.markdown).not.toContain('- failure four');
    expect(pack.sources).toContain('prior-failures');
  });

  test('the rendered pack never exceeds the hard character cap', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'docs'), { recursive: true });
    const bigAdr = `## ADR-900: Billing invoice export\n\n${'invoice billing export '.repeat(2000)}`;
    await writeFile(join(root, 'docs', 'DECISIONS.md'), bigAdr);

    const pack = buildContextPack({
      factoryRoot: root,
      repoRoot: root,
      factory: 'example',
      title: 'Add billing invoice export',
      prompt: 'Export billing invoices.',
      definitionCommit: 'abc1234',
      plan: planWithConstraints(
        Array.from({ length: 40 }, (_, index) => `constraint ${index} ${'x'.repeat(200)}`),
      ),
      priorFailures: Array.from({ length: 10 }, (_, index) => `failure ${index} ${'y'.repeat(2000)}`),
    });

    expect(pack.markdown.length).toBeLessThanOrEqual(MAX_CONTEXT_PACK_CHARS);
    expect(pack.markdown.length).toBeGreaterThan(0);
  });

  test('selectTestScripts keeps the fixed order and ignores unrelated scripts', () => {
    expect(
      selectTestScripts({
        format: 'prettier .',
        'anti-slop': 'anti-slop',
        e2e: 'playwright',
        test: 'bun test',
        lint: 'eslint',
        typecheck: 'tsc',
        build: 'tsc -b',
      }),
    ).toEqual([
      ['typecheck', 'tsc'],
      ['lint', 'eslint'],
      ['test', 'bun test'],
      ['build', 'tsc -b'],
      ['e2e', 'playwright'],
      ['anti-slop', 'anti-slop'],
    ]);
  });
});
