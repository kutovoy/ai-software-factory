'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import {
  evidenceLines,
  formatImpact,
  proposalStatusLabel,
  proposalStatusTone,
} from '@/lib/improvement';
import type { ProposalWire } from '@/lib/types';

/**
 * One ranked proposal: impact, evidence, the diff of the composed candidate, per-edit
 * probe results, and the accept / reject / apply actions. Applying routes by the authority
 * recorded on the proposal; a canary proposal reports `canary_not_available` (Phase 5b).
 */
export function ProposalCard({
  factoryId,
  proposal,
}: {
  factoryId: string;
  proposal: ProposalWire;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'accept' | 'reject' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const post = async (path: string, body: Record<string, unknown>): Promise<void> => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      message?: string;
      code?: string;
      details?: { phase?: string };
    };
    if (!response.ok) {
      const phase = payload.details?.phase ? ` (Phase ${payload.details.phase})` : '';
      throw new Error(`${payload.message ?? payload.code ?? `request failed (${response.status})`}${phase}`);
    }
  };

  const decide = async (decision: 'accept' | 'reject'): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(decision);
    try {
      await post(
        `/api/v1/factories/${encodeURIComponent(factoryId)}/proposals/${encodeURIComponent(proposal.id)}/decision`,
        {
          decision,
          actor: 'local-user',
          reason: decision === 'accept' ? 'reviewed and accepted' : 'reviewed and rejected',
        },
      );
      setNotice(
        decision === 'accept'
          ? proposal.status === 'pr_open'
            ? 'Accepted — the pull request is already open.'
            : 'Accepted — apply it to route by authority.'
          : 'Rejected — the lesson is recorded.',
      );
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(null);
    }
  };

  const apply = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy('apply');
    try {
      await post(
        `/api/v1/factories/${encodeURIComponent(factoryId)}/proposals/${encodeURIComponent(proposal.id)}/apply`,
        {
          actor: 'local-user',
          reason: 'apply the accepted improvement',
        },
      );
      setNotice('Applied by the recorded authority.');
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(null);
    }
  };

  const evidence = evidenceLines(proposal.evidence);
  const probes = proposal.probes ?? [];
  const edits = proposal.edits ?? [];
  const decidable = proposal.status === 'open' || proposal.status === 'pr_open';

  return (
    <article
      data-testid="improvement-proposal"
      data-proposal-id={proposal.id}
      className="rounded-lg border border-slate-200 bg-white px-4 py-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{proposal.title}</h3>
          <p className="mt-0.5 text-xs text-slate-500">{proposal.summary}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" testId="improvement-proposal-impact" mono>
            impact {formatImpact(proposal.impact)}
          </Badge>
          <Badge tone={proposalStatusTone(proposal.status)} testId="improvement-proposal-status">
            {proposalStatusLabel(proposal.status)}
          </Badge>
        </div>
      </div>

      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-slate-600 md:grid-cols-2">
        <div>
          <dt className="inline font-semibold text-slate-800">Signature: </dt>
          <dd className="inline font-mono">{proposal.failureSignature}</dd>
        </div>
        <div>
          <dt className="inline font-semibold text-slate-800">Authority: </dt>
          <dd className="inline font-mono">{proposal.authority}</dd>
        </div>
        {proposal.candidateHash ? (
          <div>
            <dt className="inline font-semibold text-slate-800">Candidate: </dt>
            <dd className="inline font-mono">{proposal.candidateHash.slice(0, 12)}</dd>
          </div>
        ) : null}
        {proposal.prUrl ? (
          <div>
            <dt className="inline font-semibold text-slate-800">PR: </dt>
            <dd className="inline">
              <a href={proposal.prUrl} className="underline decoration-slate-300 underline-offset-2">
                #{proposal.prNumber}
              </a>
            </dd>
          </div>
        ) : null}
      </dl>

      {evidence.length > 0 ? (
        <ul data-testid="improvement-proposal-evidence" className="mt-2 space-y-0.5 text-xs text-slate-600">
          {evidence.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-slate-500">No evidence recorded.</p>
      )}

      {proposal.files.length > 0 ? (
        <p className="mt-2 text-xs text-slate-600">
          <span className="font-semibold text-slate-800">Files: </span>
          <span className="font-mono">{proposal.files.join(', ')}</span>
        </p>
      ) : null}

      {probes.length > 0 ? (
        <div data-testid="improvement-proposal-probes" className="mt-3">
          <p className="text-xs font-semibold text-slate-800">Contrastive probes</p>
          <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
            {probes.map((probe) => {
              const edit = edits.find((entry) => entry.id === probe.editId);
              return (
                <li key={probe.id} className="font-mono">
                  {edit?.path ?? probe.editId} · baseline {probe.baselineScore ?? '—'} → candidate{' '}
                  {probe.candidateScore ?? '—'} · Δ {probe.delta ?? '—'} ·{' '}
                  {probe.winner ? 'winner' : 'no signal'}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p data-testid="improvement-proposal-probes-empty" className="mt-3 text-xs text-slate-500">
          No probe has run for this proposal yet.
        </p>
      )}

      {edits.length > 0 ? (
        <details data-testid="improvement-proposal-edits" className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-800">
            Edits ({edits.length})
          </summary>
          <ul className="mt-1 space-y-1 text-xs text-slate-600">
            {edits.map((edit) => (
              <li key={edit.id} className={edit.rejected ? 'text-slate-400' : ''}>
                <span className="font-mono">{edit.kind}</span> ·{' '}
                <span className="font-mono">{edit.path}</span> · {edit.scope}
                {edit.rejected ? ` · rejected: ${edit.rejectionCode ?? 'unknown'}` : ''}
                <p className="mt-0.5">{edit.rationale}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {proposal.diff.length > 0 ? (
        <details data-testid="improvement-proposal-diff" className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-800">
            Candidate diff ({proposal.diff.length} file{proposal.diff.length === 1 ? '' : 's'})
          </summary>
          <div className="mt-2 space-y-3">
            {proposal.diff.map((entry) => (
              <div key={entry.path} className="rounded border border-slate-200 bg-slate-50 p-2">
                <p className="font-mono text-[11px] font-semibold text-slate-800">{entry.path}</p>
                <div className="mt-1 grid gap-2 md:grid-cols-2">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">before</p>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-slate-700">
                      {entry.before}
                    </pre>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">after</p>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-slate-900">
                      {entry.after}
                    </pre>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : (
        <p data-testid="improvement-proposal-diff-empty" className="mt-3 text-xs text-slate-500">
          No composed candidate: no edit improved the contrastive signal.
        </p>
      )}

      {proposal.decisionReason ? (
        <p className="mt-2 text-xs text-slate-600">
          <span className="font-semibold text-slate-800">Decision: </span>
          {proposal.decisionActor ?? 'unknown'} — {proposal.decisionReason}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          data-testid="improvement-proposal-accept"
          type="button"
          disabled={!decidable || busy !== null}
          onClick={() => void decide('accept')}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          {busy === 'accept' ? 'Accepting…' : 'Accept'}
        </button>
        <button
          data-testid="improvement-proposal-reject"
          type="button"
          disabled={!decidable || busy !== null}
          onClick={() => void decide('reject')}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 disabled:opacity-40"
        >
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
        <button
          data-testid="improvement-proposal-apply"
          type="button"
          disabled={proposal.status !== 'accepted' || busy !== null}
          onClick={() => void apply()}
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-900 disabled:opacity-40"
        >
          {busy === 'apply' ? 'Applying…' : 'Apply by authority'}
        </button>
      </div>

      {error ? (
        <p data-testid="improvement-proposal-error" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p data-testid="improvement-proposal-notice" className="mt-2 text-xs text-emerald-800">
          {notice}
        </p>
      ) : null}
    </article>
  );
}
