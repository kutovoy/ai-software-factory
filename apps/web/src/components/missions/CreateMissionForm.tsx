'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Mission creation (`POST /factories/:id/missions`).
 *
 * The API pins the definition commit, starts `MissionWorkflow` and returns the mission plus
 * its workflow. The planner then proposes a plan and the mission parks on the plan gate, so
 * the form navigates straight to the detail page where the approval lives. Budget caps are
 * optional: an empty field means "no mission cap", not zero.
 */
export function CreateMissionForm({ factoryId }: { factoryId: string }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [maxCostUsd, setMaxCostUsd] = useState('');
  const [maxRuns, setMaxRuns] = useState('');
  const [maxWallClockHours, setMaxWallClockHours] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const positiveNumber = (value: string): number | undefined => {
    const parsed = Number(value);
    return value.trim() !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError('a title is required');
      return;
    }
    if (!goal.trim()) {
      setError('a goal is required: the planner decomposes it into milestones and features');
      return;
    }

    const budget = {
      ...(positiveNumber(maxCostUsd) === undefined ? {} : { maxCostUsd: positiveNumber(maxCostUsd) }),
      ...(positiveNumber(maxRuns) === undefined ? {} : { maxRuns: positiveNumber(maxRuns) }),
      ...(positiveNumber(maxWallClockHours) === undefined
        ? {}
        : { maxWallClockHours: positiveNumber(maxWallClockHours) }),
    };

    setBusy(true);
    try {
      const response = await fetch(`/api/v1/factories/${encodeURIComponent(factoryId)}/missions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          goal: goal.trim(),
          ...(Object.keys(budget).length > 0 ? { budget } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
        mission?: { id?: string };
      };
      if (!response.ok) {
        throw new Error(body.message ?? body.code ?? `mission creation failed (${response.status})`);
      }
      const id = body.mission?.id;
      if (!id) throw new Error('the API did not return a mission id');
      router.push(`/factories/${encodeURIComponent(factoryId)}/missions/${encodeURIComponent(id)}`);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      data-testid="mission-create"
      onSubmit={(event) => void submit(event)}
      className="space-y-3"
    >
      <label className="block text-xs text-slate-600">
        Title
        <input
          data-testid="mission-create-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Ship the billing migration"
          className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
      </label>

      <label className="block text-xs text-slate-600">
        Goal
        <textarea
          data-testid="mission-create-goal"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          rows={3}
          placeholder="What should exist when the mission is done? The planner writes the validation contract and features from this."
          className="mt-1 block w-full resize-y rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
      </label>

      <fieldset className="rounded-lg border border-slate-200 px-3 py-2">
        <legend className="px-1 text-xs font-medium text-slate-600">
          Budget caps (optional — empty means no mission cap)
        </legend>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-600">
            Max spend (USD)
            <input
              data-testid="mission-create-max-cost"
              type="number"
              min="0"
              step="0.01"
              value={maxCostUsd}
              onChange={(event) => setMaxCostUsd(event.target.value)}
              placeholder="no cap"
              className="mt-1 block w-32 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-slate-600">
            Max runs
            <input
              data-testid="mission-create-max-runs"
              type="number"
              min="1"
              step="1"
              value={maxRuns}
              onChange={(event) => setMaxRuns(event.target.value)}
              placeholder="no cap"
              className="mt-1 block w-28 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-slate-600">
            Max wall-clock hours
            <input
              data-testid="mission-create-max-hours"
              type="number"
              min="0"
              step="0.5"
              value={maxWallClockHours}
              onChange={(event) => setMaxWallClockHours(event.target.value)}
              placeholder="no cap"
              className="mt-1 block w-32 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          data-testid="mission-create-submit"
          disabled={busy}
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create mission'}
        </button>
        <p className="text-xs text-slate-500">
          The mission starts in <span className="font-mono">planning</span>; approve its plan
          before features are dispatched.
        </p>
      </div>

      {error ? (
        <p data-testid="mission-create-error" role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </form>
  );
}
