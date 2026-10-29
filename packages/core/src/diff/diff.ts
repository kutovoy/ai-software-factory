import type { FactoryDefinition, Resource } from '../loader/load';

export interface ResourceRef {
  kind: string;
  name: string;
}

export interface FieldChange {
  /** JSON pointer inside the resource document. */
  pointer: string;
  old: unknown;
  new: unknown;
}

export interface ChangedResource extends ResourceRef {
  changes: FieldChange[];
}

export interface DefinitionDiff {
  added: ResourceRef[];
  removed: ResourceRef[];
  changed: ChangedResource[];
  isEmpty: boolean;
}

interface Comparable {
  kind: string;
  name: string;
  doc: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function walkDiff(a: unknown, b: unknown, pointer: string, out: FieldChange[]): void {
  if (deepEqual(a, b)) return;

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      walkDiff(a[key], b[key], `${pointer}/${escapeToken(key)}`, out);
    }
    return;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      walkDiff(a[index], b[index], `${pointer}/${index}`, out);
    }
    return;
  }

  out.push({ pointer, old: a, new: b });
}

function comparable(definition: FactoryDefinition): Comparable[] {
  const resources: Comparable[] = definition.resources.map((resource: Resource) => ({
    kind: resource.kind,
    name: resource.name,
    doc:
      resource.format === 'markdown'
        ? { ...(resource.doc as Record<string, unknown>), body: resource.body }
        : resource.doc,
  }));

  return [
    { kind: 'factory', name: definition.manifest.name, doc: definition.manifest },
    ...resources,
  ].sort((left, right) => {
    const a = `${left.kind}:${left.name}`;
    const b = `${right.kind}:${right.name}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Semantic diff: added/removed resources plus field-level changes with JSON pointers. */
export function diffDefinitions(a: FactoryDefinition, b: FactoryDefinition): DefinitionDiff {
  const before = new Map(comparable(a).map((entry) => [`${entry.kind}:${entry.name}`, entry]));
  const after = new Map(comparable(b).map((entry) => [`${entry.kind}:${entry.name}`, entry]));

  const added: ResourceRef[] = [];
  const removed: ResourceRef[] = [];
  const changed: ChangedResource[] = [];

  for (const [key, entry] of after) {
    if (!before.has(key)) added.push({ kind: entry.kind, name: entry.name });
  }

  for (const [key, entry] of before) {
    const counterpart = after.get(key);
    if (!counterpart) {
      removed.push({ kind: entry.kind, name: entry.name });
      continue;
    }
    const changes: FieldChange[] = [];
    walkDiff(entry.doc, counterpart.doc, '', changes);
    if (changes.length > 0) {
      changed.push({ kind: entry.kind, name: entry.name, changes });
    }
  }

  const sortRefs = (refs: ResourceRef[]): ResourceRef[] =>
    refs.sort((left, right) => {
      const x = `${left.kind}:${left.name}`;
      const y = `${right.kind}:${right.name}`;
      return x < y ? -1 : x > y ? 1 : 0;
    });

  sortRefs(added);
  sortRefs(removed);
  changed.sort((left, right) => {
    const x = `${left.kind}:${left.name}`;
    const y = `${right.kind}:${right.name}`;
    return x < y ? -1 : x > y ? 1 : 0;
  });

  return {
    added,
    removed,
    changed,
    isEmpty: added.length === 0 && removed.length === 0 && changed.length === 0,
  };
}

function renderValue(value: unknown): string {
  return value === undefined ? '(none)' : JSON.stringify(value);
}

/** Human renderer: one line per added/removed resource or changed field. */
export function renderDiffText(diff: DefinitionDiff): string {
  const lines: string[] = [];

  for (const resource of diff.added) lines.push(`+ ${resource.kind}:${resource.name}`);
  for (const resource of diff.removed) lines.push(`- ${resource.kind}:${resource.name}`);
  for (const resource of diff.changed) {
    for (const change of resource.changes) {
      lines.push(
        `~ ${resource.kind}:${resource.name} ${change.pointer}: ${renderValue(change.old)} -> ${renderValue(change.new)}`,
      );
    }
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
