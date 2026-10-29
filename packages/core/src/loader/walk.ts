import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type ResourceKind =
  | 'factory'
  | 'agent'
  | 'agent-skill'
  | 'automation'
  | 'scorer'
  | 'skill'
  | 'runner'
  | 'routing'
  | 'packs'
  | 'benchmark'
  | 'benchmark-task';

export interface ClassifiedFile {
  kind: ResourceKind;
  name: string;
  format: 'yaml' | 'markdown';
}

/** Shown in `unknown_file` errors so agents know where a resource may live. */
export const ALLOWED_LOCATIONS = [
  'factory.yaml',
  'agents/<name>/agent.md (or agents/<name>.md)',
  'agents/<name>/skills/<skill>/SKILL.md',
  'automations/<name>/automation.md (or automations/<name>.md)',
  'scorers/<name>/scorer.md (or scorers/<name>.md)',
  'skills/<skill>/SKILL.md (or skills/<skill>.md)',
  'benchmarks/<suite>/suite.yaml',
  'benchmarks/<suite>/tasks/<task>.yaml',
  'runners/<name>.yaml',
  'routing.yaml',
  'packs.lock',
].join(', ');

const IGNORED_DIRS = new Set(['node_modules', 'dist']);

function stripExt(file: string, ext: string): string {
  return file.endsWith(ext) ? file.slice(0, -ext.length) : '';
}

/** Classify a POSIX relative path into a resource, or `null` when it is unknown. */
export function classify(relPath: string): ClassifiedFile | null {
  const parts = relPath.split('/');

  if (relPath === 'factory.yaml') return { kind: 'factory', name: 'factory', format: 'yaml' };
  if (relPath === 'routing.yaml') return { kind: 'routing', name: 'routing', format: 'yaml' };
  if (relPath === 'packs.lock') return { kind: 'packs', name: 'packs', format: 'yaml' };

  const [head] = parts;

  if (head === 'agents') {
    if (parts.length === 2 && parts[1].endsWith('.md')) {
      const name = stripExt(parts[1], '.md');
      return name ? { kind: 'agent', name, format: 'markdown' } : null;
    }
    if (parts.length === 3 && parts[2] === 'agent.md' && parts[1]) {
      return { kind: 'agent', name: parts[1], format: 'markdown' };
    }
    if (parts.length === 5 && parts[2] === 'skills' && parts[4] === 'SKILL.md' && parts[1] && parts[3]) {
      return { kind: 'agent-skill', name: `${parts[1]}/${parts[3]}`, format: 'markdown' };
    }
    return null;
  }

  if (head === 'automations') {
    if (parts.length === 2 && parts[1].endsWith('.md')) {
      const name = stripExt(parts[1], '.md');
      return name ? { kind: 'automation', name, format: 'markdown' } : null;
    }
    if (parts.length === 3 && parts[2] === 'automation.md' && parts[1]) {
      return { kind: 'automation', name: parts[1], format: 'markdown' };
    }
    return null;
  }

  if (head === 'scorers') {
    if (parts.length === 2 && parts[1].endsWith('.md')) {
      const name = stripExt(parts[1], '.md');
      return name ? { kind: 'scorer', name, format: 'markdown' } : null;
    }
    if (parts.length === 3 && parts[2] === 'scorer.md' && parts[1]) {
      return { kind: 'scorer', name: parts[1], format: 'markdown' };
    }
    return null;
  }

  if (head === 'skills') {
    if (parts.length === 2 && parts[1].endsWith('.md')) {
      const name = stripExt(parts[1], '.md');
      return name ? { kind: 'skill', name, format: 'markdown' } : null;
    }
    if (parts.length === 3 && parts[2] === 'SKILL.md' && parts[1]) {
      return { kind: 'skill', name: parts[1], format: 'markdown' };
    }
    return null;
  }

  if (head === 'runners') {
    if (parts.length === 2 && parts[1].endsWith('.yaml')) {
      const name = stripExt(parts[1], '.yaml');
      return name ? { kind: 'runner', name, format: 'yaml' } : null;
    }
    return null;
  }

  if (head === 'benchmarks') {
    if (parts.length === 3 && parts[2] === 'suite.yaml' && parts[1]) {
      return { kind: 'benchmark', name: parts[1], format: 'yaml' };
    }
    if (parts.length === 4 && parts[2] === 'tasks' && parts[3].endsWith('.yaml') && parts[1]) {
      const name = stripExt(parts[3], '.yaml');
      return name ? { kind: 'benchmark-task', name: `${parts[1]}/${name}`, format: 'yaml' } : null;
    }
    return null;
  }

  return null;
}

/** Every file under `root` as a sorted POSIX relative path; dot-dirs are skipped. */
export function walk(root: string): string[] {
  const files: string[] = [];

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) visit(absolute);
      } else if (entry.isFile()) {
        files.push(relative(root, absolute).split(sep).join('/'));
      }
    }
  };

  visit(root);
  return files.sort();
}
