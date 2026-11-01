import { describe, expect, it } from 'bun:test';
import { parseAgentVerdict } from '../src/index';

function block(payload: unknown, tag = 'json'): string {
  return ['Some reasoning.', '', '```' + tag, JSON.stringify(payload), '```'].join('\n');
}

describe('parseAgentVerdict — structured', () => {
  it('reads an approve block', () => {
    expect(parseAgentVerdict(block({ verdict: 'approve' }))).toEqual({
      decision: 'approve',
      source: 'structured',
    });
  });

  it('reads request_changes with its summary and findings', () => {
    const verdict = parseAgentVerdict(
      block({ verdict: 'request_changes', summary: 'missing tests', findings: ['no unit test'] }),
    );
    expect(verdict).toEqual({
      decision: 'request_changes',
      source: 'structured',
      summary: 'missing tests',
      findings: ['no unit test'],
    });
  });

  it('reads reject', () => {
    expect(parseAgentVerdict(block({ verdict: 'reject', summary: 'wrong approach' }))).toMatchObject(
      { decision: 'reject', source: 'structured', summary: 'wrong approach' },
    );
  });

  it('accepts the documented aliases', () => {
    expect(parseAgentVerdict(block({ verdict: 'pass' })).decision).toBe('approve');
    expect(parseAgentVerdict(block({ verdict: 'ok' })).decision).toBe('approve');
    expect(parseAgentVerdict(block({ verdict: 'changes_requested' })).decision).toBe(
      'request_changes',
    );
    expect(parseAgentVerdict(block({ verdict: 'changes' })).decision).toBe('request_changes');
    expect(parseAgentVerdict(block({ verdict: 'fail' })).decision).toBe('reject');
    expect(parseAgentVerdict(block({ verdict: 'APPROVE' })).decision).toBe('approve');
  });

  it('uses the LAST block that carries a verdict', () => {
    const summary = [
      block({ verdict: 'approve' }),
      '',
      'After re-reading the diff:',
      block({ verdict: 'request_changes', summary: 'the migration drops data' }),
    ].join('\n');
    expect(parseAgentVerdict(summary)).toMatchObject({
      decision: 'request_changes',
      source: 'structured',
      summary: 'the migration drops data',
    });
  });

  it('ignores blocks that are not JSON or carry no verdict', () => {
    const summary = [
      '```json',
      '{not json}',
      '```',
      '',
      '```json',
      '{"summary":"no verdict key"}',
      '```',
      '',
      '```ts',
      '{"verdict":"approve"}',
      '```',
    ].join('\n');
    expect(parseAgentVerdict(summary)).toEqual({ decision: 'unknown', source: 'none' });
  });

  it('ignores an unknown structured verdict and falls through to text', () => {
    const summary = [block({ verdict: 'lgtm' }), '', 'VERDICT: FAIL'].join('\n');
    expect(parseAgentVerdict(summary)).toMatchObject({
      decision: 'request_changes',
      source: 'textual',
    });
  });

  it('does not fall back to an earlier approval when the last block is unreadable', () => {
    const summary = [block({ verdict: 'approve' }), '', block({ verdict: 'lgtm' })].join('\n');
    expect(parseAgentVerdict(summary)).toEqual({ decision: 'unknown', source: 'none' });
  });
});

describe('parseAgentVerdict — textual fallback', () => {
  it('maps VERDICT: FAIL to request_changes', () => {
    const verdict = parseAgentVerdict('Reviewed the change.\n\nVERDICT: FAIL\nmissing tests');
    expect(verdict.decision).toBe('request_changes');
    expect(verdict.source).toBe('textual');
  });

  it('maps a line starting with FAIL to request_changes', () => {
    expect(parseAgentVerdict('FAIL: the migration is unsafe')).toMatchObject({
      decision: 'request_changes',
      source: 'textual',
    });
  });

  it('maps REQUEST_CHANGES to request_changes', () => {
    expect(parseAgentVerdict('Decision: REQUEST_CHANGES — add a regression test')).toMatchObject({
      decision: 'request_changes',
      source: 'textual',
    });
  });

  it('maps VERDICT: PASS / APPROVE to approve', () => {
    expect(parseAgentVerdict('VERDICT: PASS')).toMatchObject({
      decision: 'approve',
      source: 'textual',
    });
    expect(parseAgentVerdict('VERDICT: APPROVE')).toMatchObject({
      decision: 'approve',
      source: 'textual',
    });
  });

  it('lets the last textual signal win', () => {
    expect(parseAgentVerdict('VERDICT: PASS\n\nActually:\nVERDICT: FAIL')).toMatchObject({
      decision: 'request_changes',
      source: 'textual',
    });
  });

  it('only scans the last ~40 lines', () => {
    const summary = ['VERDICT: FAIL', ...Array.from({ length: 40 }, () => 'no signal here')].join(
      '\n',
    );
    expect(parseAgentVerdict(summary)).toEqual({ decision: 'unknown', source: 'none' });
  });
});

describe('parseAgentVerdict — unknown', () => {
  it('returns unknown/none for an empty or missing summary', () => {
    expect(parseAgentVerdict()).toEqual({ decision: 'unknown', source: 'none' });
    expect(parseAgentVerdict('')).toEqual({ decision: 'unknown', source: 'none' });
    expect(parseAgentVerdict('   \n  ')).toEqual({ decision: 'unknown', source: 'none' });
  });

  it('returns unknown/none when the summary carries no verdict', () => {
    expect(parseAgentVerdict('Implemented the change and ran the tests.')).toEqual({
      decision: 'unknown',
      source: 'none',
    });
  });
});
