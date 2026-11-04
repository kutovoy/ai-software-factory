import { createHash } from 'node:crypto';
import type { RunEvidence, ScorerLabel, ScorerRegistryEntry, TraceMetrics } from './types';

/**
 * LLM-judge scoring.
 *
 * A judge is one structured completion against a versioned rubric. The prompt is built
 * deterministically from the rubric body + label set + a compact run context, and its
 * sha256 is stored with every score (`promptHash`). The judge returns a strict label; an
 * unknown label is `judge_invalid`, never silently mapped to a nearby one.
 *
 * `JudgeClient` is the model boundary:
 *  - `stub` is deterministic and credential-free (CI, tests, smoke);
 *  - `openai` talks to any OpenAI-compatible `/chat/completions` endpoint.
 */

export interface RunContext {
  runId: string;
  factory: string;
  workItemId: string | null;
  stage: string | null;
  title: string | null;
  status: string;
  summary: string | null;
  prompt: string | null;
  diff: string | null;
  artifacts: { path: string; kind?: string; bytes?: number }[];
  evidence: RunEvidence;
  /** Deterministic trace metrics (roadmap item 6); also shown on the run detail page. */
  trace: TraceMetrics;
  terminalSeq: number | null;
  workItemTitle: string | null;
}

export interface JudgeRequest {
  model: string;
  system: string;
  user: string;
  labels: ScorerLabel[];
}

export interface JudgeResponse {
  text: string;
  model: string;
  modelVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface JudgeClient {
  readonly id: string;
  complete(request: JudgeRequest): Promise<JudgeResponse>;
}

export type JudgeErrorCode = 'judge_invalid' | 'judge_unavailable' | 'judge_error';

export class JudgeError extends Error {
  readonly code: JudgeErrorCode;

  constructor(code: JudgeErrorCode, message: string) {
    super(message);
    this.name = 'JudgeError';
    this.code = code;
  }
}

export interface JudgePrompt {
  system: string;
  user: string;
  promptHash: string;
}

const MAX_DIFF_CHARS = 4_000;
const MAX_PROMPT_CHARS = 2_000;

function truncate(value: string | null, limit: number): string {
  if (!value) return '(none)';
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export function buildJudgePrompt(scorer: ScorerRegistryEntry, context: RunContext): JudgePrompt {
  const labelLines = scorer.labels
    .map((label) => `- ${label.value} (score ${label.score})${label.description ? `: ${label.description}` : ''}`)
    .join('\n');
  const checkLines = scorer.checks.length > 0 ? scorer.checks.join(', ') : '(none)';
  const artifactLines =
    context.artifacts.length > 0
      ? context.artifacts.map((artifact) => `${artifact.path}${artifact.kind ? ` (${artifact.kind})` : ''}`).join('\n')
      : '(none)';
  const toolLines =
    context.evidence.toolCalls.length > 0
      ? context.evidence.toolCalls
          .map((call) => `- ${call.name}${call.command ? `: ${call.command}` : ''} → ${call.ok ? 'ok' : 'failed'} (seq ${call.seq})`)
          .join('\n')
      : '(none)';

  const system = [
    'You are a strict evaluator for a software factory.',
    'Grade the run against the rubric. Return ONLY a JSON object:',
    '{"label": "<one of the declared labels>", "rationale": "<one or two sentences>"}',
    'Do not invent labels. Do not add fields. Be conservative.',
  ].join(' ');

  const user = [
    `Scorer: ${scorer.name}`,
    scorer.description ? `Question: ${scorer.description}` : null,
    `Rubric hash: ${scorer.rubricHash}`,
    `Passing score: ${scorer.passingScore}`,
    '',
    'Rubric:',
    scorer.body.trim(),
    '',
    'Labels:',
    labelLines,
    '',
    `Deterministic checks declared: ${checkLines}`,
    '',
    'Run context:',
    `Factory: ${context.factory}`,
    `Run: ${context.runId}`,
    `Status: ${context.status}`,
    `Stage: ${context.stage ?? '(none)'}`,
    `Work item: ${context.workItemId ?? '(none)'}`,
    `Work item title: ${context.workItemTitle ?? context.title ?? '(none)'}`,
    `Summary: ${context.summary ?? '(none)'}`,
    '',
    'Prompt:',
    truncate(context.prompt, MAX_PROMPT_CHARS),
    '',
    'Artifacts:',
    artifactLines,
    '',
    'Tool calls:',
    toolLines,
    '',
    'Diff (truncated):',
    truncate(context.diff, MAX_DIFF_CHARS),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return {
    system,
    user,
    promptHash: createHash('sha256').update(`${system}\n${user}`).digest('hex'),
  };
}

export interface ParsedJudgeOutput {
  label: string;
  score: number;
  passing: boolean;
  rationale: string;
}

function labelValues(scorer: ScorerRegistryEntry): string[] {
  return scorer.labels.map((label) => label.value);
}

/** Strict label parsing: JSON, exact label, or exactly one label token. */
export function parseJudgeOutput(text: string, scorer: ScorerRegistryEntry): ParsedJudgeOutput {
  const trimmed = text.trim();
  let label: string | null = null;
  let rationale = '';

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { label?: unknown }).label === 'string') {
      label = (parsed as { label: string }).label.trim();
      const rawRationale = (parsed as { rationale?: unknown }).rationale;
      if (typeof rawRationale === 'string') rationale = rawRationale.trim();
    }
  } catch {
    // fall through to token parsing
  }

