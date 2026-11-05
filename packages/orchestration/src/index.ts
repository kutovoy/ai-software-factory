/**
 * `@factory/orchestration` — Temporal workflows, activities and client.
 *
 * Deliberately NOT exported here: the worker entrypoint (`./worker`), which pulls in the
 * Temporal worker runtime. The API imports this module; the worker is started as a
 * separate process (compose `worker` service).
 */
export * from './config';
export * from './types';
export * from './client';
export * from './factory-client';
export * from './scoring-client';
export * from './benchmark-client';
export * from './improvement-client';
export * from './improvement-apply';
export * from './canary-client';
export * from './canary-apply';
export * from './canary-metrics';
export * from './merge-client';
export * from './mcp-client';
export * from './mcp-probe';
export * from './automation-client';
export { getForge, resolveForge, setForge } from './activities/forge';
export * from './run-dir';
export * from './failures';
export * from './db';
export * from './runner-reaper';
export * from './runner-hosts';
export * from './runner-alerts';
export * from './runner-observability';
export * from './remote-runner';
export * from './sessions';
export * from './scoring/context';
export * from './models/judgement';
export * from './models/review';
export * from './activities/benchmark';
export * from './activities/improvement';
export * from './activities/canary';
export * from './activities/merge';
export * from './activities/automation';
export * from './activities/mcp';
export * from './activities/runner';
