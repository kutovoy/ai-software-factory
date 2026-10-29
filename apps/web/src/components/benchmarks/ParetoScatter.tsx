import type { BenchmarkResultWire } from '@/lib/types';

/**
 * Correctness-vs-cost Pareto scatter (ADR-019: report the frontier, not a single score).
 * Pure SVG so it renders in a server component; frontier points are filled, dominated ones
 * hollow, and every point is labelled with its configuration name.
 */
export function ParetoScatter({
  results,
  frontier,
}: {
  results: BenchmarkResultWire[];
  frontier: string[];
}) {
  const points = results.filter((result) => result.passRate !== null);
  if (points.length === 0) {
    return (
      <p data-testid="benchmark-pareto-empty" className="text-xs text-slate-500">
        No configuration has a sample yet, so there is no pass-rate-versus-cost frontier.
      </p>
    );
  }

  const width = 560;
  const height = 240;
  const padX = 56;
  const padY = 28;
  const maxCost = Math.max(0.01, ...points.map((point) => point.costUsd));
  const plotWidth = width - padX * 2;
  const plotHeight = height - padY * 2;

  const x = (cost: number): number => padX + (cost / maxCost) * plotWidth;
  const y = (passRate: number): number => padY + (1 - passRate) * plotHeight;

  return (
    <svg
      data-testid="benchmark-pareto"
      role="img"
      aria-label="Pass rate versus cost"
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full max-w-2xl"
    >
      <line x1={padX} y1={padY} x2={padX} y2={padY + plotHeight} stroke="#cbd5e1" />
      <line
        x1={padX}
        y1={padY + plotHeight}
        x2={padX + plotWidth}
        y2={padY + plotHeight}
        stroke="#cbd5e1"
      />
      <text x={padX - 8} y={padY + 4} textAnchor="end" fontSize="10" fill="#64748b">
        100%
      </text>
      <text x={padX - 8} y={padY + plotHeight} textAnchor="end" fontSize="10" fill="#64748b">
        0%
      </text>
      <text x={padX + plotWidth / 2} y={height - 6} textAnchor="middle" fontSize="10" fill="#64748b">
        cost (USD)
      </text>
      <text x={12} y={padY + plotHeight / 2} textAnchor="middle" fontSize="10" fill="#64748b" transform={`rotate(-90 12 ${padY + plotHeight / 2})`}>
        pass rate
      </text>

      {points.map((point) => {
        const isFrontier = frontier.includes(point.configuration);
        const cx = x(point.costUsd);
        const cy = y(point.passRate ?? 0);
        return (
          <g key={point.configuration} data-testid="benchmark-pareto-point" data-configuration={point.configuration} data-frontier={isFrontier ? 'true' : 'false'}>
            <circle
              cx={cx}
              cy={cy}
              r={6}
              fill={isFrontier ? '#0f766e' : '#ffffff'}
              stroke={isFrontier ? '#0f766e' : '#94a3b8'}
              strokeWidth={2}
            />
            <text x={cx + 9} y={cy + 4} fontSize="10" fill="#334155">
              {point.configuration}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
