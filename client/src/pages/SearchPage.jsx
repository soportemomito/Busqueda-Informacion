import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSearch, resolveChatwootConversation, fetchContactPreview, fetchConversationSummary } from '../api/client.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { useChatwootDashboardContext, isDashboardEmbed } from '../hooks/useChatwootDashboardContext.js';
import { CollapsibleResultSection } from '../components/CollapsibleResultSection.jsx';

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatUnix(ts) {
  if (ts == null) return '—';
  const n = Number(ts);
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

function formatIso(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function chatwootConversationUrl(app, conversationId) {
  if (!app?.baseUrl || conversationId == null) return null;
  return `${app.baseUrl}/app/accounts/${app.accountId}/conversations/${conversationId}`;
}

function copyText(text, onCopied) {
  const t = String(text || '').trim();
  if (!t) return;

  // 1. Intentar con execCommand (funciona de forma síncrona en iframes cross-origin bajo evento click)
  try {
    const el = document.createElement('textarea');
    el.value = t;
    el.setAttribute('readonly', '');
    el.style.position = 'absolute';
    el.style.left = '-9999px';
    document.body.appendChild(el);

    const selected = document.getSelection().rangeCount > 0
      ? document.getSelection().getRangeAt(0)
      : false;

    el.select();
    const success = document.execCommand('copy');
    document.body.removeChild(el);

    if (success) {
      if (selected) {
        document.getSelection().removeAllRanges();
        document.getSelection().addRange(selected);
      }
      if (onCopied) onCopied(t);
      return;
    }
  } catch (e) {
    // continuar al fallback
  }

  // 2. Fallback a navigator.clipboard
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t)
      .then(() => {
        if (onCopied) onCopied(t);
      })
      .catch(() => {
        // Silencioso, evitamos prompt molesto
      });
  }
}

function statusBadge(status, isOpen) {
  if (isOpen) return { label: 'Abierto', cls: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
  if (status === 'pending') return { label: 'Pendiente', cls: 'bg-amber-100 text-amber-800 border-amber-200' };
  return { label: 'Resuelto', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
}

// ─── native chatwoot actions ──────────────────────────────────────────────────

async function postPrivateNote(convId, noteText) {
  const res = await fetch(`/api/chatwoot/conversations/${convId}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: noteText }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'No se pudo enviar la nota interna');
  }
  return res.json();
}

async function postConversationLabels(convId, labelsList) {
  const res = await fetch(`/api/chatwoot/conversations/${convId}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels: labelsList }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'No se pudieron actualizar las etiquetas');
  }
  return res.json();
}

// ─── source status strip ───────────────────────────────────────────────────────

function deriveSourceStatuses(data, meta) {
  const items = [];
  const cw = data?.chatwoot;
  const bs = data?.bsale;
  const sh = data?.shopify;

  items.push(cw?.status === 'error'
    ? { id: 'chatwoot', label: 'Chatwoot', tone: 'error', title: cw.error }
    : { id: 'chatwoot', label: 'Chatwoot', tone: 'ok', title: `${meta?.sources?.chatwoot?.conversations ?? 0} conversaciones` });

  items.push(bs?.status === 'error'
    ? { id: 'bsale', label: 'Bsale', tone: 'error', title: bs.error }
    : { id: 'bsale', label: 'Bsale', tone: 'ok', title: `${meta?.sources?.bsale?.documents ?? 0} documentos` });

  items.push(sh?.status === 'error'
    ? { id: 'shopify', label: 'Shopify', tone: 'error', title: sh.error }
    : sh?.data?.skipped
    ? { id: 'shopify', label: 'Shopify', tone: 'skip', title: 'Sin pedido para buscar' }
    : { id: 'shopify', label: 'Shopify', tone: 'ok', title: `${meta?.sources?.shopify?.orders ?? 0} pedidos` });

  return items;
}

