import { loadConfig } from '../config';
import { issueProxyToken as mintToken, revokeProxyTokens } from '../db';
import { upsertStep } from '../db';
import type { ProxyCredentials } from '../types';

/**
 * Inference-proxy token lifecycle (ADR-011).
 *
 * The token is minted by the worker, handed to the runner as `OPENAI_API_KEY`, and only
 * its hash is stored in Postgres. It is revoked as soon as the run reaches a terminal
 * state, so a leaked sandbox env cannot be replayed after the run.
 *
 * Never log the token or the upstream credential.
 */
export async function issueProxyToken(args: {
  runId: string;
  models: string[];
}): Promise<ProxyCredentials | null> {
  if (args.models.length === 0) return null;

  const config = loadConfig();
  const { token, tokenId } = await mintToken({ runId: args.runId, models: args.models });

  await upsertStep({
    runId: args.runId,
    stepId: 'issue-proxy-token',
    kind: 'proxy',
    status: 'ok',
    detail: {
      tokenId,
      models: args.models,
      baseUrl: config.proxyPublicUrl,
      // The token value itself is never persisted or logged.
    },
  });

  return { token, tokenId, baseUrl: config.proxyPublicUrl, models: args.models };
}

export async function revokeProxyToken(args: { runId: string }): Promise<void> {
  await revokeProxyTokens(args.runId);
  await upsertStep({
    runId: args.runId,
    stepId: 'revoke-proxy-token',
    kind: 'proxy',
    status: 'ok',
  });
}
