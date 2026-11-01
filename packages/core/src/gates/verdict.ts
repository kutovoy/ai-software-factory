/**
 * Agent gate verdicts (change `add-agent-verdicts`).
 *
 * An agent-gated stage is asked to end its summary with a fenced JSON block:
 *
 *   ```json
 *   {"verdict":"approve|request_changes|reject","summary":"...","findings":[...]}
 *   ```
 *
 * The parser reads the LAST such block, so a stage that quotes an earlier verdict in its
 * reasoning cannot spoof the gate. When no block is found it falls back to explicit textual
 * signals (`VERDICT: FAIL`, a line starting `FAIL`, `REQUEST_CHANGES`, `VERDICT: PASS`) and
 * reports which source produced the decision. Anything else is `unknown` — the factory's
 * `agentVerdict` policy decides what a missing verdict means.
 *
 * Deliberately dependency-free: the workflow sandbox imports this module directly through
 * `@factory/core/gates/verdict` (no Node APIs, no zod).
 */

export const AGENT_VERDICT_DECISIONS = ['approve', 'request_changes', 'reject', 'unknown'] as const;
export type AgentVerdictDecision = (typeof AGENT_VERDICT_DECISIONS)[number];

export const AGENT_VERDICT_SOURCES = ['structured', 'textual', 'none'] as const;
export type AgentVerdictSource = (typeof AGENT_VERDICT_SOURCES)[number];

export interface AgentVerdict {
  decision: AgentVerdictDecision;
  source: AgentVerdictSource;
  /** The block's own summary (or the matched textual signal). Never the whole run log. */
  summary?: string;
  findings?: unknown[];
}

/** What a missing verdict means. `advisory` preserves pre-verdict behaviour. */
export const AGENT_VERDICT_POLICIES = ['advisory', 'required'] as const;
export type AgentVerdictPolicy = (typeof AGENT_VERDICT_POLICIES)[number];

const STRUCTURED_ALIASES: Record<string, AgentVerdictDecision> = {
  approve: 'approve',
  approved: 'approve',
  pass: 'approve',
  passed: 'approve',
  ok: 'approve',
  request_changes: 'request_changes',
  changes_requested: 'request_changes',
  changes: 'request_changes',
  reject: 'reject',
  rejected: 'reject',
  fail: 'reject',
  failed: 'reject',
};

function normalizeStructured(value: unknown): AgentVerdictDecision | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return STRUCTURED_ALIASES[key] ?? null;
}

/** Every fenced block, tagged or not; the tag is returned so `json` can be preferred. */
const FENCE_RE = /```([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;

interface FencedBlock {
  tag: string;
  body: string;
}

function fencedBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(text)) !== null) {
    blocks.push({ tag: (match[1] ?? '').toLowerCase(), body: match[2] ?? '' });
  }
  return blocks;
}

function structuredVerdict(text: string): AgentVerdict | null {
  // The LAST block that carries a `verdict` key wins, even when its value is not one of the
  // accepted aliases: a stage that quotes an earlier approval cannot spoof the gate.
  let candidate: Record<string, unknown> | null = null;

  for (const block of fencedBlocks(text)) {
    if (block.tag !== '' && block.tag !== 'json') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(block.body.trim());
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

    const record = parsed as Record<string, unknown>;
    if ('verdict' in record) candidate = record;
  }

  if (!candidate) return null;
  const decision = normalizeStructured(candidate.verdict);
  if (!decision) return null;

  const summary =
    typeof candidate.summary === 'string' && candidate.summary.trim() !== ''
      ? candidate.summary.trim()
      : undefined;
  const findings = Array.isArray(candidate.findings) ? candidate.findings : undefined;

  return {
    decision,
    source: 'structured',
    ...(summary ? { summary } : {}),
    ...(findings ? { findings } : {}),
  };
}

const TEXTUAL_WINDOW = 40;

function textualVerdict(text: string): AgentVerdict | null {
  const lines = text.split(/\r?\n/).slice(-TEXTUAL_WINDOW);

  // Walk backwards: the last explicit signal in the summary wins.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim();
    if (line === '') continue;

    if (/^VERDICT:\s*(FAIL|FAILED)\b/i.test(line)) {
      return { decision: 'request_changes', source: 'textual', summary: line };
    }
    if (/^VERDICT:\s*(PASS|APPROVE|APPROVED)\b/i.test(line)) {
      return { decision: 'approve', source: 'textual', summary: line };
    }
    if (/^(FAIL|FAILED)\b/i.test(line)) {
      return { decision: 'request_changes', source: 'textual', summary: line };
    }
    if (/\bREQUEST_CHANGES\b/i.test(line)) {
      return { decision: 'request_changes', source: 'textual', summary: line };
    }
  }

  return null;
}

/**
 * Parses an agent stage's final summary into a gate verdict.
 *
 * Structured block first (last one wins), then the textual fallback over the last ~40 lines.
 * `unknown` with `source: 'none'` means the stage emitted no usable verdict.
 */
export function parseAgentVerdict(summary?: string): AgentVerdict {
  if (typeof summary !== 'string' || summary.trim() === '') {
    return { decision: 'unknown', source: 'none' };
  }

  return structuredVerdict(summary) ?? textualVerdict(summary) ?? { decision: 'unknown', source: 'none' };
}