  if (label === null && labelValues(scorer).includes(trimmed)) {
    label = trimmed;
  }

  if (label === null) {
    const matches = labelValues(scorer).filter((value) =>
      new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(trimmed),
    );
    if (matches.length === 1) label = matches[0] as string;
    else if (matches.length > 1) {
      throw new JudgeError(
        'judge_invalid',
        `judge output names multiple labels: ${matches.join(', ')}`,
      );
    }
  }

  if (label === null) {
    throw new JudgeError(
      'judge_invalid',
      `judge output does not contain one of the declared labels: ${labelValues(scorer).join(', ')}`,
    );
  }

  const definition = scorer.labels.find((candidate) => candidate.value === label);
  if (!definition) {
    throw new JudgeError(
      'judge_invalid',
      `judge output label "${label}" is not declared by scorer "${scorer.name}"`,
    );
  }

  return {
    label: definition.value,
    score: definition.score,
    passing: definition.score >= scorer.passingScore,
    rationale: rationale || `judge selected "${definition.value}"`,
  };
}

function highestLabelFrom(labels: ScorerLabel[]): ScorerLabel {
  return [...labels].sort((left, right) => right.score - left.score)[0] as ScorerLabel;
}

export interface StubJudgeOptions {
  /** Fixed label; defaults to the highest-scoring declared label. */
  label?: string;
  rationale?: string;
  modelVersion?: string;
}

/**
 * Deterministic, credential-free judge. Used by tests, CI and the compose smoke stack.
 * It selects the highest-scoring label unless a fixed label is supplied.
 */
export function createStubJudgeClient(options: StubJudgeOptions = {}): JudgeClient {
  return {
    id: 'stub',
    async complete(request: JudgeRequest): Promise<JudgeResponse> {
      const selected = options.label ?? highestLabelFrom(request.labels).value;
      const rationale =
        options.rationale ?? `stub judge selected "${selected}" deterministically`;
      const inputTokens = request.user.split(/\s+/).filter(Boolean).length;
      return {
        text: JSON.stringify({ label: selected, rationale }),
        model: request.model,
        modelVersion: options.modelVersion ?? 'stub-v1',
        inputTokens,
        outputTokens: 16,
        costUsd: 0,
      };
    },
  };
}

