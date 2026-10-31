import type { HelpDiagramName } from '@/lib/help';

/**
 * Hand-built diagrams for the quick start (`web-console` spec: "Quick start").
 * No diagram dependency: the pipeline is one inline SVG, the other two are CSS boxes,
 * so they stay crisp, theme-neutral and impossible to break at 1280px.
 */

const PIPELINE_STAGES = [
  { title: 'Intake', detail: 'work item', sub: 'manual · webhook · cron' },
  { title: 'Loop', detail: 'triage → ship', sub: 'one child run per stage' },
  { title: 'Gates', detail: 'durable waits', sub: 'human · agent · policy' },
  { title: 'Merge', detail: 'PR or queue', sub: 'the only merge point' },
  { title: 'Score', detail: 'scorers', sub: 'deterministic · judge' },
  { title: 'Improve', detail: 'proposals', sub: 'propose · PR · canary' },
];

function PipelineDiagram() {
  const boxWidth = 132;
  const gap = 18;
  const startX = 8;
  const y = 26;
  const height = 62;
  const width = startX * 2 + PIPELINE_STAGES.length * boxWidth + (PIPELINE_STAGES.length - 1) * gap;

  return (
    <svg
      data-testid="diagram-pipeline"
      role="img"
      aria-label="Pipeline diagram: intake, loop, gates, merge, score, improve"
      viewBox={`0 0 ${width} ${height + 54}`}
      className="h-auto w-full"
      xmlns="http://www.w3.org/2000/svg"
    >
      {PIPELINE_STAGES.map((stage, index) => {
        const x = startX + index * (boxWidth + gap);
        return (
          <g key={stage.title}>
            <rect
              x={x}
              y={y}
              width={boxWidth}
              height={height}
              rx={10}
              className="fill-slate-50 stroke-slate-300"
              strokeWidth={1}
            />
            <text x={x + 12} y={y + 20} className="fill-slate-900" fontSize={13} fontWeight={600}>
              {stage.title}
            </text>
            <text x={x + 12} y={y + 37} className="fill-slate-600" fontSize={11}>
              {stage.detail}
            </text>
            <text x={x + 12} y={y + 52} className="fill-slate-400" fontSize={9}>
              {stage.sub}
            </text>
            {index < PIPELINE_STAGES.length - 1 ? (
              <g>
                <line
                  x1={x + boxWidth + 3}
                  y1={y + height / 2}
                  x2={x + boxWidth + gap - 4}
                  y2={y + height / 2}
                  className="stroke-slate-400"
                  strokeWidth={1.5}
                />
                <path
                  d={`M ${x + boxWidth + gap - 4} ${y + height / 2 - 4} L ${x + boxWidth + gap + 1} ${y + height / 2} L ${x + boxWidth + gap - 4} ${y + height / 2 + 4}`}
                  className="fill-none stroke-slate-400"
                  strokeWidth={1.5}
                />
              </g>
            ) : null}
          </g>
        );
      })}
      <text x={startX} y={height + 46} className="fill-slate-500" fontSize={11}>
        Every stage transition is an event; a gate parks the workflow without holding an activity slot.
      </text>
    </svg>
  );
}

const ANATOMY_COLUMNS = [
  {
    title: 'Files (git)',
    tone: 'bg-slate-50 border-slate-300',
    items: ['factory.yaml', 'agents/*/agent.md', 'automations/', 'scorers/', 'benchmarks/', 'skills/', 'runners/', 'routing.yaml'],
  },
  {
    title: 'Resources (resolved)',
    tone: 'bg-sky-50 border-sky-200',
    items: ['manifest', 'resolved models', 'gates + merge policy', 'improvement authority', 'MCP servers', 'canonical file list'],
  },
  {
    title: 'Agents (bound)',
    tone: 'bg-emerald-50 border-emerald-200',
    items: ['harness', 'runner', 'model', 'tools', 'MCP bindings', 'stage role'],
  },
];

function AnatomyDiagram() {
  return (
    <div data-testid="diagram-anatomy" className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        {ANATOMY_COLUMNS.map((column, index) => (
          <div key={column.title} className="flex min-w-0 flex-1 items-stretch gap-2">
            <div className={`min-w-0 flex-1 rounded-lg border px-3 py-2 ${column.tone}`}>
              <p className="text-xs font-semibold text-slate-800">{column.title}</p>
              <ul className="mt-1 space-y-0.5 text-[11px] leading-4 text-slate-600">
                {column.items.map((item) => (
                  <li key={item} className="truncate font-mono">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            {index < ANATOMY_COLUMNS.length - 1 ? (
              <span aria-hidden="true" className="self-center text-slate-400">
                →
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        Loading validates the files and resolves them into resources; an agent binds those resources to a harness,
        runner, model and tool set. The console renders this projection — it never writes the files.
      </p>
    </div>
  );
}

const GATE_LEVELS = [
  { title: 'Automation override', detail: 'the work this automation starts', tone: 'bg-amber-50 border-amber-200' },
  { title: 'Factory gate', detail: 'gates.stages in factory.yaml', tone: 'bg-slate-50 border-slate-300' },
  { title: 'Global default', detail: 'used when neither declares one', tone: 'bg-slate-50 border-slate-200' },
];

function GatesDiagram() {
  return (
    <div data-testid="diagram-gates" className="space-y-2">
      {GATE_LEVELS.map((level, index) => (
        <div key={level.title} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold text-white"
          >
            {index + 1}
          </span>
          <div className={`min-w-0 flex-1 rounded-lg border px-3 py-1.5 ${level.tone}`}>
            <p className="text-xs font-semibold text-slate-800">{level.title}</p>
            <p className="text-[11px] text-slate-600">{level.detail}</p>
          </div>
        </div>
      ))}
      <p className="text-xs text-slate-500">
        First match wins. A gate is <span className="font-mono">human</span>,{' '}
        <span className="font-mono">agent</span> or <span className="font-mono">policy:&lt;name&gt;</span>; the Gates
        page shows the resolved value and its source per stage.
      </p>
    </div>
  );
}

export function HelpDiagram({ name }: { name: HelpDiagramName }) {
  if (name === 'pipeline') return <PipelineDiagram />;
  if (name === 'anatomy') return <AnatomyDiagram />;
  return <GatesDiagram />;
}
