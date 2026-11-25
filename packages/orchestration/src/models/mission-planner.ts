import {
  EXPECTED_PAIN_LEVELS,
  PLAN_DEPTHS,
  RISK_TIERS,
  classifyRisk,
  newMissionFeatureId,
  newMissionMilestoneId,
  planDepthFor,
  validateMissionPlan,
  type ExpectedPain,
  type MissionArchitecture,
  type MissionPlan,
  type MissionProgramDesign,
  type MissionProductReview,
  type MissionVerticalSlice,
  type PlanDepth,
  type QualityConfig,
  type RiskGovernance,
  type RiskTier,
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
  /** Resolved `governance.risk` block from the factory definition. */
  riskGovernance?: RiskGovernance;
  /** Parsed `quality` block; carried for budget-aware planning (P0 does not gate on it). */
  quality?: QualityConfig;
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
/** Explicit thresholds required for architecture/maintainability assertions. */
export const ARCHITECTURE_ASSERTION: MissionValidationAssertionData = {
  id: 'VAL-ARCH',
  title: 'Architecture boundaries and dependency cycles',
  assertion:
    'Inspect module dependencies and the public surface. No dependency cycles, no upward imports across declared layers, and no breaking change to a public API contract.',
  tier: 'architecture',
  required: true,
  tool: 'command',
  evidence: 'dependency report or command output',
  thresholds: { maxDependencyCycles: 0 },
};

export const MAINTAINABILITY_ASSERTION: MissionValidationAssertionData = {
  id: 'VAL-MAINT',
  title: 'Maintainability and duplication',
  assertion:
    'Measure duplication, complexity and diff size. The change must stay within the stated thresholds and add no dead or duplicated code.',
  tier: 'maintainability',
  required: true,
  tool: 'command',
  evidence: 'duplication/complexity report or command output',
  thresholds: { maxDuplicationPercent: 3 },
};

function uniqueAssertionId(base: string, assertions: MissionValidationAssertionData[]): string {
  const taken = new Set(assertions.map((assertion) => assertion.id));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function appendRiskAssertions(
  assertions: MissionValidationAssertionData[],
  riskTier: RiskTier,
): MissionValidationAssertionData[] {
  if (riskTier === 'low') return assertions;
  const next = [...assertions];
  if (!next.some((assertion) => assertion.tier === 'architecture')) {
    next.push({ ...ARCHITECTURE_ASSERTION, id: uniqueAssertionId('VAL-ARCH', next) });
  }
  if (!next.some((assertion) => assertion.tier === 'maintainability')) {
    next.push({ ...MAINTAINABILITY_ASSERTION, id: uniqueAssertionId('VAL-MAINT', next) });
  }
  return next;
}

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
    const risk = classifyRisk({ goal: input.goal, governance: input.riskGovernance });

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
    const contractAssertions = appendRiskAssertions(assertions, risk.tier);
    const riskAssertionIds = contractAssertions
      .filter(
        (assertion) =>
          assertion.tier === 'architecture' || assertion.tier === 'maintainability',
      )
      .map((assertion) => assertion.id);

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
        acceptanceCheckIds: [assertion.id, ...riskAssertionIds],
        workItemType: 'task',
        riskTier: risk.tier,
        verticalSlice: clamp(title, 200),
        kind: 'slice',
      });
    }

    const productReview: MissionProductReview = {
      problem: clamp(input.goal.trim().length > 0 ? input.goal : input.title, 4000),
      desiredBehavior: titles.map((title) => clamp(title, 500)),
      mockups: [],
      // Honest: the deterministic planner invents no visuals; the UI shows an empty state.
      visualArtifacts: [],
    };

    const architecture: MissionArchitecture = {
      summary: clamp(
        `Derived from the mission goal: "${input.title || titles[0] || 'Mission'}". Component boundaries are left to the implementer; the plan records the goal so the architecture can be refined as the first slice lands.`,
        4000,
      ),
      components: [],
      dataModels: [],
      constraints: [],
    };

    const programDesign: MissionProgramDesign = { modules: [], callGraph: [] };

    const verticalSlices: MissionVerticalSlice[] = features.map((feature, index) => ({
      name: clamp(feature.verticalSlice ?? feature.title, 200),
      order: index,
      featureIds: [feature.id],
      checks: [...feature.acceptanceCheckIds],
    }));

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

    // Plan depth metadata (change `add-anti-slop-budgets-and-proof`): deterministic, sized
    // from the risk tier and the number of goal lines (~80 changed lines each).
    const expectedPain: ExpectedPain = risk.tier;
    const planDepth: PlanDepth = planDepthFor({
      riskTier: risk.tier,
      expectedPain,
      changeSize: titles.length * 80,
      reversible: true,
    });
    const leverage = clamp(
      (titles[0] ?? '').trim().length > 0 ? (titles[0] as string) : input.title || 'Mission',
      2000,
    );

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
        assertions: contractAssertions,
        risks: [],
        source: 'orchestrator',
      },
      milestones: [milestone],
      risks: [],
      assumptions: [],
      riskTier: risk.tier,
      riskReasons: risk.reasons,
      productReview,
      architecture,
      programDesign,
      verticalSlices,
      planDepth,
      expectedPain,
      leverage,
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
  '"riskTier":"low|medium|high","riskReasons":string[],',
  '"planDepth":"none|light|full","expectedPain":"low|medium|high","leverage":string,',
  '"productReview":{"problem":string,"desiredBehavior":string[],"mockups":string[],',
  '"visualArtifacts":string[]},',
  '"architecture":{"summary":string,"components":[{"name":string,"responsibility":string,',
  '"contracts":string[]}],"dataModels":string[],"constraints":string[]},',
  '"programDesign":{"modules":[{"name":string,"path":string,"responsibility":string,',
  '"publicApi":string[]}],"callGraph":string[]},',
  '"verticalSlices":[{"name":string,"order":number,"featureIds":number[],"checks":string[]}],',
  '"validationContract":{"enforce":boolean,"assertions":[{"id":string,"title":string,',
  '"assertion":string,"tier":"unit|component|integration|e2e|manual|architecture|maintainability",',
  '"required":boolean,"tool":string,"evidence":string,"command"?:string,"expected"?:string,',
  '"thresholds"?:{"<metric>":number}}]},',
  '"milestones":[{"title":string,"description":string,"features":[{"title":string,',
  '"description":string,"dependsOn":number[],"acceptanceCheckIds":string[],',
  '"riskTier":"low|medium|high","verticalSlice":string,"kind":"slice|enabler"}]}]}',
  'Write the validation contract before the features. Every feature must claim at least',
  'one assertion id. `dependsOn` lists feature indexes inside the same milestone.',
  'Derive `riskTier` and record concrete `riskReasons`; medium/high risk plans must include',
  'productReview, architecture, programDesign and verticalSlices.',
  'Set `planDepth` and `expectedPain` explicitly: low-risk reversible changes may be',
  '"none"/"light"; medium risk is "light"; high risk or data/API/schema changes are "full"',
  'with "high" expected pain. `leverage` states the smallest change that unlocks the goal.',
  'For a UI or behavioral medium/high plan, put a visual mockup/diagram reference in',
  'productReview.visualArtifacts (e.g. "docs/mockups/<name>.html"); never invent a file that',
  'will not exist — leave the array empty when no visual was produced.',
  'A vertical slice is an end-to-end behavior, not a horizontal layer. Prefer slices that',
  'deliver working behavior; group scaffolding into the first runnable slice. A plan must',
  'contain at least one `slice`; an `enabler` must state in `verticalSlice` what later slice',
  'verifies it. Avoid horizontal features such as "add package.json" on their own.',
  'For medium/high risk include at least one `architecture` assertion (e.g. thresholds',
  '{"maxDependencyCycles":0}) and one `maintainability` assertion (e.g.',
  '{"maxDuplicationPercent":3}); state the threshold explicitly.',
  'If the goal asks for runnable software, include at least one integration assertion that',
  'runs the install/build and one e2e assertion that exercises the app in a browser; do not',
  'approve a plan whose only evidence is static file checks.',
  'Prefer 1-8 features and one milestone unless the goal clearly needs more.',
].join('\n');

