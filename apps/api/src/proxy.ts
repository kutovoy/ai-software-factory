import type { Hono } from 'hono';
import {
  getRun,
  lookupProxyToken,
  recordProxyAttempt,
  type ProxyTokenRow,
  type RunRow,
} from '@factory/orchestration';
import type { ApiConfig } from './config';
import { ApiError, modelNotAllowed, unauthorized } from './errors';
import { log } from './logger';

const TERMINAL = new Set(['ok', 'error', 'cancelled']);

/**
 * Inference proxy (ADR-011, task 4.8).
 *
 * OpenAI-compatible passthrough at `/v1/*`:
 *   1. authenticate with the per-run bearer token (`OPENAI_API_KEY` in the sandbox);
 *   2. enforce the run's model allowlist;
 *   3. inject the real provider credential from env — the sandbox never sees it;
 *   4. stream the upstream response back unchanged;
 *   5. record the attempt (model, status, latency, bytes) without prompts or keys;
 *   6. refuse revoked tokens immediately (the worker revokes them at run end).
 */
export function registerProxy(app: Hono, config: ApiConfig): void {
  async function authenticate(authorization: string | undefined): Promise<ProxyTokenRow> {
    const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) throw unauthorized('missing bearer token');
    const row = await lookupProxyToken(token);
    if (!row) throw unauthorized('unknown run token');
    if (row.revoked_at) {
      throw new ApiError('token_revoked', 401, 'this run token has been revoked', {
        runId: row.run_id,
      });
    }
    const run: RunRow | null = await getRun(row.run_id);
    if (!run || TERMINAL.has(run.status)) {
      throw new ApiError('token_revoked', 401, 'the run is no longer active', { runId: row.run_id });
    }
    return row;
  }

  app.get('/v1/models', async (c) => {
    const tokenRow = await authenticate(c.req.header('authorization'));
    return c.json({
      object: 'list',
      data: tokenRow.models.map((model) => ({
        id: model,
        object: 'model',
        owned_by: 'factory-proxy',
      })),
    });
  });

  app.post('/v1/chat/completions', async (c) => {
    const tokenRow = await authenticate(c.req.header('authorization'));
    const started = Date.now();

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      throw new ApiError('invalid_request', 400, 'request body must be JSON');
    }

    const requestedModel =
      typeof body.model === 'string' && body.model !== '' ? body.model : tokenRow.models[0];

    if (!requestedModel || !tokenRow.models.includes(requestedModel)) {
      await recordProxyAttempt({
        runId: tokenRow.run_id,
        tokenId: tokenRow.token_id,
        model: requestedModel ?? null,
        status: 403,
        ok: false,
        latencyMs: Date.now() - started,
        error: 'model_not_allowed',
      });
      throw modelNotAllowed(requestedModel ?? '(none)', tokenRow.models);
    }

    if (!config.providerBaseUrl) {
      await recordProxyAttempt({
        runId: tokenRow.run_id,
        tokenId: tokenRow.token_id,
        model: requestedModel,
        status: 503,
        ok: false,
        latencyMs: Date.now() - started,
        error: 'inference_unavailable',
      });
      throw new ApiError('inference_unavailable', 503, 'no upstream model endpoint is configured');
    }

    const streamed = body.stream === true;
    const upstreamUrl = `${config.providerBaseUrl.replace(/\/+$/, '')}/chat/completions`;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.providerKey) headers.authorization = `Bearer ${config.providerKey}`;

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      await recordProxyAttempt({
        runId: tokenRow.run_id,
        tokenId: tokenRow.token_id,
        model: requestedModel,
        status: 502,
        ok: false,
        latencyMs: Date.now() - started,
        error: 'upstream_unreachable',
        streamed,
      });
      throw new ApiError('inference_unavailable', 502, 'could not reach the upstream model endpoint', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!upstream.ok) {
      // Deliberately not reading/logging the body: it may echo the prompt.
      await upstream.body?.cancel();
      await recordProxyAttempt({
        runId: tokenRow.run_id,
        tokenId: tokenRow.token_id,
        model: requestedModel,
        status: upstream.status,
        ok: false,
        latencyMs: Date.now() - started,
        error: `upstream_status_${upstream.status}`,
        streamed,
      });
      throw new ApiError('inference_error', 502, `upstream returned ${upstream.status}`, {
        status: upstream.status,
      });
    }

    await recordProxyAttempt({
      runId: tokenRow.run_id,
      tokenId: tokenRow.token_id,
      model: requestedModel,
      status: upstream.status,
      ok: true,
      latencyMs: Date.now() - started,
      streamed,
    });

    log('info', 'proxy_attempt', {
      runId: tokenRow.run_id,
      model: requestedModel,
      status: upstream.status,
      streamed,
      latencyMs: Date.now() - started,
    });

    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': contentType,
        'cache-control': 'no-cache',
      },
    });
  });

  /**
   * Dev/smoke fixture: a canned OpenAI-compatible upstream. Enabled with
   * `PROXY_STUB_UPSTREAM=1` so `scripts/smoke.sh` can prove the proxy path with zero
   * network and zero credentials. Never enabled in production.
   */
  if (config.stubUpstream) {
    app.post('/internal/stub-model/v1/chat/completions', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const model = typeof body.model === 'string' ? body.model : 'stub';
      if (body.stream === true) {
        const encoder = new TextEncoder();
        const chunks = ['stub ', 'model ', 'stream'];
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const text of chunks) {
              const payload = {
                id: 'chatcmpl-stub',
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            }
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: 'chatcmpl-stub',
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        });
      }

      return c.json({
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'stub model response' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      });
    });
  }
}
