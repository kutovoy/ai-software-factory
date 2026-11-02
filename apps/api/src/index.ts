import { createApp } from './app';
import { ensureBootstrapAdmin } from './auth';
import { loadApiConfig } from './config';
import { log } from './logger';

/**
 * Bun + Hono server. Tool execution never happens here: the API validates definitions,
 * starts Temporal workflows, projects the event log over SSE, and hosts the inference
 * proxy (ADR-009/ADR-011).
 *
 * The bootstrap admin is ensured *before* `Bun.serve`: the first request may be a login,
 * so the users table must already hold the admin account (change `add-console-auth`).
 */
const config = loadApiConfig();

try {
  const bootstrap = await ensureBootstrapAdmin(config);
  log('info', 'auth_bootstrap_checked', {
    created: bootstrap.created,
    authRequired: config.authRequired,
  });
} catch (error) {
  // An unreachable database fails `/health` anyway; refusing to start would only hide the
  // reason. Login stays unavailable until the database is reachable.
  log('error', 'auth_bootstrap_failed', {
    message: error instanceof Error ? error.message : String(error),
  });
}

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
  authRequired: config.authRequired,
});

const shutdown = (signal: string): void => {
  log('info', 'api_shutdown', { signal });
  server.stop();
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
