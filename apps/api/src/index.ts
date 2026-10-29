import { createApp } from './app';
import { loadApiConfig } from './config';
import { log } from './logger';

/**
 * Bun + Hono server. Tool execution never happens here: the API validates definitions,
 * starts Temporal workflows, projects the event log over SSE, and hosts the inference
 * proxy (ADR-009/ADR-011).
 */
const config = loadApiConfig();
const app = createApp(config);

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: app.fetch,
  idleTimeout: 255,
});

log('info', 'api_started', {
  url: `http://${config.host}:${server.port}`,
  version: config.version,
  temporalAddress: config.temporalAddress,
  factoryRoot: config.factoryRoot,
  runsDir: config.runsDir,
  proxyPublicUrl: config.proxyPublicUrl,
  exposeRunToken: config.exposeRunToken,
  stubUpstream: config.stubUpstream,
});

const shutdown = (signal: string): void => {
  log('info', 'api_shutdown', { signal });
  server.stop();
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
