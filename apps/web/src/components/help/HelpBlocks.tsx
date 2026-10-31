import type { HelpBlock, HelpCalloutTone, HelpLink } from '@/lib/help';
import { HelpDiagram } from './Diagrams';

const CALLOUT_TONES: Record<HelpCalloutTone, string> = {
  info: 'border-sky-200 bg-sky-50 text-sky-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
};

function CodeBlock({ label, text }: { label?: string; text: string }) {
  return (
    <figure className="min-w-0">
      {label ? <figcaption className="mb-1 text-xs font-medium text-slate-500">{label}</figcaption> : null}
      <pre
        data-testid="help-code"
        className="max-w-full overflow-x-auto rounded-lg bg-slate-900 px-4 py-3 text-xs leading-5 text-slate-100"
      >
        <code>{text}</code>
      </pre>
    </figure>
  );
}

/** Renders the typed content model. Server component: no client JS for prose. */
export function HelpBlocks({ blocks }: { blocks: HelpBlock[] }) {
  return (
    <div className="space-y-4">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'prose':
            return (
              <p key={index} className="max-w-prose text-sm leading-6 text-slate-700">
                {block.text}
              </p>
            );
          case 'list':
            return (
              <ul key={index} className="max-w-prose list-disc space-y-1.5 pl-5 text-sm leading-6 text-slate-700">
                {block.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            );
          case 'code':
            return <CodeBlock key={index} label={block.label} text={block.text} />;
          case 'callout':
            return (
              <div
                key={index}
                data-testid="help-callout"
                className={`rounded-xl border px-4 py-3 text-sm ${CALLOUT_TONES[block.tone]}`}
              >
                <p className="font-semibold">{block.title}</p>
                <p className="mt-1 max-w-prose text-xs leading-5">{block.text}</p>
              </div>
            );
          case 'diagram':
            return (
              <figure key={index} className="min-w-0 rounded-xl border border-slate-200 bg-white px-4 py-4">
                <HelpDiagram name={block.name} />
                <figcaption className="mt-3 text-xs text-slate-500">{block.caption}</figcaption>
              </figure>
            );
          case 'steps':
            return (
              <ol key={index} className="space-y-3">
                {block.items.map((step, stepIndex) => (
                  <li key={step.title} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                    <p className="flex items-baseline gap-2 text-sm font-semibold text-slate-900">
                      <span
                        aria-hidden="true"
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold text-white"
                      >
                        {stepIndex + 1}
                      </span>
                      {step.title}
                    </p>
                    {step.detail ? (
                      <p className="mt-1.5 max-w-prose text-xs leading-5 text-slate-600">{step.detail}</p>
                    ) : null}
                    {step.command ? (
                      <div className="mt-2">
                        <CodeBlock text={step.command} />
                      </div>
                    ) : null}
                    {step.expected ? (
                      <p data-testid="help-step-expected" className="mt-2 text-xs leading-5 text-slate-700">
                        <span className="font-semibold text-emerald-700">Expected:</span> {step.expected}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            );
          case 'checklist':
            return (
              <div key={index} className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                <p className="text-sm font-semibold text-emerald-900">{block.title}</p>
                <ul data-testid="help-checklist" className="mt-2 space-y-1.5 text-xs leading-5 text-emerald-900">
                  {block.items.map((item) => (
                    <li key={item} className="flex gap-2">
                      <span aria-hidden="true">✓</span>
                      <span className="min-w-0">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

export function RelatedLinks({ links }: { links: HelpLink[] }) {
  if (links.length === 0) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
      <h2 className="text-sm font-semibold text-slate-900">Related</h2>
      <ul className="mt-2 space-y-1 text-sm">
        {links.map((link) => (
          <li key={`${link.href}:${link.label}`}>
            <a
              href={link.href}
              data-testid="help-related-link"
              className="text-slate-700 underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
