/**
 * PostgreSQL JSONB rejects `\u0000` ("unsupported Unicode escape sequence"). Harness
 * output is untrusted text and can contain NUL bytes (for example when an agent reads a
 * binary file), so every JSON/text value we persist is sanitised first. The replacement
 * character preserves the fact that a byte was dropped without corrupting the write.
 */

export function sanitizeText(value: string): string {
  return value.replace(/\u0000/g, '\uFFFD');
}

export function sanitizeJsonValue<T>(value: T): T {
  if (typeof value === 'string') return sanitizeText(value) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[sanitizeText(key)] = sanitizeJsonValue(entry);
    }
    return out as T;
  }
  return value;
}
