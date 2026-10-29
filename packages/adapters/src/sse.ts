/**
 * Minimal Server-Sent Events parser.
 *
 * Deliberately dependency-free: `opencode serve` speaks plain SSE over HTTP, and both
 * the live transport and the recorded-fixture transport must go through the same parser
 * so contract tests exercise the real decoding path.
 */

export interface SseFrame {
  id?: string;
  event?: string;
  /** Joined `data:` lines. Comment-only frames (heartbeats) are dropped. */
  data: string;
}

export class SseParser {
  private buffer = '';
  private lastEventId: string | undefined;

  push(chunk: string): SseFrame[] {
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, '\n');
    const frames: SseFrame[] = [];

    let index = this.buffer.indexOf('\n\n');
    while (index >= 0) {
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const frame = this.parseBlock(block);
      if (frame) frames.push(frame);
      index = this.buffer.indexOf('\n\n');
    }

    return frames;
  }

  /** Flushes a trailing frame that was not terminated by a blank line. */
  flush(): SseFrame[] {
    if (this.buffer.trim() === '') {
      this.buffer = '';
      return [];
    }
    const frame = this.parseBlock(this.buffer);
    this.buffer = '';
    return frame ? [frame] : [];
  }

  get lastId(): string | undefined {
    return this.lastEventId;
  }

  private parseBlock(block: string): SseFrame | undefined {
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];

    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      switch (field) {
        case 'id':
          id = value;
          break;
        case 'event':
          event = value;
          break;
        case 'data':
          data.push(value);
          break;
        default:
          // `retry` and unknown fields are irrelevant for our consumers.
          break;
      }
    }

    if (data.length === 0) return undefined;
    if (id !== undefined) this.lastEventId = id;
    return { id, event, data: data.join('\n') };
  }
}

/** Parses a fully-buffered SSE document (used by recorded fixtures). */
export function parseSseString(text: string): SseFrame[] {
  const parser = new SseParser();
  return [...parser.push(text), ...parser.flush()];
}

/**
 * Reads an SSE response body as raw frames. Throws on malformed JSON at the call site,
 * never here: transport concerns and payload concerns stay separate.
 */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, undefined> {
  const parser = new SseParser();
  const reader = body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        yield frame;
      }
    }
    for (const frame of parser.flush()) yield frame;
  } finally {
    reader.releaseLock();
  }
}
