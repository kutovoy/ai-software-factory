import { describe, expect, test } from 'bun:test';
import { sanitizeJsonValue, sanitizeText } from '../src/json';

describe('PostgreSQL JSONB sanitisation', () => {
  test('replaces NUL bytes in text', () => {
    expect(sanitizeText('before\u0000after')).toBe('before\uFFFDafter');
  });

  test('walks nested event payloads', () => {
    const input = {
      type: 'tool.call.completed',
      result: {
        content: [{ type: 'text', text: 'binary\u0000output' }],
      },
    };
    const output = sanitizeJsonValue(input);
    expect(output.result.content[0]?.text).toBe('binary\uFFFDoutput');
    expect(JSON.stringify(output)).not.toContain('\\u0000');
  });
});
