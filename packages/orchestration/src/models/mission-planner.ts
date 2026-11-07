import {
  newMissionFeatureId,
  newMissionMilestoneId,
  validateMissionPlan,
  type MissionPlan,
} from '@factory/core';
import type {
  MissionFeaturePlanData,
  MissionMilestonePlanData,
  MissionPlanData,
  MissionValidationAssertionData,
} from '../types';

/**
 * Mission planner boundary (design decision 3).
 *
 * A mission plan is written before any feature runs: a validation contract first, then
 * milestones and features that claim assertions. The deterministic planner is the default
 * so tests and demos need no model, no network and no credentials. When an
 * OpenAI-compatible endpoint is configured (`OPENAI_BASE_URL`, `OPENAI_API_KEY`,
 * `OPENAI_MODEL`), the real planner asks it for a JSON plan and validates it with the
 * core schema before it can reach the workflow.
 */

export interface MissionPlannerInput {
  missionId: string;
  factory: string;
  definitionCommit: string;
  title: string;
  goal: string;
  /** Feedback from a `request_changes` plan decision (replan loop). */
  feedback?: string;
  /** Fixed timestamp for tests; defaults to now. */
  createdAt?: string;
}

export interface MissionPlanner {
  readonly id: string;
  plan(input: MissionPlannerInput): Promise<MissionPlanData>;
}

function clamp(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Deterministic planner: one milestone. Non-empty goal lines become features (in order,
 * chained by `dependsOn`); a goal with no non-empty line becomes a single feature named
 * after the mission title. Every feature claims one assertion, so the plan is valid and
 * the validation contract is never empty.
 */
export const deterministicMissionPlanner: MissionPlanner = {
  id: 'deterministic',
  async plan(input: MissionPlannerInput): Promise<MissionPlanData> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const lines = input.goal
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const titles = lines.length > 0 ? lines : [input.title];
    const milestoneId = newMissionMilestoneId();

    const assertions: MissionValidationAssertionData[] = titles.map((title, index) => ({
      id: `VAL-${index + 1}`,
      title: clamp(title, 200),
      assertion: clamp(
        `The mission goal is satisfied for: ${title}. Exercise the behavior and report evidence.`,
        4000,
      ),
      tier: 'e2e',
      required: true,
      tool: 'agent-browser',
      evidence: 'screenshot or command output',
    }));

    const features: MissionFeaturePlanData[] = [];
    for (const [index, title] of titles.entries()) {
      const assertion = assertions[index] as MissionValidationAssertionData;
      const previous = index > 0 ? features[index - 1]?.id : undefined;
      features.push({
        id: newMissionFeatureId(),
        title: clamp(title, 200),
        description: clamp(
          `Implement: ${title}\n\nMission goal:\n${input.goal}\n\nAcceptance: ${assertion.assertion}`,
          8000,
        ),
        order: index,
        dependsOn: previous ? [previous] : [],
        acceptanceCheckIds: [assertion.id],
        workItemType: 'task',
      });
    }

    const milestone: MissionMilestonePlanData = {
      id: milestoneId,
      title: clamp(input.title || titles[0] || 'Mission', 200),
      description: clamp(
        input.goal.trim().length > 0 ? input.goal : (input.title || 'Mission'),
        8000,
      ),
      order: 0,
      features,
    };

    return {
      version: 'v1alpha1',
      missionId: input.missionId,
      factory: input.factory,
      definitionCommit: input.definitionCommit,
      title: clamp(input.title || titles[0] || 'Mission', 200),
      goal: input.goal,
      createdAt,
      validationContract: {
        version: 'v1alpha1',
        missionId: input.missionId,
        factory: input.factory,
        definitionCommit: input.definitionCommit,
        createdAt,
        enforce: true,
        assertions,
        risks: [],
        source: 'orchestrator',
      },
      milestones: [milestone],
      risks: [],
      assumptions: [],
    };
  },
};

/* ------------------------------------------------------------------ OpenAI */

export interface OpenAIMissionPlannerOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const PLAN_SYSTEM_PROMPT = [
  'You are a mission planner for a software factory.',
  'Return exactly one JSON object, no prose.',
  'The object must match this shape:',
  '{"title":string,"goal":string,"risks":string[],"assumptions":string[],',
  '"validationContract":{"enforce":boolean,"assertions":[{"id":string,"title":string,',
  '"assertion":string,"tier":"unit|component|integration|e2e|manual","required":boolean,',
  '"tool":string,"evidence":string,"command"?:string,"expected"?:string}]},',
  '"milestones":[{"title":string,"description":string,"features":[{"title":string,',
  '"description":string,"dependsOn":number[],"acceptanceCheckIds":string[]}]}]}',
  'Write the validation contract before the features. Every feature must claim at least',
  'one assertion id. `dependsOn` lists feature indexes inside the same milestone.',
  'Prefer 1-8 features and one milestone unless the goal clearly needs more.',
].join('\n');

interface RawPlan {
  title?: unknown;
  goal?: unknown;
  risks?: unknown;
  assumptions?: unknown;
  validationContract?: {
    enforce?: unknown;
    assertions?: unknown;
    risks?: unknown;
  };
  milestones?: unknown;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

/**
 * Normalises model-supplied ids: models cannot mint valid Crockford ULIDs, so milestone
 * and feature ids are replaced here and `dependsOn` indexes are remapped to the new ids.
 */
function normalizePlan(raw: RawPlan, input: MissionPlannerInput): MissionPlanData {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const rawMilestones = Array.isArray(raw.milestones) ? raw.milestones : [];
  const rawContract =
    typeof raw.validationContract === 'object' && raw.validationContract !== null
      ? raw.validationContract
      : {};
  const rawAssertions = Array.isArray(rawContract.assertions) ? rawContract.assertions : [];

  const assertions: MissionValidationAssertionData[] = rawAssertions.map((entry, index) => {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const tier = asString(item.tier, 'e2e');
    return {
      id: asString(item.id, `VAL-${index + 1}`),
      title: clamp(asString(item.title, `Assertion ${index + 1}`), 200),
      assertion: clamp(asString(item.assertion, `Assertion ${index + 1} holds`), 4000),
      tier: (['unit', 'component', 'integration', 'e2e', 'manual'] as const).includes(
        tier as 'unit' | 'component' | 'integration' | 'e2e' | 'manual',
      )
        ? (tier as MissionValidationAssertionData['tier'])
        : 'e2e',
      required: item.required === false ? false : true,
      tool: clamp(asString(item.tool, 'agent-browser'), 120),
      evidence: clamp(asString(item.evidence, 'screenshot or command output'), 500),
      ...(typeof item.command === 'string' && item.command.trim().length > 0
        ? { command: clamp(item.command, 2000) }
        : {}),
      ...(typeof item.expected === 'string' && item.expected.trim().length > 0
        ? { expected: clamp(item.expected, 1000) }
        : {}),
    };
  });

  // Every milestone gets fresh ULIDs; feature ids are assigned before `dependsOn` is
  // remapped so the model's indexes can be resolved in one pass.
  const milestones: MissionMilestonePlanData[] = rawMilestones.map((entry, milestoneIndex) => {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const rawFeatures = Array.isArray(item.features) ? item.features : [];
    const featureIds = rawFeatures.map(() => newMissionFeatureId());
    const features: MissionFeaturePlanData[] = rawFeatures.map((featureEntry, featureIndex) => {
      const feature = (
        typeof featureEntry === 'object' && featureEntry !== null ? featureEntry : {}
      ) as Record<string, unknown>;
      const rawDependsOn = Array.isArray(feature.dependsOn) ? feature.dependsOn : [];
      const dependsOn = rawDependsOn
        .map((dependency) =>
          typeof dependency === 'number' ? featureIds[dependency] : undefined,
        )
        .filter((dependency): dependency is string => dependency !== undefined);
      const claimed = asStringArray(feature.acceptanceCheckIds).filter((id) =>
        assertions.some((assertion) => assertion.id === id),
      );
      return {
        id: featureIds[featureIndex] as string,
        title: clamp(asString(feature.title, `Feature ${featureIndex + 1}`), 200),
        description: clamp(
          asString(feature.description, asString(feature.title, `Feature ${featureIndex + 1}`)),
          8000,
        ),
        order: featureIndex,
        dependsOn,
        acceptanceCheckIds:
          claimed.length > 0 ? claimed : assertions[0] ? [assertions[0].id] : [],
        workItemType: 'task',
      };
    });

    return {
      id: newMissionMilestoneId(),
      title: clamp(asString(item.title, `Milestone ${milestoneIndex + 1}`), 200),
      description: clamp(asString(item.description, ''), 8000),
      order: milestoneIndex,
      features,
    };
  });

  return {
    version: 'v1alpha1',
    missionId: input.missionId,
    factory: input.factory,
    definitionCommit: input.definitionCommit,
    title: clamp(asString(raw.title, input.title), 200),
    goal: input.goal,
    createdAt,
    validationContract: {
      version: 'v1alpha1',
      missionId: input.missionId,
      factory: input.factory,
      definitionCommit: input.definitionCommit,
      createdAt,
      enforce: rawContract.enforce === false ? false : true,
      assertions,
      risks: asStringArray(rawContract.risks),
      source: 'orchestrator',
    },
    milestones,
    risks: asStringArray(raw.risks),
    assumptions: asStringArray(raw.assumptions),
  };
}

/** OpenAI-compatible planner. Validates the model's JSON with the core plan schema. */
export function createOpenAIMissionPlanner(options: OpenAIMissionPlannerOptions): MissionPlanner {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    id: `openai:${options.model}`,
    async plan(input: MissionPlannerInput): Promise<MissionPlanData> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: options.model,
            temperature: 0,
            // Do not send `response_format`: several OpenAI-compatible gateways reject it.
            // The system prompt already requires one JSON object, and the parser validates it.
            messages: [
              { role: 'system', content: PLAN_SYSTEM_PROMPT },
              {
                role: 'user',
                content: [
                  `Mission id: ${input.missionId}`,
                  `Factory: ${input.factory}`,
                  `Definition commit: ${input.definitionCommit}`,
                  `Title: ${input.title}`,
                  `Goal:\n${input.goal}`,
                  ...(input.feedback ? [`Previous plan feedback:\n${input.feedback}`] : []),
                ].join('\n'),
              },
            ],
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `mission planner endpoint returned ${response.status}: ${body.slice(0, 300)}`,
        );
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('mission planner returned no JSON content');
      }

      // Some gateways wrap JSON in a markdown fence or add a sentence before/after it.
      const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
      const firstBrace = content.indexOf('{');
      const lastBrace = content.lastIndexOf('}');
      const jsonText =
        fenced?.[1]?.trim() ??
        (firstBrace >= 0 && lastBrace > firstBrace
          ? content.slice(firstBrace, lastBrace + 1)
          : content.trim());

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch (error) {
        throw new Error(
          `mission planner returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const normalized = normalizePlan(
        (typeof parsed === 'object' && parsed !== null ? parsed : {}) as RawPlan,
        input,
      );
      const validation = validateMissionPlan(normalized);
      if (!validation.plan) {
        throw new Error(`mission planner returned an invalid plan: ${validation.errors.join('; ')}`);
      }
      return validation.plan as MissionPlanData;
    },
  };
}

/** Configured real planner, or null when the environment is incomplete. */
export function configuredMissionPlanner(
  env: NodeJS.ProcessEnv = process.env,
): MissionPlanner | null {
  const baseUrl = env.OPENAI_BASE_URL;
  const apiKey = env.OPENAI_API_KEY;
  const model = env.OPENAI_MODEL ?? env.FACTORY_MODEL;
  if (!baseUrl || !apiKey || !model) return null;
  return createOpenAIMissionPlanner({ baseUrl, apiKey, model });
}

let current: MissionPlanner | null = null;

export function getMissionPlanner(): MissionPlanner {
  if (current) return current;
  return configuredMissionPlanner() ?? deterministicMissionPlanner;
}

/** Test hook: install a scripted planner; null restores the environment default. */
export function setMissionPlanner(next: MissionPlanner | null): void {
  current = next;
}

/** Exposed for tests that assert the core schema accepts the planner's output. */
export function validatePlannedMission(plan: MissionPlanData): string[] {
  return validateMissionPlan(plan as MissionPlan).errors;
}
