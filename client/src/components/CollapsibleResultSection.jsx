import { useState } from 'react';

export function CollapsibleResultSection({ title, subtitle, badge, defaultOpen, children, error, dense }) {
  const [open, setOpen] = useState(defaultOpen ?? true);

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
      >
        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
          <h2 className={`font-bold text-slate-800 ${dense ? 'text-xs' : 'text-sm'}`}>{title}</h2>
          {badge != null && badge > 0 && (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-momo-100 text-momo-700">
              {badge}
            </span>
          )}
          {subtitle && <span className={`text-slate-400 font-normal ${dense ? 'text-[10px]' : 'text-xs'}`}>— {subtitle}</span>}
        </div>
        <span className={`text-slate-400 transition-transform ${open ? 'rotate-180' : ''} text-xs`}>▼</span>
      </button>
      {error && (
        <div className="mx-4 mb-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs px-3 py-2">
          {error}
        </div>
      )}
      {open && <div className="border-t border-slate-100 divide-y divide-slate-50">{children}</div>}
    </section>
  );
}

export function ExpandableRow({ summary, children, defaultExpanded, extra, dense }) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);

  return (
    <div className="px-4 py-3">
      <div className="flex gap-2 items-start">
        <div className="flex-1 min-w-0">{summary}</div>
        {children && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="text-[10px] text-slate-400 hover:text-slate-600 shrink-0 mt-0.5 border border-slate-200 rounded px-1.5 py-0.5"
            aria-expanded={expanded}
          >
            {expanded ? 'ocultar' : 'detalle'}
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-3 space-y-2">
          {extra}
          <pre className="text-[10px] text-slate-600 whitespace-pre-wrap break-words overflow-auto max-h-48 p-2 rounded-lg bg-slate-50 border border-slate-200">
            {children}
          </pre>
        </div>
      )}
      {!expanded && extra && <div className="mt-2 space-y-2">{extra}</div>}
    </div>
  );
}
