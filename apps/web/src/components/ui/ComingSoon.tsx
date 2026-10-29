import { Badge } from './Badge';
import { Card, CardBody, CardHeader } from './Card';

/**
 * Every not-yet-shipped page renders this: it names the phase that will fill it and
 * states what the page will show, so nothing looks broken or fabricated (spec:
 * "Unimplemented page").
 */
export function ComingSoon({
  title,
  phase,
  description,
  bullets = [],
}: {
  title: string;
  phase: string;
  description: string;
  bullets?: string[];
}) {
  return (
    <Card testId="coming-soon">
      <CardHeader title={title} hint="Read-only projection of the git-backed definition — nothing is editable here." />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info" testId="coming-soon-phase">
            {phase}
          </Badge>
          <span className="text-sm text-slate-500">Not built yet.</span>
        </div>
        <p className="max-w-prose text-sm text-slate-700">{description}</p>
        {bullets.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
            {bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}
