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
export * from './run-dir';
export * from './db';
export * from './sessions';