function SourceStatusBar({ data, meta }) {
  if (!data || !meta) return null;
  const items = deriveSourceStatuses(data, meta);
  const dot = { ok: 'bg-emerald-500 shadow-sm shadow-emerald-400/50', error: 'bg-red-500 shadow-sm shadow-red-400/50', warn: 'bg-amber-400 shadow-sm shadow-amber-400/50', skip: 'bg-slate-300' };
  const pill = { ok: 'border-emerald-100 bg-emerald-50/50 text-emerald-800', error: 'border-red-100 bg-red-50/50 text-red-700', warn: 'border-amber-100 bg-amber-50/50 text-amber-800', skip: 'border-slate-100 bg-slate-50/50 text-slate-400' };
  return (
    <div className="flex flex-wrap gap-1.5 mb-4 animate-fade-in">
      {items.map((it) => (
        <span key={it.id} title={it.title} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-all hover:scale-105 duration-200 cursor-default ${pill[it.tone]}`}>
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dot[it.tone]}`} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

// ─── copy animation chip ─────────────────────────────────────────────────────

function CopyableValue({ value, children }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    copyText(value, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <span className="inline-flex items-center gap-1.5 group relative">
      <span className="text-slate-900 break-all">{children || value}</span>
      <button
        type="button"
        onClick={handleCopy}
        className={`shrink-0 p-1 rounded-md transition-all ${
          copied 
            ? 'bg-emerald-100 text-emerald-700 scale-110' 
            : 'text-slate-300 hover:text-momo-600 hover:bg-momo-50'
        }`}
        title={copied ? '¡Copiado!' : 'Copiar'}
      >
        {copied ? (
          <span className="text-[10px] font-bold px-0.5">✓</span>
        ) : (
          <span className="text-xs">⧉</span>
        )}
      </button>
    </span>
  );
}



// ─── open tickets ─────────────────────────────────────────────────────────────

function SectionOpenTickets({ meta, onResolve, resolving, resolveError }) {
  const open = meta?.openConversations || [];
  if (!open.length) return null;
  const multiple = open.length > 1;

  return (
    <div className={`mb-4 rounded-2xl border overflow-hidden shadow-sm transition-all duration-300 ${multiple ? 'border-orange-200 bg-orange-50/20' : 'border-emerald-200 bg-emerald-50/20'}`}>
      <div className={`px-4 py-3 flex items-center gap-2 ${multiple ? 'bg-orange-500' : 'bg-emerald-600'}`}>
        <span className="text-white font-bold text-sm">
          {open.length === 1 ? '🎟️ Ticket abierto' : `🎟️ ${open.length} tickets abiertos`}
        </span>
        {multiple && <span className="text-orange-100 text-xs ml-1 font-medium bg-orange-600/50 rounded px-1.5 py-0.5 animate-pulse">— Posibles duplicados, verifica</span>}
      </div>
      <div className="bg-white divide-y divide-slate-100">
        {open.map((oc) => {
          const url = chatwootConversationUrl(meta.chatwootApp, oc.conversationId);
          return (
            <div key={oc.conversationId} className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 hover:bg-slate-50/40 transition-colors">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-slate-800 text-sm">#{oc.ticketId}</span>
                  <span className="text-xs font-semibold text-slate-500 bg-slate-100 rounded-md px-1.5 py-0.5">{oc.channel || '—'}</span>
                  <span className="text-xs text-slate-400">{formatIso(oc.date)}</span>
                </div>
                {oc.aiSummary && (
                  <p className="text-xs text-slate-600 mt-1.5 leading-relaxed line-clamp-2 bg-slate-50/80 rounded-lg p-2 border border-slate-100">{oc.aiSummary}</p>
                )}
                {oc.agent && <p className="text-[11px] text-slate-400 mt-1 font-medium">Agente asignado: <span className="text-slate-600 font-semibold">{oc.agent}</span></p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {url && (
                  <a href={url} target="_blank" rel="noreferrer"
                    className="rounded-xl bg-momo-600 text-white text-xs font-semibold px-3.5 py-2 hover:bg-momo-700 hover:shadow-md transition-all duration-200">
                    Ver en Chatwoot
                  </a>
                )}
                {onResolve && (
                  <button type="button" disabled={resolving}
                    onClick={() => { if (window.confirm(`¿Marcar la conversación #${oc.ticketId} como resuelta?`)) onResolve(oc.conversationId); }}
                    className="rounded-xl border border-slate-200 bg-white text-slate-600 text-xs font-semibold px-3 py-2 hover:bg-red-50 hover:border-red-200 hover:text-red-600 disabled:opacity-50 transition-all duration-200">
                    Marcar Resuelta
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {resolveError && <p className="text-red-600 text-xs px-4 pb-3">{resolveError}</p>}
    </div>
  );
}

// ─── similar tickets ──────────────────────────────────────────────────────────

function SectionSimilarTickets({ meta }) {
  const groups = meta?.similarTickets || [];
  if (!groups.length) return null;
  const chatwootApp = meta?.chatwootApp;

  return (
    <CollapsibleResultSection title="Tickets relacionados (Cruce inteligente)" badge={groups.length} defaultOpen>
      <div className="divide-y divide-slate-100 bg-white">
        {groups.map((g) => {
          const url = chatwootConversationUrl(chatwootApp, g.conversationId);
          return (
            <div key={g.conversationId} className="px-4 py-3.5 hover:bg-slate-50/50 transition-all duration-200">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-slate-800 text-sm">Conversación #{g.conversationId}</span>
                    <span className={`text-[10px] font-semibold rounded-full px-2 py-0.5 border ${
                      g.confident 
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-200' 
                        : 'bg-amber-50 text-amber-800 border-amber-200'
                    }`}>
                      {g.matches.length} coincidencia{g.matches.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {!g.confident && (
                    <p className="text-[10px] text-amber-600 mt-0.5 italic font-medium">Solo 1 coincidencia — verificar con cautela</p>
                  )}
                  
                  {g.contactName && (
                    <p className="text-xs font-semibold text-slate-700 mt-1">
                      Cliente: <span className="text-slate-900 font-bold">{g.contactName}</span> {g.updatedAt && <span className="text-[10px] text-slate-400 font-normal">({formatIso(g.updatedAt)})</span>}
                    </p>
                  )}

                  {g.aiSummary ? (
                    <div className="mt-2 rounded-xl bg-slate-50 border border-slate-100 p-2.5">
                      <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">Último resumen de chat</p>
                      <p className="text-xs text-slate-700 leading-relaxed font-medium">{g.aiSummary}</p>
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-400 mt-1.5 italic font-medium">Sin resumen disponible para este ticket</p>
                  )}

                  <div className="flex flex-wrap gap-1 mt-2.5">
                    {g.matches.map((m, i) => (
                      <span key={i} className="text-[10px] bg-momo-50 border border-momo-100 text-momo-800 rounded-md px-2 py-0.5 font-medium transition-all hover:scale-105 duration-200 cursor-default">
                        {m.label}: {m.value}
                      </span>
                    ))}
                  </div>
                </div>
                {url && (
                  <a href={url} target="_blank" rel="noreferrer"
                    className="text-xs font-semibold text-momo-600 hover:text-momo-800 underline shrink-0 mt-0.5 transition-colors">
                    Abrir Ticket →
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </CollapsibleResultSection>
  );
}

// ─── service orders (Google Sheets Sync) ──────────────────────────────────────

function SectionServiceOrders({ block }) {
  if (!block || !Array.isArray(block) || block.length === 0) return null;

  return (
    <CollapsibleResultSection title="Órdenes de Servicio ST (Google Sheets)" badge={block.length} defaultOpen>
      <div className="bg-white divide-y divide-slate-100">
        {block.map((row) => (
          <div key={`so-${row.id}`} className="px-4 py-4 hover:bg-slate-50/40 transition-colors">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1.5">
                  <span className="font-bold text-slate-800 text-sm">Órden N° {row.order_number}</span>
                  {row.status === 'completed' ? (
                    <span className="text-[10px] font-bold rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 px-1.5 py-0.5">🟢 Entregado/Salida</span>
                  ) : (
                    <span className="text-[10px] font-bold rounded-md bg-blue-50 border border-blue-200 text-blue-800 px-1.5 py-0.5">🔵 Ingresado/Entrada</span>
                  )}
                  {row.imei_sim && (
                    <span className="text-[10px] font-bold bg-slate-50 border border-slate-200 text-slate-600 rounded-md px-1.5 py-0.5 font-mono">
                      IMEI/SIM: {row.imei_sim}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 my-2 bg-slate-50/60 rounded-xl p-2.5 border border-slate-100/80 text-xs">
                  <div>
                    <p className="font-bold text-slate-400 uppercase text-[9px] tracking-wider">Fecha Entrada</p>
                    <p className="font-semibold text-slate-700 mt-0.5">{row.entry_date ? formatIso(row.entry_date) : '—'}</p>
                  </div>
                  <div>
                    <p className="font-bold text-slate-400 uppercase text-[9px] tracking-wider">Fecha Salida</p>
                    <p className="font-semibold text-slate-700 mt-0.5">{row.exit_date ? formatIso(row.exit_date) : '—'}</p>
                  </div>
                </div>

                <div className="space-y-2 mt-2">
                  {row.check_in_notes && (
                    <div className="text-xs">
                      <span className="font-bold text-slate-400 uppercase text-[9px] tracking-wider block">Observaciones Entrada</span>
                      <p className="text-slate-600 font-medium mt-0.5">{row.check_in_notes}</p>
                    </div>
                  )}
                  {row.check_out_notes && (
                    <div className="text-xs">
                      <span className="font-bold text-slate-400 uppercase text-[9px] tracking-wider block">Resultado de la prueba / Salida</span>
                      <p className="text-slate-600 font-medium mt-0.5">{row.check_out_notes}</p>
                    </div>
                  )}
                  {row.solution && (
                    <div className="text-xs bg-emerald-50/30 border border-emerald-100/50 rounded-xl p-2">
                      <span className="font-bold text-emerald-800 uppercase text-[9px] tracking-wider block">Solución Técnica</span>
                      <p className="text-emerald-900 font-semibold mt-0.5">{row.solution}</p>
                    </div>
                  )}
                </div>

                {row.technician && (
                  <p className="text-[11px] text-slate-400 mt-2.5 font-medium">
                    Técnico asignado: <span className="text-slate-600 font-semibold">{row.technician}</span>
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-1.5 shrink-0 self-start">
                {row.entry_report_url && (
                  <a href={row.entry_report_url} target="_blank" rel="noreferrer"
                    className="rounded-xl bg-blue-600 text-white text-xs font-semibold px-3 py-1.5 hover:bg-blue-700 transition-all shadow-sm">
                    Ver Informe Entrada ↗
                  </a>
                )}
                {row.report_url && (
                  <a href={row.report_url} target="_blank" rel="noreferrer"
                    className="rounded-xl bg-momo-600 text-white text-xs font-semibold px-3 py-1.5 hover:bg-momo-700 transition-all shadow-sm">
                    Ver Informe Salida ↗
                  </a>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </CollapsibleResultSection>
  );
}

// ─── bsale ────────────────────────────────────────────────────────────────────

function SectionBsale({ block, shopifyBlock }) {
  if (!block || block.status === 'error') {
    if (!block?.error) return null;
    return (
      <CollapsibleResultSection title="Boletas Bsale" badge={0} error={block.error} defaultOpen={false}>
        <p className="px-4 py-3 text-sm text-slate-400 italic">Sin boletas</p>
      </CollapsibleResultSection>
    );
  }
  const items = block.data?.items || [];
  if (!items.length) return null;

  const clients = block.data?.clients || [];
  const clientMap = Object.fromEntries(clients.map((c) => [String(c.id), c]));

  // Agrupar por clientId
  const grouped = new Map();
  for (const doc of items) {
    const key = String(doc.clientId ?? 'unknown');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(doc);
  }

  const hasShopifyOrders =
    shopifyBlock?.status === 'ok' &&
    !shopifyBlock?.data?.skipped &&
    (shopifyBlock?.data?.orders?.length ?? 0) > 0;

  const nameNote = block.data?.nameWithoutEmailNote;
  const subtitle = hasShopifyOrders ? 'Cruzado: Tiene compras en Shopify' : undefined;

  return (
    <CollapsibleResultSection title="Boletas Bsale" badge={items.length} subtitle={subtitle} defaultOpen>
      {nameNote && (
        <div className="mx-4 mt-3 mb-1 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 font-medium">
          ⚠️ {nameNote}
        </div>
      )}
      <div className="bg-white divide-y divide-slate-100">
        {[...grouped.entries()].map(([clientKey, docs]) => {
          const client = clientMap[clientKey];
          const clientName = client?.name || null;
          const showHeader = clientName && grouped.size > 1;

          return (
            <div key={clientKey}>
              {showHeader && (
                <div className="px-4 py-2 bg-slate-50/70 border-b border-slate-100 flex justify-between items-center">
                  <p className="text-xs font-semibold text-slate-700">{clientName}</p>
                  {client.email && <p className="text-[10px] text-slate-400 font-mono font-medium">{client.email}</p>}
                </div>
              )}
              {docs.map((row) => (
                <div key={`bsale-${row.id}`} className="px-4 py-3.5 hover:bg-slate-50/40 transition-colors">
                  <div className="flex items-start gap-3 justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-bold text-slate-800 text-sm">Folio N° {row.number}</span>
                        <span className="text-xs text-slate-400 font-medium">{formatUnix(row.emissionDate)}</span>
                        {row.total != null && (
                          <span className="text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-lg px-2 py-0.5">
                            ${Number(row.total).toLocaleString('es-CL')}
                          </span>
                        )}
                      </div>
                      {row.items?.length > 0 && (
                        <ul className="space-y-1 mt-1.5">
                          {row.items.slice(0, 3).map((item, i) => (
                            <li key={i} className="text-xs text-slate-600 flex gap-1.5 font-medium">
                              <span className="text-slate-400 shrink-0 font-bold">{item.quantity}×</span>
                              <span className="truncate">{item.description || '—'}</span>
                            </li>
                          ))}
                          {row.items.length > 3 && (
                            <li className="text-[10px] text-slate-400 font-bold">+{row.items.length - 3} producto{row.items.length - 3 !== 1 ? 's' : ''} más</li>
                          )}
                        </ul>
                      )}
                    </div>
                    {row.urlPublicView && (
                      <a href={row.urlPublicView} target="_blank" rel="noreferrer"
                        className="rounded-xl border border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3 py-1.5 transition-all duration-200 shrink-0">
                        Abrir PDF ↗
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </CollapsibleResultSection>
  );
}

// ─── shopify ──────────────────────────────────────────────────────────────────

function SectionShopify({ block }) {
  if (!block || block.status === 'error') {
    if (!block?.error) return null;
    return (
      <CollapsibleResultSection title="Pedidos Shopify" badge={0} error={block.error} defaultOpen={false}>
        <p className="px-4 py-3 text-sm text-slate-400 italic">Sin pedidos</p>
      </CollapsibleResultSection>
    );
  }
  if (!block.data || block.data.skipped) return null;
  const customers = block.data.customers || [];
  const orders = block.data.orders || [];
  if (!customers.length && !orders.length) return null;

  const payLabel = (s) => {
    if (!s) return null;
    const map = { paid: '🟢 Pagado', pending: '🟡 Pago Pendiente', refunded: '🔵 Reembolsado', partially_paid: '🟠 Pago Parcial', voided: '🔴 Anulado' };
    return map[s] || s;
  };
  const fulfillLabel = (s) => {
    if (!s) return null;
    const map = { fulfilled: '🔵 Entregado', partial: '🔵 Parcial', unfulfilled: '🟡 Sin enviar', restocked: '🔴 Devuelto' };
    return map[s] || s;
  };

  return (
    <CollapsibleResultSection title="Pedidos Shopify" badge={orders.length + customers.length} defaultOpen>
      <div className="bg-white divide-y divide-slate-100">
        {orders.map((o) => (
          <div key={o.id} className="px-4 py-3.5 hover:bg-slate-50/40 transition-colors">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-momo-700 text-base tracking-tight">{o.name || `#${o.id}`}</span>
                  {payLabel(o.financialStatus) && (
                    <span className="text-[10px] font-bold rounded-md bg-slate-50 border border-slate-200 text-slate-600 px-1.5 py-0.5">
                      {payLabel(o.financialStatus)}
                    </span>
                  )}
                  {fulfillLabel(o.fulfillmentStatus) && (
                    <span className="text-[10px] font-bold rounded-md bg-slate-50 border border-slate-200 text-slate-600 px-1.5 py-0.5">
                      {fulfillLabel(o.fulfillmentStatus)}
                    </span>
                  )}
                  <CopyableValue value={o.name || String(o.id)} />
                </div>
                <p className="text-xs text-slate-400 mt-1 font-semibold">
                  {formatIso(o.createdAt)}{o.totalPrice ? ` · $${Number(o.totalPrice).toLocaleString('es-CL')} ${o.currency || ''}` : ''}
                </p>
              </div>
              <div className="flex gap-1.5 shrink-0">
                {o.adminUrl && (
                  <a href={o.adminUrl} target="_blank" rel="noreferrer"
                    className="rounded-xl bg-momo-600 text-white text-xs font-semibold px-3 py-2 hover:bg-momo-700 transition-all shadow-sm">
                    Ver Pedido
                  </a>
                )}
                {o.adminOrdersSearchUrl && (
                  <a href={o.adminOrdersSearchUrl} target="_blank" rel="noreferrer"
                    className="rounded-xl border border-slate-200 text-slate-600 text-xs font-semibold px-3 py-2 hover:bg-slate-50 transition-all">
                    Ver en Admin
                  </a>
                )}
              </div>
            </div>
          </div>
        ))}
        {customers.length > 0 && (
          <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/50">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Cliente en Shopify</p>
            {customers.map((c) => (
              <div key={c.id} className="text-xs text-slate-700 font-semibold flex items-center justify-between">
                <span>👤 {[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}</span>
                <span className="text-[11px] text-slate-400 font-mono font-medium">{c.email || ''} {c.phone ? `· ${c.phone}` : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </CollapsibleResultSection>
  );
}

function ConversationCard({ row, chatwootApp }) {
  const url = chatwootConversationUrl(chatwootApp, row.conversationId);
  const { label: statusLabel, cls: statusCls } = statusBadge(row.status, row.isOpen);

  // Filtrar fallas y otros facts
  const fallas = (row.deviceFacts || []).filter(f => f.label === 'Falla');
  const otherFacts = (row.deviceFacts || []).filter(f => f.label !== 'Falla');

  const fallaStyles = {
    'Batería/Carga': 'bg-amber-50 border-amber-200 text-amber-800',
    'Pantalla': 'bg-purple-50 border-purple-200 text-purple-800',
    'Señal/SIM': 'bg-blue-50 border-blue-200 text-blue-800',
    'GPS/Ubicación': 'bg-emerald-50 border-emerald-200 text-emerald-800',
    'Encendido/Boot': 'bg-rose-50 border-rose-200 text-rose-800',
    'Audio/Micrófono': 'bg-pink-50 border-pink-200 text-pink-800',
    'Aplicación/App': 'bg-slate-50 border-slate-200 text-slate-800',
  };

  const fallaIcons = {
    'Batería/Carga': '🔋',
    'Pantalla': '📱',
    'Señal/SIM': '📡',
    'GPS/Ubicación': '📍',
    'Encendido/Boot': '🔌',
    'Audio/Micrófono': '🔊',
    'Aplicación/App': '⚙️',
  };

  return (
    <div className="px-4 py-3.5 hover:bg-slate-50/30 transition-colors">
      {/* header */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-slate-800 text-sm">#{row.ticketId}</span>
          <span className={`text-[10px] font-bold border rounded-md px-1.5 py-0.5 ${statusCls}`}>{statusLabel}</span>
          {row.stTagged && (
            <span className="text-[10px] font-bold border rounded-md px-1.5 py-0.5 bg-momo-50 border-momo-100 text-momo-800">Serv. Técnico</span>
          )}
          
          {/* Failure badges */}
          {fallas.map((f, idx) => {
            const style = fallaStyles[f.value] || 'bg-slate-50 border-slate-200 text-slate-800';
            const icon = fallaIcons[f.value] || '⚠️';
            return (
              <span key={idx} className={`text-[10px] font-bold border rounded-md px-1.5 py-0.5 ${style}`}>
                {icon} {f.value}
              </span>
            );
          })}
        </div>
        <span className="text-xs text-slate-400 shrink-0 font-medium">{formatIso(row.date)}</span>
      </div>

      {/* summary — main content */}
      {row.aiSummary ? (
        <div className="bg-momo-50/60 rounded-xl px-3 py-2.5 mb-2.5 border border-momo-100/50">
          <p className="text-[9px] font-bold text-momo-600 uppercase tracking-wider mb-0.5">Resumen del Chat</p>
          <p className="text-xs text-slate-700 leading-relaxed font-medium">{row.aiSummary}</p>
        </div>
      ) : (
        <p className="text-xs text-slate-400 italic mb-2.5 font-medium">Sin resumen disponible para este ticket</p>
      )}

      {/* device facts */}
      {otherFacts.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2.5">
          {otherFacts.map((f, i) => (
            <span key={i} className="text-[10px] bg-slate-50 border border-slate-200 text-slate-600 rounded-md px-1.5 py-0.5 font-bold transition-all hover:scale-105 duration-200 cursor-default">
              {f.label}: {f.value}
            </span>
          ))}
        </div>
      )}

      {/* footer */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
          Canal: {row.channel || '—'}{row.agent ? ` · Agente: ${row.agent}` : ''}
        </span>
        {url && (
          <a href={url} target="_blank" rel="noreferrer"
            className="text-xs font-semibold text-momo-600 hover:text-momo-800 underline transition-colors">
            Ver Conversación ↗
          </a>
        )}
      </div>
    </div>
  );
}

function SectionConversations({ block, chatwootApp, title, subtitle, icon, defaultOpen }) {
  if (!block || block.status !== 'ok' || !block.data) return null;
  const stItems = block.data.servicioTecnico || [];
  const genItems = block.data.chatwoot || [];
  const items = title === 'Servicio técnico' ? stItems : genItems;
  if (!items.length) return null;

  return (
    <CollapsibleResultSection title={title} subtitle={subtitle} badge={items.length} defaultOpen={defaultOpen ?? true}>
      <div className="bg-white divide-y divide-slate-100">
        {items.map((row) => (
          <ConversationCard key={`conv-${row.conversationId}`} row={row} chatwootApp={chatwootApp} />
        ))}
      </div>
    </CollapsibleResultSection>
  );
}

// ─── ST banner ────────────────────────────────────────────────────────────────

function StBanner({ meta }) {
  if (!meta?.recentSt?.showBanner) return null;
  return (
    <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50/60 p-4 shadow-sm backdrop-blur-md flex gap-3 items-start animate-pulse">
      <span className="text-xl shrink-0">⚠️</span>
      <div>
        <p className="font-bold text-amber-900 text-sm">Actividad en Servicio Técnico Reciente</p>
        <p className="text-xs text-amber-800 mt-0.5 leading-relaxed font-semibold">El cliente registra hitos de servicio técnico en los últimos 90 días.</p>
        {meta.recentSt.lastDate && (
          <p className="text-[10px] text-amber-700 mt-1 font-bold">Último Hito: {formatIso(meta.recentSt.lastDate)}</p>
        )}
      </div>
    </div>
  );
}

// ─── client ficha ─────────────────────────────────────────────────────────────

function Skeleton() {
  return <span className="inline-block h-4 w-28 rounded bg-slate-100 animate-pulse" />;
}

function Empty() {
  return <span className="text-sm text-slate-300 italic font-medium">No registrado</span>;
}

function FichaRow({ icon, label, loading, children }) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5 border-b border-slate-100 last:border-0 hover:bg-slate-50/30 transition-colors">
      <span className="text-base shrink-0 w-6 text-center mt-0.5 select-none">{icon}</span>
      <span className="text-[10px] font-bold text-slate-400 w-24 shrink-0 pt-1 uppercase tracking-wider">{label}</span>
      <div className="flex-1 min-w-0 font-medium">
        {loading ? <Skeleton /> : children}
      </div>
    </div>
  );
}

function ClientFicha({ conversationId, summaryData, isSummaryLoading, searchData, isSearchLoading, chatwootApp }) {
  const summary = summaryData?.summary ?? null;
  const meta = searchData?.meta;
  const bs = searchData?.bsale;
  const sh = searchData?.shopify;

  // Identidad — DB primero, search como fallback
  const name = summary?.contact_name || meta?.contactSummary?.name || null;
  const email = summary?.contact_email || meta?.contactSummary?.email || null;
  const phone = summary?.contact_phone || meta?.contactSummary?.phone || null;

  // Identifiers extraídos de mensajes
  let imeis = (summary?.extracted_imei || []).filter(v => v.length === 15); // only full IMEIs
  let deviceIds = (summary?.extracted_imei || [])
    .filter(v => v.length === 15 && v.startsWith('8'))
    .map(v => v.slice(4, -1)); // derived 10-digit ID: remove first 4 + last digit
  let sims   = summary?.extracted_sim || [];
  let models = summary?.extracted_device_models || [];

  // Fallback a metadatos de búsqueda cuando no existe resumen de Chatwoot (búsqueda manual o standalone)
  if (!summary && meta?.equipmentFacts) {
    const facts = meta.equipmentFacts || [];
    const extractedImeis = facts.filter(f => f.label === 'ID / IMEI').map(f => f.value);
    if (extractedImeis.length) {
      imeis = extractedImeis;
      deviceIds = imeis.filter(v => v.length === 15 && v.startsWith('8')).map(v => v.slice(4, -1));
    }
    const extractedSims = facts.filter(f => f.label === 'ICCID / SIM').map(f => f.value);
    if (extractedSims.length) {
      sims = extractedSims;
    }
    const extractedModels = facts.filter(f => f.label?.toLowerCase() === 'modelo' || f.label?.toLowerCase() === 'dispositivo').map(f => f.value);
    if (extractedModels.length) {
      models = [...new Set(extractedModels)];
    }
  }

  // Extraer RUT, Comuna y Dirección desde los hechos de equipo
  let ruts = [];
  let comunas = [];
  let address = summary?.extracted_address || null;
  if (meta?.equipmentFacts) {
    const facts = meta.equipmentFacts || [];
    ruts = [...new Set(facts.filter(f => f.label === 'RUT').map(f => f.value))];
    comunas = [...new Set(facts.filter(f => f.label === 'Comuna').map(f => f.value))];
    if (!address) {
      const addrFact = facts.find(f => f.label === 'Dirección');
      if (addrFact) address = addrFact.value;
    }
  }

  // Datos en vivo de search
  const openTickets = meta?.openConversations || [];
  const shopifyOrders = sh?.data?.orders || [];
  const bsaleItems = bs?.data?.items || [];

  const idLoading = isSummaryLoading;
  const liveLoading = isSearchLoading;
  // Generar nota interna
  const [sending, setSending] = useState(false);
  const handleSendFichaNote = async () => {
    if (!conversationId) return;
    setSending(true);
    let md = `### 📋 Ficha ST Consolidada del Cliente\n\n`;
    if (name) md += `👤 **Nombre:** ${name}\n`;
    if (email) md += `✉️ **Correo:** ${email}\n`;
    if (phone) md += `📱 **WhatsApp:** ${phone}\n`;
    if (ruts.length) md += `🪪 **RUT:** ${ruts.join(', ')}\n`;
    if (comunas.length) md += `📍 **Comuna:** ${comunas.join(', ')}\n`;
    if (address) md += `🏠 **Dirección:** ${address}\n`;
    if (models.length) md += `📱 **Modelo:** ${models.join(', ')}\n`;
    if (imeis.length) md += `📡 **IMEI:** ${imeis.join(', ')}\n`;
    if (deviceIds.length) md += `🔑 **ID dispositivo:** ${deviceIds.join(', ')}\n`;
    if (sims.length) md += `💳 **SIM SoyMomo:** ${sims.join(', ')}\n`;
    if (shopifyOrders.length) md += `📦 **Shopify:** ${shopifyOrders.map(o => o.name).join(', ')}\n`;
    if (bsaleItems.length) md += `🧾 **Bsale:** Boleta Folio ${bsaleItems.map(b => b.number).join(', ')}\n`;
    
    md += `\n*Ficha consolidada enviada desde el panel.*`;
    try {
      await postPrivateNote(conversationId, md);
      alert('✅ Ficha enviada como nota interna correctamente!');
    } catch (err) {
      alert(`❌ Error al enviar nota: ${err.message}`);
    } finally {
      setSending(false);
    }
  };
  // Toggle de etiqueta ST
  const [tagging, setTagging] = useState(false);
  const activeTicket = openTickets.find(o => o.conversationId === conversationId);
  const isStTagged = activeTicket?.stTagged || false;
  const labels = activeTicket?.labels || [];

  const handleToggleST = async () => {
    setTagging(true);
    let list = [...labels];
    if (isStTagged) {
      list = list.filter(l => l.toLowerCase() !== 'st');
    } else {
      list.push('st');
    }
    try {
      await postConversationLabels(conversationId, list);
      alert(`✅ Etiqueta ST ${isStTagged ? 'quitada' : 'agregada'} correctamente! Refresca para ver los cambios.`);
    } catch (err) {
      alert(`❌ Error al actualizar etiqueta: ${err.message}`);
    } finally {
      setTagging(false);
    }
  };

  return (
    <div className="rounded-2xl border border-momo-100 bg-white shadow-sm overflow-hidden mb-4 transition-all hover:shadow-md animate-fade-in">
      {/* ── header ── */}
      <div className="px-4 py-3 bg-gradient-to-r from-momo-700 to-momo-500 flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-white font-bold text-sm tracking-wide">Ficha del Cliente</span>
          {summary?.updated_at && (
            <span className="text-momo-200 text-[10px] font-semibold mt-0.5">Última sync: {formatIso(summary.updated_at)}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {(isSummaryLoading || isSearchLoading) && (
            <span className="inline-block h-3.5 w-3.5 rounded-full border-[2px] border-white border-t-transparent animate-spin" />
          )}
        </div>
      </div>

      {/* ── filas de identidad ── */}
      <FichaRow icon="👤" label="Nombre" loading={idLoading}>
        {name ? <span className="text-sm font-semibold text-slate-800">{name}</span> : <Empty />}
      </FichaRow>

      <FichaRow icon="✉️" label="Correo" loading={idLoading}>
        {email ? <CopyableValue value={email} /> : <Empty />}
      </FichaRow>
      <FichaRow icon="📱" label="WhatsApp" loading={idLoading}>
        {phone ? <CopyableValue value={phone} /> : <Empty />}
      </FichaRow>

      {ruts.length > 0 && (
        <FichaRow icon="🪪" label="RUT" loading={idLoading}>
          <div className="space-y-1">{ruts.map((v) => <CopyableValue key={v} value={v} />)}</div>
        </FichaRow>
      )}

      {comunas.length > 0 && (
        <FichaRow icon="📍" label="Comuna" loading={idLoading}>
          <div className="space-y-1">{comunas.map((v) => (
            <span key={v} className="inline-block text-xs font-bold text-slate-800 bg-slate-100 border border-slate-200 rounded-lg px-2 py-0.5">{v}</span>
          ))}</div>
        </FichaRow>
      )}

      {address && (
        <FichaRow icon="🏠" label="Dirección" loading={idLoading}>
          <CopyableValue value={address} />
        </FichaRow>
      )}

      <FichaRow icon="📱" label="Modelo dispositivo" loading={idLoading}>
        {models.length
          ? <div className="space-y-1">{models.map((v) => (
              <span key={v} className="inline-block text-xs font-bold text-momo-800 bg-momo-50 border border-momo-100 rounded-lg px-2 py-0.5">{v}</span>
            ))}</div>
          : <Empty />}
      </FichaRow>

      <FichaRow icon="📡" label="IMEI" loading={idLoading}>
        {imeis.length
          ? <div className="space-y-1">{imeis.map((v) => <CopyableValue key={v} value={v} />)}</div>
          : <Empty />}
      </FichaRow>

      {deviceIds.length > 0 && (
        <FichaRow icon="🔑" label="ID dispositivo" loading={idLoading}>
          <div className="space-y-1">{deviceIds.map((v) => <CopyableValue key={v} value={v} />)}</div>
        </FichaRow>
      )}

      <FichaRow icon="💳" label="Tarjeta SIM SoyMomo" loading={idLoading}>
        {sims.length
          ? <div className="space-y-1">{sims.map((v) => <CopyableValue key={v} value={v} />)}</div>
          : <Empty />}
      </FichaRow>

      {/* ── resumen chat ── */}
      <FichaRow icon="✨" label="Resumen del Chat" loading={idLoading}>
        {summary?.ai_summary
          ? <p className="text-xs text-slate-700 leading-relaxed font-semibold bg-slate-50 border border-slate-100 rounded-xl p-2.5">{summary.ai_summary}</p>
          : <span className="text-xs text-slate-400 italic">No hay un resumen disponible para este ticket. Envía un mensaje para generarlo automáticamente de forma gratuita.</span>}
      </FichaRow>
      {/* ── tickets abiertos ── */}
      <FichaRow icon="🎫" label="Tickets Abiertos" loading={liveLoading}>
        {openTickets.length ? (
          <div className="space-y-1.5">
            {openTickets.map((oc) => {
              const url = chatwootConversationUrl(chatwootApp, oc.conversationId);
              return (
                <div key={oc.conversationId} className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-md px-1.5 py-0.5">#{oc.ticketId} abierto</span>
                  <span className="text-[11px] text-slate-400">{formatIso(oc.date)}</span>
                  {url && <a href={url} target="_blank" rel="noreferrer" className="text-[11px] text-momo-600 font-bold underline transition-colors">Abrir ↗</a>}
                </div>
              );
            })}
          </div>
        ) : (
          <span className="text-xs text-slate-400 italic font-semibold">Sin tickets abiertos adicionales</span>
        )}
      </FichaRow>

      {/* ── compras shopify ── */}
      <FichaRow icon="📦" label="Shopify" loading={liveLoading}>
        {shopifyOrders.length ? (
          <div className="space-y-2">
            {shopifyOrders.slice(0, 4).map((o) => {
              const payMap = { paid: '🟢 Pago Ok', pending: '🟡 Pendiente', refunded: '🔵 Reembolso' };
              const fulfillMap = { fulfilled: '🔵 Enviado', unfulfilled: '🟡 Sin enviar', partial: 'Parcial' };
              return (
                <div key={o.id} className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-bold text-momo-700 text-sm">{o.name}</span>
                  {payMap[o.financialStatus] && <span className="text-[9px] bg-slate-100 border border-slate-200 text-slate-600 rounded-md px-1.5 py-0.5 font-bold">{payMap[o.financialStatus]}</span>}
                  {fulfillMap[o.fulfillmentStatus] && <span className="text-[9px] bg-slate-100 border border-slate-200 text-slate-600 rounded-md px-1.5 py-0.5 font-bold">{fulfillMap[o.fulfillmentStatus]}</span>}
                  {o.totalPrice && <span className="text-xs text-slate-500 font-semibold">${Number(o.totalPrice).toLocaleString('es-CL')}</span>}
                  {o.adminUrl && <a href={o.adminUrl} target="_blank" rel="noreferrer" className="text-[10px] text-momo-600 font-bold underline shrink-0 ml-1">Ver ↗</a>}
                </div>
              );
            })}
          </div>
        ) : (
          <Empty />
        )}
      </FichaRow>

      {/* ── boletas bsale ── */}
      <FichaRow icon="🧾" label="Bsale" loading={liveLoading}>
        {bsaleItems.length ? (
          <div className="space-y-2">
            {bsaleItems.slice(0, 3).map((row) => (
              <div key={row.id} className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-bold text-slate-800">Folio N° {row.number}</span>
                {row.total != null && <span className="text-[10px] font-bold text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-md px-1.5 py-0.5">${Number(row.total).toLocaleString('es-CL')}</span>}
                <span className="text-[10px] text-slate-400 font-medium">{formatUnix(row.emissionDate)}</span>
                {row.urlPublicView && <a href={row.urlPublicView} target="_blank" rel="noreferrer" className="text-[10px] text-momo-600 font-bold underline ml-1">PDF ↗</a>}
              </div>
            ))}
          </div>
        ) : (
          <Empty />
        )}
      </FichaRow>

      {/* ── órdenes ST (Sheets) ── */}
      <FichaRow icon="📋" label="ST (Planilla)" loading={liveLoading}>
        {searchData?.service_orders?.length ? (
          <div className="space-y-2">
            {searchData.service_orders.map((row) => (
              <div key={row.id} className="flex flex-col gap-0.5 bg-slate-50 border border-slate-100 rounded-xl p-2.5">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="font-bold text-slate-800 text-xs">Orden N° {row.order_number}</span>
                  {row.status === 'completed' ? (
                    <span className="text-[9px] font-bold text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-md px-1.5 py-0.5">Salida</span>
                  ) : (
                    <span className="text-[9px] font-bold text-blue-800 bg-blue-50 border border-blue-100 rounded-md px-1.5 py-0.5">Entrada</span>
                  )}
                </div>
                {row.entry_date && <p className="text-[10px] text-slate-400 font-medium mt-1">Entrada: {formatIso(row.entry_date)}</p>}
                {row.exit_date && <p className="text-[10px] text-slate-400 font-medium">Salida: {formatIso(row.exit_date)}</p>}
                {row.solution && <p className="text-[10px] text-emerald-900 font-bold mt-1 bg-emerald-50 border border-emerald-100/50 rounded p-1">Solución: {row.solution}</p>}
                <div className="flex gap-3 mt-1.5 pt-1.5 border-t border-slate-100 text-[10px] font-semibold text-momo-600">
                  {row.entry_report_url && <a href={row.entry_report_url} target="_blank" rel="noreferrer" className="underline hover:text-momo-800">Ver Informe Entrada ↗</a>}
                  {row.report_url && <a href={row.report_url} target="_blank" rel="noreferrer" className="underline hover:text-momo-800">Ver Informe Salida ↗</a>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty />
        )}
      </FichaRow>

    </div>
  );
}

// ─── main page ────────────────────────────────────────────────────────────────

export default function SearchPage() {
  const qc = useQueryClient();
  const embed = isDashboardEmbed();
  const chatwootCtx = useChatwootDashboardContext();
  const [input, setInput] = useState('');

  // Cuando Chatwoot nos da el conversationId, cargamos el contacto en background
  const ctxConvId = chatwootCtx?.conversationId ?? null;
  const { data: contactPreview } = useQuery({
    queryKey: ['contact-preview', ctxConvId],
    queryFn: () => fetchContactPreview(ctxConvId),
    enabled: !!ctxConvId,
    staleTime: 3 * 60 * 1000,
    retry: false,
  });

  // Autosearch cuando detecta un ticket
  useEffect(() => {
    if (ctxConvId) {
      setInput(`cw ${ctxConvId}`);
    }
  }, [ctxConvId]);

  const debounced = useDebouncedValue(input.trim(), 400);
  const canSearch = debounced.length >= 2;

  // Detectar si la búsqueda manual difiere del ticket actual en modo embebido
  const isManualSearchActive = !!ctxConvId && !!debounced && debounced !== `cw ${ctxConvId}`;

  const resolveConversation = useMutation({
    mutationFn: resolveChatwootConversation,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['search', debounced] }),
  });

  const { data, isFetching, isError, error } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => fetchSearch(debounced),
    enabled: canSearch,
  });

  const { data: summaryData, isFetching: isFetchingSummary } = useQuery({
    queryKey: ['conversation-summary', ctxConvId],
    queryFn: () => fetchConversationSummary(ctxConvId),
    enabled: !!ctxConvId,
    staleTime: 30 * 1000,
  });

  const cw = data?.chatwoot;
  const bs = data?.bsale;
  const sh = data?.shopify;
  const meta = data?.meta;

  return (
    <div className={embed ? 'px-3 py-3 bg-slate-50/50 min-h-screen' : 'max-w-3xl mx-auto px-4 py-8 min-h-screen'}>

      {/* barra de búsqueda unificada */}
      <div className="mb-4 animate-fade-in">
        <label htmlFor="q" className="sr-only">Buscar cliente unificado</label>
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-lg pointer-events-none">🔍</span>
          <input
            id="q" name="q" type="search" autoComplete="off"
            placeholder="IMEI, RUT, correo, nombre, N° pedido o folio..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-full rounded-2xl border border-slate-200 bg-white/95 backdrop-blur-md pl-11 pr-4 py-3 text-slate-900 text-sm shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-momo-400 focus:border-momo-400 focus:shadow-md"
          />
        </div>
        {/^\d{15}$/.test(input.trim()) && input.trim().startsWith('8') && (
          <p className="mt-1.5 text-[11px] text-slate-500 flex items-center gap-1.5 bg-slate-100 border border-slate-200 rounded-lg px-2 py-1 w-fit">
            <span className="font-bold text-slate-600">ID derivado del equipo:</span>
            <span className="font-mono text-momo-700 font-bold">{input.trim().slice(4, -1)}</span>
            <button type="button" onClick={() => copyText(input.trim().slice(4, -1))}
              className="text-slate-400 hover:text-momo-600 text-sm" title="Copiar">⧉</button>
          </p>
        )}
      </div>

      <div className="animate-fade-in space-y-4">
        {/* Banner de búsqueda manual activa en modo embebido */}
        {embed && isManualSearchActive && (
          <div className="rounded-2xl border border-momo-200 bg-momo-50/90 p-3.5 backdrop-blur-md shadow-sm flex items-center justify-between gap-3 animate-fade-in">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-momo-950 flex items-center gap-1">
                <span>🔍</span> Búsqueda manual activa
              </p>
              <p className="text-[11px] text-slate-600 truncate mt-0.5">
                Resultados para: <span className="font-mono bg-momo-100 border border-momo-200 text-momo-800 px-1.5 py-0.5 rounded font-bold">{debounced}</span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => setInput(`cw ${ctxConvId}`)}
              className="rounded-xl bg-momo-600 hover:bg-momo-700 text-white text-[10px] font-bold px-3 py-2 transition-all shadow-sm shrink-0 flex items-center gap-1"
            >
              <span>⬅️</span> Volver al ticket
            </button>
          </div>
        )}

        {/* Ficha principal unificada (siempre visible) */}
        <ClientFicha
          conversationId={isManualSearchActive ? null : ctxConvId}
          summaryData={isManualSearchActive ? null : summaryData}
          isSummaryLoading={!isManualSearchActive && isFetchingSummary && !summaryData}
          searchData={data}
          isSearchLoading={isFetching}
          chatwootApp={meta?.chatwootApp}
        />

        {/* Cargando (solo en modo standalone para dar feedback de red) */}
        {!ctxConvId && canSearch && isFetching && (
          <div className="flex items-center gap-2.5 text-sm font-bold text-momo-700 bg-momo-50 border border-momo-100 rounded-2xl p-4 shadow-sm animate-pulse">
            <span className="inline-block h-4 w-4 rounded-full border-2 border-momo-500 border-t-transparent animate-spin" />
            Consolidando información de Chatwoot, Bsale y Shopify...
          </div>
        )}

        {/* Errores */}
        {isError && (
          <div className="rounded-2xl bg-red-50 border border-red-100 text-red-700 text-xs px-4 py-3 shadow-sm">
            {error?.message || 'Error al consultar las fuentes de información'}
          </div>
        )}

        {/* Estado de fuentes */}
        {data && <SourceStatusBar data={data} meta={meta} />}

        {/* Banners e información de soporte */}
        {data && <StBanner meta={meta} />}

        {/* Resultados consolidados y colapsables */}
        {data && (
          <div className="space-y-4 mt-3 animate-fade-in">
            <SectionOpenTickets
              meta={meta}
              onResolve={(id) => resolveConversation.mutate(id)}
              resolving={resolveConversation.isPending}
              resolveError={resolveConversation.isError ? resolveConversation.error?.message : null}
            />

            <SectionSimilarTickets meta={meta} />
            
            <SectionConversations
              block={cw}
              chatwootApp={meta?.chatwootApp}
              title="Historial de conversaciones"
              subtitle={embed ? "Todos los tickets del contacto" : "Todas las conversaciones del contacto"}
              defaultOpen={true}
            />

            {meta?.bsaleNote && <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 text-xs font-semibold text-amber-900 leading-relaxed shadow-sm">{meta.bsaleNote}</div>}
            
            {meta?.shopifyNote && <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 text-xs font-semibold text-amber-900 leading-relaxed shadow-sm">{meta.shopifyNote}</div>}
            
            {meta?.strictNameNote && <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4 text-xs font-semibold text-slate-800 leading-relaxed shadow-sm"><span className="font-bold text-slate-900">Filtro de nombre:</span> {meta.strictNameNote}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
