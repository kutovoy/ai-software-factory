import { describe, expect, test } from 'bun:test';
import { formatHeartbeat, formatSseFrame, parseLastEventId } from '../src/sse';

describe('SSE projection', () => {
  test('id is the event seq, event is the canonical type, data is the payload', () => {
    const frame = formatSseFrame({
      seq: 7,
      type: 'message.delta',
      payload: { type: 'message.delta', seq: 7, at: 1, role: 'assistant', text: 'hi' },
    });
    expect(frame).toBe(
      'id: 7\nevent: message.delta\ndata: {"type":"message.delta","seq":7,"at":1,"role":"assistant","text":"hi"}\n\n',
    );
  });

  test('heartbeat is an SSE comment', () => {
    expect(formatHeartbeat()).toBe(': keep-alive\n\n');
  });

  test('Last-Event-ID parsing is lenient and never negative', () => {
    expect(parseLastEventId('42')).toBe(42);
    expect(parseLastEventId(null)).toBe(0);
    expect(parseLastEventId('')).toBe(0);
    expect(parseLastEventId('-3')).toBe(0);
    expect(parseLastEventId('abc')).toBe(0);
  });
});
