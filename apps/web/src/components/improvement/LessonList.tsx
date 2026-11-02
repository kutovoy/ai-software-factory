'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { formatConfidence } from '@/lib/improvement';
import type { LessonWire } from '@/lib/types';

/**
 * Experience library: per-factory lessons with confidence, evidence and an opt-in
 * promotion into the shared library. Another factory only sees a lesson after this
 * explicit promotion (spec: Isolation).
 */
export function LessonList({
  factoryId,
  factoryKey,
  lessons,
}: {
  /** Factory id used for the nested API path (change `unify-factory-api`). */
  factoryId: string;
  /** Internal factory key recorded on a lesson; used only to tell own vs promoted. */
  factoryKey: string;
  lessons: LessonWire[];
}) {
  const router = useRouter();
  const [actor, setActor] = useState('local-user');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const promote = async (lesson: LessonWire): Promise<void> => {
    setError(null);
    setBusy(lesson.id);
    try {
      const response = await fetch(
        `/api/v1/factories/${encodeURIComponent(factoryId)}/lessons/${encodeURIComponent(lesson.id)}/promote`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            actor: actor.trim() || 'local-user',
            reason: 'promote to shared library',
          }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
      if (!response.ok) {
        throw new Error(payload.message ?? payload.code ?? `promotion failed (${response.status})`);
      }
      router.refresh();
    } catch (promoteError) {
      setError(promoteError instanceof Error ? promoteError.message : String(promoteError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="improvement-lessons" className="space-y-3">
      <label className="text-xs text-slate-600">
        Approver
        <input
          data-testid="improvement-lesson-actor"
          value={actor}
          onChange={(event) => setActor(event.target.value)}
          className="mt-1 block w-40 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
        />
      </label>

      {lessons.length === 0 ? (
        <p data-testid="improvement-lessons-empty" className="text-xs text-slate-500">
          No lessons yet. A proposal decision appends one to this factory&apos;s INDEX.md +
          EXPERIENCE.md; nothing is invented for an empty library.
        </p>
      ) : (
        <ul className="space-y-2">
          {lessons.map((lesson) => {
            const own = lesson.factory === factoryKey;
            return (
              <li
                key={lesson.id}
                data-testid="improvement-lesson"
                className="rounded-lg border border-slate-200 bg-white px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-mono text-xs font-semibold text-slate-900">{lesson.cue}</p>
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral" mono>
                      confidence {formatConfidence(lesson.confidence)}
                    </Badge>
                    {lesson.promoted ? (
                      <Badge tone="success" testId="improvement-lesson-promoted">
                        shared
                      </Badge>
                    ) : own ? (
                      <Badge tone="warning" testId="improvement-lesson-private">
                        {lesson.factory} only
                      </Badge>
                    ) : (
                      <Badge tone="neutral">{lesson.factory}</Badge>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-xs text-slate-700">{lesson.lesson}</p>
                <p className="mt-1 text-[11px] text-slate-500">
                  Origin: {lesson.originFactory}
                  {lesson.promotedBy ? ` · promoted by ${lesson.promotedBy}` : ''}
                </p>
                {own && !lesson.promoted ? (
                  <button
                    data-testid="improvement-lesson-promote"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void promote(lesson)}
                    className="mt-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-800 disabled:opacity-50"
                  >
                    {busy === lesson.id ? 'Promoting…' : 'Promote to shared library'}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {error ? (
        <p data-testid="improvement-lessons-error" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
