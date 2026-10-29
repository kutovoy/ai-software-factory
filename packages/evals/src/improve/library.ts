import type { ImprovementDecision } from './types';

/**
 * Experience library (spec `self-improvement` › Experience library, ADR-020).
 *
 * Lessons are stored per factory (`INDEX.md` + `EXPERIENCE.md`, mirrored in the `lessons`
 * table). Promotion into the shared library is an explicit human action; other factories
 * may then read the lesson as a suggestion, never auto-apply it.
 */

export interface LessonDraft {
  cue: string;
  lesson: string;
  evidence: Record<string, unknown>;
  confidence: number;
}

export interface LessonLike extends LessonDraft {
  factory: string;
  promoted: boolean;
}

export interface LessonSourceProposal {
  failureSignature: string;
  title: string;
  summary: string;
  files: string[];
  evidence: {
    runIds: string[];
    failedRuns: number;
    totalRuns: number;
    costUsd: number;
  };
}

/** Confidence is a bounded, explainable blend of probe delta and evidence volume. */
export function lessonConfidence(args: { probeDelta: number | null; failedRuns: number }): number {
  const probe = args.probeDelta === null ? 0 : Math.max(0, Math.min(1, args.probeDelta));
  const volume = Math.min(1, args.failedRuns / 10);
  const value = 0.35 + probe * 0.4 + volume * 0.2;
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000) / 1_000;
}

export function lessonFromProposal(args: {
  proposal: LessonSourceProposal;
  decision: ImprovementDecision;
  probeDelta: number | null;
}): LessonDraft {
  const { proposal, decision } = args;
  const outcome =
    decision.action === 'merge'
      ? 'merged'
      : decision.action === 'open_pr'
        ? 'opened as a pull request'
        : decision.action === 'canary_not_available'
          ? 'left as a candidate (canary rollout deferred to Phase 5b)'
          : 'closed without a candidate';
  return {
    cue: proposal.failureSignature,
    lesson: `${proposal.title} — ${outcome}. ${decision.reason}`,
    evidence: {
      runIds: proposal.evidence.runIds,
      failedRuns: proposal.evidence.failedRuns,
      totalRuns: proposal.evidence.totalRuns,
      costUsd: proposal.evidence.costUsd,
      files: proposal.files,
      decision: decision.action,
      code: decision.code,
      probeDelta: args.probeDelta,
    },
    confidence: lessonConfidence({
      probeDelta: args.probeDelta,
      failedRuns: proposal.evidence.failedRuns,
    }),
  };
}

/**
 * Lesson visibility rule: a factory sees its own lessons plus lessons that were promoted
 * into the shared library. An unpromoted lesson of another factory is invisible.
 */
export function visibleLessons<T extends { factory: string; promoted: boolean }>(
  lessons: T[],
  factory: string,
): T[] {
  return lessons.filter((lesson) => lesson.factory === factory || lesson.promoted);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function indexHeader(factory: string): string {
  return [
    `# Experience index — ${factory}`,
    '',
    '| Cue | Lesson | Confidence |',
    '| --- | --- | --- |',
    '',
  ].join('\n');
}

function experienceHeader(factory: string): string {
  return [`# Experience — ${factory}`, ''].join('\n');
}

export function renderExperienceIndex(factory: string, lessons: LessonLike[]): string {
  const rows = lessons
    .map((lesson) => `| \`${escapeCell(lesson.cue)}\` | ${escapeCell(lesson.lesson)} | ${lesson.confidence} |`)
    .join('\n');
  return `${indexHeader(factory)}${rows}${rows ? '\n' : ''}`;
}

export function renderExperience(factory: string, lessons: LessonLike[]): string {
  const blocks = lessons.map((lesson) =>
    [
      `## \`${lesson.cue}\``,
      '',
      `- Lesson: ${lesson.lesson}`,
      `- Evidence: ${String(lesson.evidence.failedRuns ?? '?')} failed run(s); runs: ${(lesson.evidence.runIds as string[] | undefined)?.join(', ') ?? 'none'}`,
      `- Confidence: ${lesson.confidence}`,
      lesson.promoted ? `- Promoted: yes` : null,
      '',
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
  );
  return `${experienceHeader(factory)}${blocks.join('\n')}`;
}

export interface AppendedLibrary {
  index: string;
  experience: string;
  /** False when the cue was already present (a retried activity is a no-op). */
  appended: boolean;
}

/**
 * Append-only library update. A retried activity must not duplicate a lesson, so a cue
 * already present in `EXPERIENCE.md` short-circuits.
 */
export function appendLessonFiles(args: {
  factory: string;
  index: string | null;
  experience: string | null;
  lesson: LessonDraft;
}): AppendedLibrary {
  const index = args.index ?? indexHeader(args.factory);
  const experience = args.experience ?? experienceHeader(args.factory);

  if (experience.includes(`## \`${args.lesson.cue}\``)) {
    return { index, experience, appended: false };
  }

  const row = `| \`${escapeCell(args.lesson.cue)}\` | ${escapeCell(args.lesson.lesson)} | ${args.lesson.confidence} |`;
  const nextIndex = `${index.replace(/\n*$/, '\n')}${row}\n`;

  const block = [
    `## \`${args.lesson.cue}\``,
    '',
    `- Lesson: ${args.lesson.lesson}`,
    `- Evidence: ${String(args.lesson.evidence.failedRuns ?? '?')} failed run(s); runs: ${(args.lesson.evidence.runIds as string[] | undefined)?.join(', ') ?? 'none'}`,
    `- Confidence: ${args.lesson.confidence}`,
    '',
  ].join('\n');

  return {
    index: nextIndex,
    experience: `${experience.replace(/\n*$/, '\n\n')}${block}`,
    appended: true,
  };
}
