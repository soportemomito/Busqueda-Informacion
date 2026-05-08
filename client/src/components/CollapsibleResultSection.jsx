import { useState } from 'react';

export function CollapsibleResultSection({
  title,
  subtitle,
  badge,
  defaultOpen,
  children,
  error,
  dense,
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  const pad = dense ? 'px-3 py-2.5' : 'px-4 py-3';
  const bodyPad = dense ? 'px-1.5 py-1.5' : 'px-2 py-2';

  return (
    <section className="rounded-lg border border-momo-200/90 bg-white shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center gap-2 sm:gap-3 ${pad} text-left hover:bg-momo-50/80 transition-colors`}
      >
        <span
          className={`inline-flex h-6 w-6 sm:h-7 sm:w-7 shrink-0 items-center justify-center rounded-md border text-momo-600 text-xs font-bold ${
            open ? 'bg-momo-100 border-momo-200' : 'bg-white border-momo-200'
          }`}
        >
          {open ? '−' : '+'}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className={`font-semibold text-momo-900 ${dense ? 'text-xs' : 'text-sm'}`}>{title}</h2>
            {badge != null && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-momo-100 text-momo-700">
                {badge}
              </span>
            )}
          </div>
          {subtitle && <p className="text-xs text-momo-500 mt-0.5">{subtitle}</p>}
        </div>
      </button>
      {error && (
        <div className="mx-4 mb-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2">
          {error}
        </div>
      )}
      {open && <div className={`border-t border-momo-100 ${bodyPad}`}>{children}</div>}
    </section>
  );
}

export function ExpandableRow({ summary, children, defaultExpanded, extra, dense }) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const rowPad = dense ? 'px-2 py-2' : 'px-3 py-2.5';

  return (
    <div className="rounded-md border border-momo-100 bg-momo-50/50 mb-1.5 overflow-hidden">
      <div className={`flex gap-2 items-start ${rowPad} hover:bg-momo-100/40 transition-colors`}>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-momo-400 text-xs mt-0.5 shrink-0 w-6 text-left"
          aria-expanded={expanded}
          aria-label={expanded ? 'Contraer detalle' : 'Expandir detalle'}
        >
          {expanded ? '▼' : '▶'}
        </button>
        <div
          className="flex-1 min-w-0 text-sm cursor-pointer"
          onClick={() => setExpanded((e) => !e)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setExpanded((x) => !x);
            }
          }}
          role="presentation"
        >
          {summary}
        </div>
      </div>
      {expanded && (
        <div className={`${dense ? 'px-2 pb-2' : 'px-3 pb-3'} pt-0 border-t border-momo-100/80 bg-white space-y-2`}>
          {extra}
          <pre
            className={`text-[11px] text-momo-800 whitespace-pre-wrap break-words overflow-auto mt-2 p-2 rounded bg-momo-50 border border-momo-100 ${
              dense ? 'max-h-48' : 'max-h-80'
            }`}
          >
            {children}
          </pre>
        </div>
      )}
    </div>
  );
}
