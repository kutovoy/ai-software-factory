/**
 * Strict Markdown frontmatter splitter.
 *
 * Frontmatter must start at byte 0, be delimited by lines that are exactly `---`,
 * and the body after the closing delimiter is preserved verbatim.
 */
export type SplitResult =
  | { ok: true; frontmatter: string; body: string }
  | { ok: false; code: 'missing_frontmatter' | 'unterminated_frontmatter'; message: string };

export function splitFrontmatter(raw: string): SplitResult {
  const lines = raw.split('\n');
  if (lines[0]?.trimEnd() !== '---') {
    return {
      ok: false,
      code: 'missing_frontmatter',
      message: 'document must start with a "---" frontmatter delimiter at byte 0',
    };
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---');
  if (closing === -1) {
    return {
      ok: false,
      code: 'unterminated_frontmatter',
      message: 'frontmatter is not terminated by a "---" line',
    };
  }

  return {
    ok: true,
    frontmatter: lines.slice(1, closing).join('\n'),
    body: lines.slice(closing + 1).join('\n'),
  };
}

/** Trim outer blank lines and guarantee a single trailing newline (or nothing). */
export function normalizeBody(body: string): string {
  const trimmed = body.replace(/^\n+/, '').replace(/\s+$/, '');
  return trimmed.length > 0 ? `${trimmed}\n` : '';
}