interface RawPlan {
  title?: unknown;
  goal?: unknown;
  risks?: unknown;
  assumptions?: unknown;
  riskTier?: unknown;
  riskReasons?: unknown;
  planDepth?: unknown;
  expectedPain?: unknown;
  leverage?: unknown;
  productReview?: unknown;
  architecture?: unknown;
  programDesign?: unknown;
  verticalSlices?: unknown;
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asThresholds(value: unknown): Record<string, number> | undefined {
  const source = asRecord(value);
  const metrics: Record<string, number> = {};
  for (const [key, raw] of Object.entries(source)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) metrics[key] = raw;
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function asRiskTier(value: unknown): RiskTier | null {
  return typeof value === 'string' && (RISK_TIERS as readonly string[]).includes(value)
    ? (value as RiskTier)
    : null;
}

function asFeatureKind(value: unknown): 'slice' | 'enabler' | null {
  return value === 'slice' || value === 'enabler' ? value : null;
}

function asPlanDepth(value: unknown): PlanDepth | null {
  return typeof value === 'string' && (PLAN_DEPTHS as readonly string[]).includes(value)
    ? (value as PlanDepth)
    : null;
}

function asExpectedPain(value: unknown): ExpectedPain | null {
  return typeof value === 'string' && (EXPECTED_PAIN_LEVELS as readonly string[]).includes(value)
    ? (value as ExpectedPain)
    : null;
}

function firstGoalLine(goal: string): string | null {
  for (const line of goal.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function parseProductReview(value: unknown): MissionProductReview | undefined {
  const item = asRecord(value);
  const problem =
    typeof item.problem === 'string' && item.problem.trim().length > 0
      ? clamp(item.problem, 4000)
      : null;
  if (!problem) return undefined;
  return {
    problem,
    desiredBehavior: asStringArray(item.desiredBehavior)
      .map((entry) => clamp(entry, 500))
      .slice(0, 50),
    mockups: asStringArray(item.mockups)
      .map((entry) => clamp(entry, 500))
      .slice(0, 50),
    visualArtifacts: asStringArray(item.visualArtifacts)
      .map((entry) => clamp(entry, 500))
      .slice(0, 50),
  };
}

function parseArchitecture(value: unknown): MissionArchitecture | undefined {
  const item = asRecord(value);
  const summary =
    typeof item.summary === 'string' && item.summary.trim().length > 0
      ? clamp(item.summary, 4000)
      : null;
  if (!summary) return undefined;
  const components = (Array.isArray(item.components) ? item.components : [])
    .slice(0, 100)
    .map((entry) => {
      const component = asRecord(entry);
      return {
        name: clamp(asString(component.name, 'Component'), 200),
        responsibility: clamp(asString(component.responsibility, 'Not specified'), 2000),
        contracts: asStringArray(component.contracts)
          .map((contract) => clamp(contract, 500))
          .slice(0, 50),
      };
    });
  return {
    summary,
    components,
    dataModels: asStringArray(item.dataModels)
      .map((entry) => clamp(entry, 500))
      .slice(0, 100),
    constraints: asStringArray(item.constraints)
      .map((entry) => clamp(entry, 500))
      .slice(0, 100),
  };
}

function parseProgramDesign(value: unknown): MissionProgramDesign | undefined {
  const item = asRecord(value);
  if (!('modules' in item) && !('callGraph' in item)) return undefined;
  const modules = (Array.isArray(item.modules) ? item.modules : [])
    .slice(0, 100)
    .map((entry) => {
      const module = asRecord(entry);
      return {
        name: clamp(asString(module.name, 'Module'), 200),
        path: clamp(asString(module.path, 'src'), 500),
        responsibility: clamp(asString(module.responsibility, 'Not specified'), 2000),
        publicApi: asStringArray(module.publicApi)
          .map((entry) => clamp(entry, 500))
          .slice(0, 50),
      };
    });
  return {
    modules,
    callGraph: asStringArray(item.callGraph)
      .map((entry) => clamp(entry, 1000))
      .slice(0, 200),
  };
}

/**
 * Conservative artifact synthesis for medium/high-risk plans whose model omitted a
 * section. The plan must remain valid, and a missing artifact must not silently downgrade
 * the plan to "no design".
 */
function synthesizeArtifacts(
  riskTier: RiskTier,
  input: MissionPlannerInput,
  features: MissionFeaturePlanData[],
): {
  productReview: MissionProductReview | undefined;
  architecture: MissionArchitecture | undefined;
  programDesign: MissionProgramDesign | undefined;
} {
  if (riskTier === 'low') {
    return { productReview: undefined, architecture: undefined, programDesign: undefined };
  }
  return {
    productReview: {
      problem: clamp(input.goal.trim().length > 0 ? input.goal : input.title, 4000),
      desiredBehavior: features.map((feature) => clamp(feature.title, 500)).slice(0, 50),
      mockups: [],
      visualArtifacts: [],
    },
    architecture: {
      summary: clamp(
        `Derived from the mission goal: "${input.title}". The plan requires architecture evidence before approval; component boundaries are recorded as the slices land.`,
        4000,
      ),
      components: [],
      dataModels: [],
      constraints: [],
    },
    programDesign: { modules: [], callGraph: [] },
  };
}

/**
 * Normalises model-supplied ids: models cannot mint valid Crockford ULIDs, so milestone
 * and feature ids are replaced here and `dependsOn` indexes are remapped to the new ids.
 */
function normalizePlan(raw: RawPlan, input: MissionPlannerInput): MissionPlanData {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const rawMilestones = Array.isArray(raw.milestones) ? raw.milestones : [];
  const rawContract = asRecord(raw.validationContract);
  const rawAssertions = Array.isArray(rawContract.assertions) ? rawContract.assertions : [];

  const declaredTier = asRiskTier(raw.riskTier);
  const classification = classifyRisk({
    ...(declaredTier ? { declaredTier } : {}),
    goal: input.goal,
    governance: input.riskGovernance,
  });
  const riskTier = classification.tier;
  const riskReasons = asStringArray(raw.riskReasons);
  for (const reason of classification.reasons) {
    if (!riskReasons.includes(reason)) riskReasons.push(reason);
  }

  const assertions: MissionValidationAssertionData[] = rawAssertions.map((entry, index) => {
    const item = asRecord(entry);
    const tier = asString(item.tier, 'e2e');
    const thresholds = asThresholds(item.thresholds);
    return {
      id: asString(item.id, `VAL-${index + 1}`),
      title: clamp(asString(item.title, `Assertion ${index + 1}`), 200),
      assertion: clamp(asString(item.assertion, `Assertion ${index + 1} holds`), 4000),
      tier: (
        [
          'unit',
          'component',
          'integration',
          'e2e',
          'manual',
          'architecture',
          'maintainability',
        ] as const
      ).includes(tier as MissionValidationAssertionData['tier'])
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
      ...(thresholds ? { thresholds } : {}),
    };
  });

  // Every milestone gets fresh ULIDs; feature ids are assigned before `dependsOn` is
  // remapped so the model's indexes can be resolved in one pass.
  const milestones: MissionMilestonePlanData[] = rawMilestones.map((entry, milestoneIndex) => {
    const item = asRecord(entry);
    const rawFeatures = Array.isArray(item.features) ? item.features : [];
    const featureIds = rawFeatures.map(() => newMissionFeatureId());
    const features: MissionFeaturePlanData[] = rawFeatures.map((featureEntry, featureIndex) => {
      const feature = asRecord(featureEntry);
      const rawDependsOn = Array.isArray(feature.dependsOn) ? feature.dependsOn : [];
      const dependsOn = rawDependsOn
        .map((dependency) =>
          typeof dependency === 'number' ? featureIds[dependency] : undefined,
        )
        .filter((dependency): dependency is string => dependency !== undefined);
      const claimed = asStringArray(feature.acceptanceCheckIds).filter((id) =>
        assertions.some((assertion) => assertion.id === id),
      );
      const title = clamp(asString(feature.title, `Feature ${featureIndex + 1}`), 200);
      const verticalSlice =
        typeof feature.verticalSlice === 'string' && feature.verticalSlice.trim().length > 0
          ? clamp(feature.verticalSlice, 2000)
          : title;
      return {
        id: featureIds[featureIndex] as string,
        title,
        description: clamp(
          asString(feature.description, asString(feature.title, `Feature ${featureIndex + 1}`)),
          8000,
        ),
        order: featureIndex,
        dependsOn,
        acceptanceCheckIds:
          claimed.length > 0 ? claimed : assertions[0] ? [assertions[0].id] : [],
        workItemType: 'task',
        riskTier: asRiskTier(feature.riskTier) ?? riskTier,
        verticalSlice,
        kind: asFeatureKind(feature.kind) ?? 'slice',
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

  const allFeatures = milestones.flatMap((milestone) => milestone.features);

  // A plan must contain at least one real slice; a model that marked everything an
  // enabler gets its first feature promoted instead of failing the whole plan.
  if (allFeatures.length > 0 && !allFeatures.some((feature) => feature.kind !== 'enabler')) {
    const first = allFeatures[0] as MissionFeaturePlanData;
    first.kind = 'slice';
  }

  // Medium/high-risk plans require architecture and maintainability assertions.
  if (riskTier !== 'low') {
    if (!assertions.some((assertion) => assertion.tier === 'architecture')) {
      assertions.push({ ...ARCHITECTURE_ASSERTION, id: uniqueAssertionId('VAL-ARCH', assertions) });
    }
    if (!assertions.some((assertion) => assertion.tier === 'maintainability')) {
      assertions.push({
        ...MAINTAINABILITY_ASSERTION,
        id: uniqueAssertionId('VAL-MAINT', assertions),
      });
    }
    const riskAssertionIds = assertions
      .filter(
        (assertion) =>
          assertion.tier === 'architecture' || assertion.tier === 'maintainability',
      )
      .map((assertion) => assertion.id);
    for (const feature of allFeatures) {
      for (const id of riskAssertionIds) {
        if (!feature.acceptanceCheckIds.includes(id)) feature.acceptanceCheckIds.push(id);
      }
    }
  }

  const parsedProductReview = parseProductReview(raw.productReview);
  const parsedArchitecture = parseArchitecture(raw.architecture);
  const parsedProgramDesign = parseProgramDesign(raw.programDesign);
  const synthesized = synthesizeArtifacts(riskTier, input, allFeatures);
  const productReview = parsedProductReview ?? synthesized.productReview;
  const architecture = parsedArchitecture ?? synthesized.architecture;
  const programDesign = parsedProgramDesign ?? synthesized.programDesign;

  // Vertical slices: model indexes are remapped to minted feature ids; any feature not
  // covered by a slice gets its own conservative slice so the plan always validates.
  const rawSlices = Array.isArray(raw.verticalSlices) ? raw.verticalSlices : [];
  const slices: MissionVerticalSlice[] = [];
  const covered = new Set<string>();
  const knownIds = new Set(allFeatures.map((feature) => feature.id));
  for (const entry of rawSlices.slice(0, 100)) {
    const item = asRecord(entry);
    const name = asString(item.name, '');
    if (name.length === 0) continue;
    const rawIds = Array.isArray(item.featureIds) ? item.featureIds : [];
    const ids: string[] = [];
    for (const value of rawIds) {
      const id =
        typeof value === 'number' ? allFeatures[value]?.id : typeof value === 'string' ? value : null;
      if (id && knownIds.has(id) && !covered.has(id) && !ids.includes(id)) ids.push(id);
    }
    if (ids.length === 0) continue;
    for (const id of ids) covered.add(id);
    slices.push({
      name: clamp(name, 200),
      order: slices.length,
      featureIds: ids,
      checks: asStringArray(item.checks)
        .map((check) => clamp(check, 500))
        .slice(0, 100),
    });
  }
  for (const feature of allFeatures) {
    if (covered.has(feature.id)) continue;
    covered.add(feature.id);
    slices.push({
      name: clamp(feature.verticalSlice ?? feature.title, 200),
      order: slices.length,
      featureIds: [feature.id],
      checks: [...feature.acceptanceCheckIds],
    });
  }

  // Plan depth metadata: use the model's values when present, otherwise derive
  // deterministically from the risk tier and the plan size. Never fail on absence.
  const expectedPain = asExpectedPain(raw.expectedPain) ?? riskTier;
  const planDepth =
    asPlanDepth(raw.planDepth) ??
    planDepthFor({
      riskTier,
      expectedPain,
      changeSize: allFeatures.length * 80,
      reversible: true,
    });
  const leverage = clamp(
    (typeof raw.leverage === 'string' && raw.leverage.trim().length > 0
      ? raw.leverage
      : firstGoalLine(input.goal) ?? input.title) || 'Mission',
    2000,
  );

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
    riskTier,
    riskReasons,
    ...(productReview ? { productReview } : {}),
    ...(architecture ? { architecture } : {}),
    ...(programDesign ? { programDesign } : {}),
    ...(slices.length > 0 ? { verticalSlices: slices } : {}),
    planDepth,
    expectedPain,
    leverage,
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
      const configuredTimeout = Number(process.env.MISSION_PLANNER_TIMEOUT_MS ?? '600000');
      const timeoutMs =
        options.timeoutMs ??
        (Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 600_000);
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
  const configuredTimeout = Number(env.MISSION_PLANNER_TIMEOUT_MS ?? '600000');
  return createOpenAIMissionPlanner({
    baseUrl,
    apiKey,
    model,
    timeoutMs: Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 600_000,
  });
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
