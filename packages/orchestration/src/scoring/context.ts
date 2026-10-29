import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getWorkItem, parseStageRunId } from '@factory/core';
import type { RunContext, RunEvidence, ToolCallEvidence } from '@factory/evals';
import { loadConfig } from '../config';
import { getRun, getSql, listEvents } from '../db';
import { artifactsDir, runDir } from '../run-dir';

/**
 * Builds the compact, model-free run context used by deterministic scorers and judge
 * prompts. Evidence references point at run events/artifacts, never at blobs in Postgres.
 */

function parseCommand(args: string | undefined): string | undefined {
  if (!args) return undefined;
  try {
    const parsed = JSON.parse(args) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { command?: unknown }).command === 'string') {
      return (parsed as { command: string }).command;
    }
  } catch {
    // streamed args may be incomplete; no command evidence then
  }
  return undefined;
}

async function readText(path: string, limit = 64 * 1024): Promise<string | null> {
  try {
    const body = await readFile(path, 'utf8');
    return body.length > limit ? body.slice(0, limit) : body;
  } catch {
    return null;
  }
}

function buildEvidence(
  artifacts: { path: string; kind?: string; bytes?: number }[],
  artifactContents: Record<string, string>,
  events: { seq: number; type: string; payload: unknown }[],
): RunEvidence {
  const calls = new Map<string, { name: string; args: string }>();
  const toolCalls: ToolCallEvidence[] = [];

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.type === 'tool.call.started') {
      calls.set(String(payload.callId), {
        name: typeof payload.name === 'string' ? payload.name : 'unknown',
        args: '',
      });
    } else if (event.type === 'tool.call.args.delta') {
      const call = calls.get(String(payload.callId));
      if (call && typeof payload.delta === 'string') call.args += payload.delta;
    } else if (event.type === 'tool.call.completed') {
      const call = calls.get(String(payload.callId));
      toolCalls.push({
        name: call?.name ?? 'unknown',
        ...(parseCommand(call?.args) ? { command: parseCommand(call?.args) as string } : {}),
        ok: payload.ok === true,
        seq: event.seq,
      });
    }
  }

  return { artifacts, artifactContents, toolCalls };
}

export async function buildRunContext(args: {
  runId: string;
  factory: string;
}): Promise<RunContext> {
  const run = await getRun(args.runId);
  if (!run) throw new Error(`run "${args.runId}" does not exist`);

  const config = loadConfig();
  const parsed = parseStageRunId(args.runId);
  const workItemId = parsed?.workItemId ?? null;
  const stage = parsed?.stage ?? null;

  const workItem = workItemId ? await getWorkItem(getSql(), workItemId) : null;
  const input = (run.input ?? {}) as { prompt?: { text?: string } };
  const prompt = typeof input.prompt?.text === 'string' ? input.prompt.text : null;

  const artifacts = ((run.artifacts ?? []) as unknown[])
    .filter((artifact): artifact is { path: string; kind?: string; bytes?: number } =>
      Boolean(artifact && typeof artifact === 'object' && typeof (artifact as { path?: unknown }).path === 'string'),
    )
    .map((artifact) => ({
      path: artifact.path,
      ...(artifact.kind ? { kind: artifact.kind } : {}),
      ...(typeof artifact.bytes === 'number' ? { bytes: artifact.bytes } : {}),
    }));

  const events = await listEvents(args.runId, 0, 10_000);
  const terminalSeq =
    events
      .filter((event) => event.type === 'run.completed')
      .map((event) => Number(event.seq))
      .pop() ?? null;

  const dir = runDir(config.runsDir, args.runId);
  const checks = await readText(join(artifactsDir(config.runsDir, args.runId), 'checks.json'));
  const rootChecks = await readText(join(dir, 'checks.json'));
  const diff = await readText(join(dir, 'patch.diff'), 8_000);

  const artifactContents: Record<string, string> = {};
  if (checks) artifactContents['artifacts/checks.json'] = checks;
  if (rootChecks) artifactContents['checks.json'] = rootChecks;

  return {
    runId: args.runId,
    factory: run.factory,
    workItemId,
    stage,
    title: run.title,
    status: run.status,
    summary: run.summary,
    prompt,
    diff,
    artifacts,
    evidence: buildEvidence(
      artifacts,
      artifactContents,
      events.map((event) => ({
        seq: Number(event.seq),
        type: event.type,
        payload: event.payload,
      })),
    ),
    terminalSeq,
    workItemTitle: workItem?.title ?? null,
  };
}
