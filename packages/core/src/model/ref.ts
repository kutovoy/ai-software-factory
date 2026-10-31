/**
 * Model references (ADR-028).
 *
 * A model may be a literal string or an environment reference (`env:NAME`). The
 * definition stays portable: which concrete model a provider serves is 12-factor
 * configuration, resolved at load/run time, not a value baked into git.
 */

export const MODEL_ENV_PREFIX = 'env:';

/** POSIX-style environment variable name accepted after `env:`. */
export const MODEL_ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export type ModelSource = 'literal' | 'env';

export interface ResolvedModel {
  /** The declared reference, exactly as written in the definition. */
  ref: string;
  /** The value a run would use; `null` when an `env:` reference is unset. */
  value: string | null;
  source: ModelSource;
}

/** One declared model in a definition document, with its JSON pointer. */
export interface ModelRefSite {
  file: string;
  pointer: string;
  ref: string;
}

export function isEnvModelRef(ref: string): boolean {
  return ref.startsWith(MODEL_ENV_PREFIX);
}

/** The variable name of an `env:` reference, or `null` for a literal. */
export function modelEnvName(ref: string): string | null {
  if (!isEnvModelRef(ref)) return null;
  const name = ref.slice(MODEL_ENV_PREFIX.length);
  return MODEL_ENV_NAME_RE.test(name) ? name : null;
}

/** Resolves a declared model against the environment. Never throws. */
export function resolveModelRef(ref: string, env: NodeJS.ProcessEnv = process.env): ResolvedModel {
  const name = modelEnvName(ref);
  if (name === null) return { ref, value: ref, source: 'literal' };
  const value = env[name];
  return {
    ref,
    value: typeof value === 'string' && value.length > 0 ? value : null,
    source: 'env',
  };
}

/** True when the reference is an `env:` form whose variable is not set. */
export function isUnresolvedModelRef(ref: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = resolveModelRef(ref, env);
  return resolved.source === 'env' && resolved.value === null;
}

function walkModels(
  doc: unknown,
  pointer: string,
  file: string,
  out: ModelRefSite[],
): void {
  if (Array.isArray(doc)) {
    doc.forEach((value, index) => walkModels(value, `${pointer}/${index}`, file, out));
    return;
  }
  if (typeof doc !== 'object' || doc === null) return;
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    const childPointer = `${pointer}/${key}`;
    if (key === 'model' && typeof value === 'string') {
      out.push({ file, pointer: childPointer, ref: value });
      continue;
    }
    walkModels(value, childPointer, file, out);
  }
}

/**
 * Every `model` declaration in a set of definition documents, in document order.
 * Structural rather than schema-driven: any `model` key is a model declaration, so
 * new inference locations are covered without a second list to keep in sync.
 */
export function collectModelRefSites(
  documents: ReadonlyArray<{ file: string; doc: unknown }>,
): ModelRefSite[] {
  const out: ModelRefSite[] = [];
  for (const document of documents) {
    walkModels(document.doc, '', document.file, out);
  }
  return out;
}
