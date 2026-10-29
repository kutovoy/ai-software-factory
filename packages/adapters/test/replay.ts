import type { OpencodeTransport } from '../src/opencode';
import { AdapterError } from '../src/errors';
import { parseSseString } from '../src/sse';

export const FIXTURE_SESSION = 'ses_fixture0000000000000000000';

export interface ReplayTransportOptions {
  /** Raw SSE document recorded from `opencode serve` (see fixtures/opencode-run.sse). */
  sse: string;
  /** Number of leading requests that fail with `harness_unreachable` (readiness tests). */
  failures?: number;
}

export interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * Replays a recorded opencode SSE transcript through the real adapter code path.
 * `request` answers the handful of REST calls the adapter makes with shapes copied
 * from the server's OpenAPI document.
 */
export class ReplayTransport implements OpencodeTransport {
  readonly calls: RecordedCall[] = [];
  private readonly sse: string;
  private failures: number;

  constructor(options: ReplayTransportOptions) {
    this.sse = options.sse;
    this.failures = options.failures ?? 0;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, body });

    if (this.failures > 0) {
      this.failures -= 1;
      throw new AdapterError('harness_unreachable', 'connection refused (replay)', { path });
    }

    if (path === '/api/info') {
      return { version: '2.0.26-fixture', pid: 1, urls: [], paths: { tmp: '/tmp' } } as T;
    }
    if (method === 'POST' && path === '/api/session') {
      return {
        data: {
          id: FIXTURE_SESSION,
          model: { id: 'fake-model', providerID: 'fake' },
          time: { created: 1, updated: 1 },
        },
      } as T;
    }
    if (method === 'POST' && path.endsWith('/prompt')) {
      return {
        data: {
          id: 'msg_fixture_user',
          sessionID: FIXTURE_SESSION,
          type: 'user',
          time: { created: 1 },
          payload: {},
          delivery: 'steer',
        },
      } as T;
    }
    if (method === 'POST' && path.endsWith('/interrupt')) {
      return { interrupted: true } as T;
    }
    if (method === 'POST' && path.endsWith('/reply')) {
      return undefined as T;
    }
    if (method === 'POST' && path.endsWith('/fork')) {
      return { data: { id: `${FIXTURE_SESSION}_fork` } } as T;
    }
    if (method === 'GET' && path === '/api/agent') {
      return {
        location: { directory: '/workspace' },
        data: [
          {
            id: 'build',
            name: 'Build',
            mode: 'primary',
            description: 'Implements changes',
            hidden: false,
            request: {},
            permissions: {},
            model: { id: 'fake-model', providerID: 'fake' },
          },
        ],
      } as T;
    }
    if (method === 'GET' && path.endsWith('/diff')) {
      return {
        data: [
          {
            file: 'README.md',
            patch: '@@ -1 +1 @@\n-# Factory\n+# Factory\n',
            additions: 1,
            deletions: 1,
            status: 'modified',
          },
        ],
      } as T;
    }
    if (method === 'GET' && /^\/api\/session\/[^/]+$/.test(path)) {
      return {
        data: {
          id: FIXTURE_SESSION,
          cost: 0.0021,
          tokens: { input: 1200, output: 80, reasoning: 0, cache: { read: 0, write: 0 } },
          model: { id: 'fake-model', providerID: 'fake' },
          time: { created: 1, updated: 2 },
        },
      } as T;
    }

    throw new AdapterError('harness_error', `replay transport has no response for ${method} ${path}`);
  }

  async *stream(): AsyncIterable<unknown> {
    for (const frame of parseSseString(this.sse)) {
      if (!frame.data) continue;
      yield JSON.parse(frame.data) as unknown;
    }
  }
}

export async function loadFixture(name: string): Promise<string> {
  return Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
}
