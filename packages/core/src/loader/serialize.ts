import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { normalizeBody } from './frontmatter';
import { walk } from './walk';
import type { FactoryDefinition } from './load';

export interface SerializedFile {
  /** POSIX path relative to the definition root. */
  path: string;
  content: string;
}

/**
 * Deterministic YAML: sorted keys at every level, 2-space indent, no line folding,
 * exactly one trailing newline.
 */
export function canonicalYaml(doc: unknown): string {
  const text = stringifyYaml(doc, {
    sortMapEntries: true,
    indent: 2,
    lineWidth: 0,
    aliasDuplicateObjects: false,
  });
  return text.endsWith('\n') ? text : `${text}\n`;
}

export function canonicalMarkdown(frontmatter: unknown, body: string): string {
  const yaml = canonicalYaml(frontmatter);
  const prose = normalizeBody(body);
  return prose.length > 0 ? `---\n${yaml}---\n\n${prose}` : `---\n${yaml}---\n`;
}

/** The canonical file tree for a definition. Paths are sorted for stable snapshots. */
export function serializeDefinition(definition: FactoryDefinition): SerializedFile[] {
  const files: SerializedFile[] = [
    { path: 'factory.yaml', content: canonicalYaml(definition.manifest) },
  ];

  for (const resource of definition.resources) {
    const content =
      resource.format === 'markdown'
        ? canonicalMarkdown(resource.doc, resource.body)
        : canonicalYaml(resource.doc);
    files.push({ path: resource.path, content });
  }

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function writeFiles(root: string, files: SerializedFile[]): void {
  for (const file of files) {
    const absolute = join(root, file.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content);
  }
}

export interface CanonicalCheck {
  missing: string[];
  changed: string[];
  extra: string[];
}

export function checkFiles(root: string, files: SerializedFile[]): CanonicalCheck {
  const expected = new Map(files.map((file) => [file.path, file.content]));
  const missing: string[] = [];
  const changed: string[] = [];

  for (const [path, content] of expected) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) {
      missing.push(path);
    } else if (readFileSync(absolute, 'utf8') !== content) {
      changed.push(path);
    }
  }

  const extra = existsSync(root)
    ? walk(root).filter((path) => path !== 'factory.yaml' && !expected.has(path))
    : [];

  return { missing, changed, extra };
}

export function isCanonical(check: CanonicalCheck): boolean {
  return check.missing.length === 0 && check.changed.length === 0 && check.extra.length === 0;
}
