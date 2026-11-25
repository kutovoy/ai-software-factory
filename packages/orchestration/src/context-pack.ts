import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { MissionPlanData } from './types';

/**
 * Deterministic context pack (change `add-anti-slop-budgets-and-proof`, task 4.1).
 *
 * A bounded markdown bundle handed to a feature/work-item stage: the most relevant ADRs,
 * the plan's architecture constraints, the repo's test commands, prior failures and the
 * files most likely to matter. No embeddings, no model call, no shell.
 *
 * This module reads the filesystem synchronously, so it is only used from activities /
 * the API — never from a Temporal workflow (which must stay deterministic and Node-free).
 * Every read is best-effort: a missing file, an unreadable directory or a malformed
 * package.json yields an honest empty section instead of an error.
 */

export interface ContextPackInput {
  /** Absolute path of the factory definition directory (fallback for package.json). */
  factoryRoot: string;
  /** Absolute path of the target repository checkout; absent for remote/URL repos. */
  repoRoot?: string;
  /** Internal factory key (`<name>` or `<owner>/<name>`). */
  factory: string;
  /** Work item / mission-feature title used for keyword scoring. */
  title: string;
  /** Seed prompt used for keyword scoring. */
  prompt: string;
  /** Pinned definition commit; part of the stable pack reference. */
  definitionCommit: string;
  /** Persisted mission plan (architecture constraints). */
  plan?: MissionPlanData | null;
  /** Prior failure summaries supplied by the caller (already compacted). */
  priorFailures?: string[];
}

export interface ContextPack {
  markdown: string;
  /** Stable source identifiers (ADR headings, package.json, files) for the UI. */
  sources: string[];
  /** `<factory>@<definitionCommit>#context-pack` — recorded on the review packet. */
  ref: string;
}

/** Hard cap on the rendered pack; prompts must stay cheap. */
export const MAX_CONTEXT_PACK_CHARS = 6000;
const MAX_ADRS = 3;
const MAX_ADR_BODY_CHARS = 1200;
const MAX_CONSTRAINTS = 10;
const MAX_TEST_SCRIPTS = 8;
const MAX_PRIOR_FAILURES = 3;
const MAX_PRIOR_FAILURE_CHARS = 400;
const MAX_FILES = 20;
const MAX_KEYWORDS = 24;
const MAX_WALK_ENTRIES = 4000;
const MAX_WALK_DEPTH = 4;
const MAX_FILENAME_CHARS = 160;

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'vendor',
  'target',
  '__pycache__',
]);

/** Words too generic to identify a relevant ADR or file. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'for', 'from', 'has',
  'have', 'in', 'into', 'is', 'it', 'its', 'must', 'new', 'not', 'of', 'on', 'or', 'our',
  'should', 'than', 'that', 'the', 'then', 'this', 'to', 'use', 'was', 'we', 'when',
  'will', 'with', 'you', 'add', 'all', 'any', 'each', 'make', 'also', 'via',
]);

/** Test/quality scripts surfaced in the pack, in this fixed order. */
const TEST_SCRIPT_NAMES = ['typecheck', 'lint', 'test', 'build', 'e2e', 'anti-slop'];

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

function normalizeSlashes(value: string): string {
  return value.replaceAll('\\', '/');
}

/** Lowercased, deduped keywords from the request text; deterministic order of appearance. */
export function contextKeywords(...parts: string[]): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    for (const raw of part.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3 || STOPWORDS.has(raw) || seen.has(raw)) continue;
      seen.add(raw);
      keywords.push(raw);
      if (keywords.length >= MAX_KEYWORDS) return keywords;
    }
  }
  return keywords;
}

interface AdrEntry {
  heading: string;
  body: string;
  index: number;
}

/** Splits `docs/DECISIONS.md` on `## ADR-` headings; the preamble is dropped. */
export function parseAdrEntries(markdown: string): AdrEntry[] {
  const parts = markdown.split(/^## ADR-/m);
  const entries: AdrEntry[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    const chunk = parts[index] ?? '';
    const lines = chunk.split(/\r?\n/);
    const headingLine = (lines[0] ?? '').trim();
    if (headingLine.length === 0) continue;
    entries.push({
      heading: truncate(`## ADR-${headingLine}`, 300),
      body: truncate(lines.slice(1).join('\n'), MAX_ADR_BODY_CHARS),
      index: entries.length,
    });
  }
  return entries;
}

function keywordScore(text: string, keywords: string[]): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    let from = 0;
    while (true) {
      const found = haystack.indexOf(keyword, from);
      if (found < 0) break;
      score += 1;
      from = found + keyword.length;
    }
  }
  return score;
}