export interface OpenAIJudgeOptions {
  /** OpenAI-compatible base URL, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  apiKey?: string;
  /** Optional pricing used to attribute judge cost when the provider omits it. */
  inputPricePer1k?: number;
  outputPricePer1k?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** OpenAI-compatible judge client. The real path exists; CI never exercises it. */
export function createOpenAIJudgeClient(options: OpenAIJudgeOptions): JudgeClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    id: 'openai',
    async complete(request: JudgeRequest): Promise<JudgeResponse> {
      if (!baseUrl) {
        throw new JudgeError('judge_unavailable', 'no OpenAI-compatible base URL configured');
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: request.model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
          }),
          signal: controller.signal,
        });
      } catch (error) {
        throw new JudgeError(
          'judge_unavailable',
          `judge request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new JudgeError(
          'judge_unavailable',
          `judge endpoint returned ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      const payload = (await response.json()) as {
        model?: string;
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text.trim() === '') {
        throw new JudgeError('judge_invalid', 'judge endpoint returned an empty completion');
      }

      const inputTokens = payload.usage?.prompt_tokens ?? null;
      const outputTokens = payload.usage?.completion_tokens ?? null;
      const costUsd =
        inputTokens !== null && outputTokens !== null && options.inputPricePer1k !== undefined && options.outputPricePer1k !== undefined
          ? (inputTokens / 1000) * options.inputPricePer1k + (outputTokens / 1000) * options.outputPricePer1k
          : undefined;

      return {
        text,
        model: request.model,
        modelVersion: payload.model,
        ...(inputTokens !== null ? { inputTokens } : {}),
        ...(outputTokens !== null ? { outputTokens } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    },
  };
}

export function createJudgeClient(
  mode: 'stub' | 'openai',
  env: NodeJS.ProcessEnv = process.env,
): JudgeClient {
  if (mode === 'openai') {
    const baseUrl = env.OPENAI_BASE_URL;
    if (!baseUrl) {
      throw new JudgeError(
        'judge_unavailable',
        'SCORING_JUDGE_MODE=openai requires OPENAI_BASE_URL',
      );
    }
    const inputPrice = env.JUDGE_INPUT_PRICE_PER_1K;
    const outputPrice = env.JUDGE_OUTPUT_PRICE_PER_1K;
    return createOpenAIJudgeClient({
      baseUrl,
      ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}),
      ...(inputPrice ? { inputPricePer1k: Number(inputPrice) } : {}),
      ...(outputPrice ? { outputPricePer1k: Number(outputPrice) } : {}),
    });
  }
  return createStubJudgeClient();
}

export interface JudgeScoreResult {
  label: string;
  score: number;
  passing: boolean;
  rationale: string;
  provenance: {
    judgeModel: string;
    judgeModelVersion: string | null;
    rubricHash: string;
    promptHash: string;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
  };
}

export async function runJudgeScorer(args: {
  scorer: ScorerRegistryEntry;
  client: JudgeClient;
  context: RunContext;
}): Promise<JudgeScoreResult> {
  const prompt = buildJudgePrompt(args.scorer, args.context);
  let response: JudgeResponse;
  try {
    response = await args.client.complete({
      model: args.scorer.judgeModel,
      system: prompt.system,
      user: prompt.user,
      labels: args.scorer.labels,
    });
  } catch (error) {
    if (error instanceof JudgeError) throw error;
    throw new JudgeError(
      'judge_error',
      error instanceof Error ? error.message : String(error),
    );
  }

  const parsed = parseJudgeOutput(response.text, args.scorer);
  return {
    ...parsed,
    provenance: {
      judgeModel: args.scorer.judgeModel,
      judgeModelVersion: response.modelVersion ?? response.model ?? null,
      rubricHash: args.scorer.rubricHash,
      promptHash: prompt.promptHash,
      inputTokens: response.inputTokens ?? null,
      outputTokens: response.outputTokens ?? null,
      costUsd: response.costUsd ?? null,
    },
  };
}
