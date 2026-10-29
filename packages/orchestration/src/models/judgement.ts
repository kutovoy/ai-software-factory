import type { JudgementClassification } from '../types';

/**
 * Judgement-call model boundary.
 *
 * The foreman is deterministic control flow (design decision 4); the foreman *agent* is
 * only invoked for judgement calls, and its output is constrained to
 * `implement|spec|wait|reject`. The default implementation is a deterministic classifier
 * so tests and demos need no model, no network and no credentials; a real model can be
 * plugged in without touching the activity (the schema check happens there).
 */

export interface JudgementModelInput {
  workItemId: string;
  title: string;
  sourceRef: Record<string, unknown>;
  prompt: string;
}

export interface JudgementModelOutput {
  classification: string;
  confidence: number;
  reason: string;
}

export interface JudgementModel {
  readonly id: string;
  classify(input: JudgementModelInput): Promise<JudgementModelOutput>;
}

/**
 * Deterministic readiness classifier:
 *  - explicit `reject`/spam/duplicate markers -> reject;
 *  - `wait`/needs-info markers -> wait;
 *  - spec/design/RFC wording -> spec;
 *  - everything else the factory can take -> implement.
 */
export const deterministicJudgementModel: JudgementModel = {
  id: 'deterministic',
  async classify(input: JudgementModelInput): Promise<JudgementModelOutput> {
    const text = `${input.title}\n${input.prompt}\n${JSON.stringify(input.sourceRef)}`.toLowerCase();

    const match = (
      classification: JudgementClassification,
      reason: string,
      confidence: number,
    ): JudgementModelOutput => ({ classification, confidence, reason });

    if (/\b(spam|duplicate|wontfix|reject|out of scope)\b/.test(text)) {
      return match('reject', 'the work item is explicitly out of scope', 0.9);
    }
    if (/\b(wait|blocked|needs?[ -]?(info|clarification)|unclear)\b/.test(text)) {
      return match('wait', 'the work item needs more information before it can start', 0.7);
    }
    if (/\b(spec|design|rfc|proposal|plan)\b/.test(text)) {
      return match('spec', 'the work item asks for a specification first', 0.8);
    }
    if (/\b(fix|bug|broken|error|crash|implement|add|feature|retry|refactor|test)\b/.test(text)) {
      return match('implement', 'the work item is scoped enough for implementation', 0.85);
    }
    return match('implement', 'the factory can take this item', 0.6);
  },
};

let current: JudgementModel = deterministicJudgementModel;

export function getJudgementModel(): JudgementModel {
  return current;
}

/** Test hook: install a scripted model (invalid outputs exercise retry/escalation). */
export function setJudgementModel(next: JudgementModel | null): void {
  current = next ?? deterministicJudgementModel;
}