/** Top ADRs by keyword overlap; ties keep document order. Empty when nothing matches. */
export function selectRelevantAdrs(markdown: string, keywords: string[]): AdrEntry[] {
  return parseAdrEntries(markdown)
    .map((entry) => ({ entry, score: keywordScore(`${entry.heading}\n${entry.body}`, keywords) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.index - right.entry.index)
    .slice(0, MAX_ADRS)
    .map((candidate) => candidate.entry);
}

/** `typecheck`/`lint`/`test`/`build`/`e2e`/`anti-slop` (and their `name:*` variants). */
export function selectTestScripts(scripts: Record<string, unknown>): Array<[string, string]> {
  const selected: Array<[string, string]> = [];
  for (const name of TEST_SCRIPT_NAMES) {
    for (const [key, value] of Object.entries(scripts)) {
      if (typeof value !== 'string' || value.trim().length === 0) continue;
      if (key !== name && !key.startsWith(`${name}:`)) continue;
      selected.push([key, truncate(value, 200)]);
      if (selected.length >= MAX_TEST_SCRIPTS) return selected;
    }
  }
  return selected;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readPackageScripts(
  roots: string[],
): { scripts: Record<string, unknown>; source: string | null } {
  for (const root of roots) {
    const text = readText(join(root, 'package.json'));
    if (text === null) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const scripts = (parsed as Record<string, unknown>).scripts;
      if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) continue;
      return { scripts: scripts as Record<string, unknown>, source: 'package.json#scripts' };
    } catch {
      // Malformed package.json: try the next root, then report honestly.
    }
  }
  return { scripts: {}, source: null };
}

/** Files under `root` whose relative path contains a keyword; deterministic walk order. */
export function findRelevantFiles(
  root: string,
  keywords: string[],
): { files: string[]; truncated: boolean } {
  if (keywords.length === 0) return { files: [], truncated: false };
  const matched: Array<{ path: string; score: number }> = [];
  let visited = 0;
  let truncated = false;

  const walk = (directory: string, depth: number): void => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (truncated) return;
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith('.')) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        if (depth + 1 > MAX_WALK_DEPTH) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = normalizeSlashes(relative(root, full));
      const lower = relativePath.toLowerCase();
      let score = 0;
      for (const keyword of keywords) {
        if (lower.includes(keyword)) score += 1;
      }
      if (score > 0) matched.push({ path: relativePath, score });
    }
  };

  try {
    walk(root, 0);
  } catch {
    return { files: [], truncated };
  }

  const files = matched
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, MAX_FILES)
    .map((entry) => truncate(entry.path, MAX_FILENAME_CHARS));
  return { files, truncated: truncated || matched.length > MAX_FILES };
}

/**
 * Builds the deterministic context pack. Missing repo/docs/package files are skipped, never
 * invented; the rendered markdown is truncated to `MAX_CONTEXT_PACK_CHARS`.
 */
export function buildContextPack(input: ContextPackInput): ContextPack {
  const keywords = contextKeywords(input.title, input.prompt);
  const sources: string[] = [];
  const sections: string[] = [];

  sections.push(
    [
      `# Context pack: ${input.factory}`,
      `Title: ${truncate(input.title, 300)}`,
      `Definition commit: ${input.definitionCommit}`,
    ].join('\n'),
  );

  if (input.repoRoot) {
    const decisions = readText(join(input.repoRoot, 'docs', 'DECISIONS.md'));
    if (decisions !== null) {
      const adrs = selectRelevantAdrs(decisions, keywords);
      sections.push(
        [
          '## Relevant ADRs',
          ...(adrs.length > 0
            ? adrs.map((adr) => `${adr.heading}\n\n${adr.body}`)
            : ['No ADR matched the request keywords.']),
        ].join('\n'),
      );
      for (const adr of adrs) {
        sources.push(`docs/DECISIONS.md#${adr.heading.replace(/^##\s*/, '')}`);
      }
    }
  }

  const constraints = (input.plan?.architecture?.constraints ?? []).slice(0, MAX_CONSTRAINTS);
  sections.push(
    [
      '## Architecture constraints',
      ...(constraints.length > 0
        ? constraints.map((constraint) => `- ${truncate(constraint, 400)}`)
        : ['- none recorded in the plan']),
    ].join('\n'),
  );
  if (constraints.length > 0) sources.push('plan.architecture.constraints');

  const roots = [input.repoRoot, input.factoryRoot].filter(
    (root): root is string => typeof root === 'string' && root.length > 0,
  );
  const packageScripts = readPackageScripts(roots);
  const scripts = selectTestScripts(packageScripts.scripts);
  sections.push(
    [
      '## Test standards',
      ...(scripts.length > 0
        ? scripts.map(([name, command]) => `- ${name}: ${command}`)
        : ['- no package.json scripts found']),
    ].join('\n'),
  );
  if (packageScripts.source) sources.push(packageScripts.source);

  const priorFailures = (input.priorFailures ?? [])
    .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    .slice(0, MAX_PRIOR_FAILURES)
    .map((entry) => `- ${truncate(entry, MAX_PRIOR_FAILURE_CHARS)}`);
  if (priorFailures.length > 0) {
    sections.push(['## Prior failures', ...priorFailures].join('\n'));
    sources.push('prior-failures');
  }

  if (input.repoRoot) {
    const walk = findRelevantFiles(input.repoRoot, keywords);
    sections.push(
      [
        '## Relevant files',
        ...(walk.files.length > 0 ? walk.files.map((file) => `- ${file}`) : ['- none matched']),
      ].join('\n'),
    );
    for (const file of walk.files) sources.push(file);
  }

  return {
    markdown: truncate(sections.join('\n\n'), MAX_CONTEXT_PACK_CHARS),
    sources,
    ref: `${input.factory}@${input.definitionCommit}#context-pack`,
  };
}
