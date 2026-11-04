/**
 * Opaque keyset cursors for list projections. A cursor is `(sort timestamp, id)`, encoded
 * so clients cannot construct one that skips or repeats rows. Keyset pagination stays
 * stable under inserts, unlike `OFFSET` (performance plan, `docs/PERFORMANCE.md`).
 */

export interface PageCursor {
  at: string;
  id: string;
}

export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}\u0000${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(value: string | undefined | null): PageCursor | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const separator = decoded.indexOf('\u0000');
    if (separator <= 0) return null;
    const at = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (!at || !id || Number.isNaN(Date.parse(at))) return null;
    return { at, id };
  } catch {
    return null;
  }
}
