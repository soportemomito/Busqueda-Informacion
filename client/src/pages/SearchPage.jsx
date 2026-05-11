import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSearch, resolveChatwootConversation } from '../api/client.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { isDashboardEmbed } from '../hooks/useChatwootDashboardContext.js';
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
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' });
}

function chatwootConversationUrl(app, conversationId) {
  if (!app?.baseUrl || conversationId == null) return null;
  return `${app.baseUrl}/app/accounts/${app.accountId}/conversations/${conversationId}`;
}

function driveFileKindLabel(mimeType) {
  const m = String(mimeType || '');
  if (m === 'application/pdf') return 'PDF';
  if (m === 'application/vnd.google-apps.document') return 'Doc';
  if (m === 'application/vnd.google-apps.spreadsheet') return 'Hoja';
  if (m.startsWith('image/')) return 'Imagen';
  return 'Archivo';
}

function drivePdfAltUrl(file) {
  const mime = file.mimeType || '';
  const id = file.id;
  if (!id) return null;
  if (mime === 'application/vnd.google-apps.document') return `https://docs.google.com/document/d/${id}/export?format=pdf`;
  if (mime === 'application/vnd.google-apps.spreadsheet') return `https://docs.google.com/spreadsheets/d/${id}/export?format=pdf`;
  return null;
}

function driveEmbedPreviewUrl(file) {
  const id = file?.id;
  if (!id) return null;
  const mime = file.mimeType || '';
  if (mime === 'application/pdf') return `https://drive.google.com/file/d/${id}/preview`;
  if (mime === 'application/vnd.google-apps.document') return `https://docs.google.com/document/d/${id}/preview`;
  if (mime === 'application/vnd.google-apps.spreadsheet') return `https://docs.google.com/spreadsheets/d/${id}/preview`;
  return null;
}

async function copyText(text) {
  const t = String(text || '');
  if (!t) return;
  try { await navigator.clipboard.writeText(t); } catch { window.prompt('Copiar:', t); }
}

function statusBadge(status, isOpen) {
  if (isOpen) return { label: 'Abierto', cls: 'bg-emerald-100 text-emerald-800' };
  if (status === 'pending') return { label: 'Pendiente', cls: 'bg-amber-100 text-amber-800' };
  return { label: 'Resuelto', cls: 'bg-slate-100 text-slate-600' };
}

// ─── source status strip ───────────────────────────────────────────────────────

function deriveSourceStatuses(data, meta) {
  const items = [];
  const cw = data?.chatwoot;
  const bs = data?.bsale;
  const sh = data?.shopify;
  const dr = data?.drive;

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

  items.push(!dr || dr?.data?.skipped
    ? { id: 'drive', label: 'Drive', tone: 'skip', title: 'Sin órdenes ST' }
    : dr?.status === 'error'
    ? { id: 'drive', label: 'Drive', tone: 'error', title: dr.error }
    : { id: 'drive', label: 'Drive', tone: 'ok', title: 'Archivos encontrados' });

  return items;
}

function SourceStatusBar({ data, meta }) {
  if (!data || !meta) return null;
  const items = deriveSourceStatuses(data, meta);
  const dot = { ok: 'bg-emerald-500', error: 'bg-red-500', warn: 'bg-amber-400', skip: 'bg-slate-300' };
  const pill = { ok: 'border-emerald-200 text-emerald-800', error: 'border-red-200 text-red-700', warn: 'border-amber-200 text-amber-800', skip: 'border-slate-200 text-slate-400' };
  return (
    <div className="flex flex-wrap gap-1.5 mb-4">
      {items.map((it) => (
        <span key={it.id} title={it.title} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${pill[it.tone]}`}>
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dot[it.tone]}`} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

// ─── profile card ─────────────────────────────────────────────────────────────

function ProfileCard({ meta, bsBlock, cwBlock }) {
  const cs = meta?.contactSummary;
  const facts = meta?.equipmentFacts || [];

  const rows = [];
  const name = cs?.name || cwBlock?.data?.contacts?.[0]?.name;
  if (name) rows.push({ icon: '👤', label: 'Nombre', value: name });
  const email = cs?.email;
  if (email) rows.push({ icon: '✉️', label: 'Correo', value: email, copy: true });
  const phone = cs?.phone || cwBlock?.data?.contacts?.[0]?.phone;
  if (phone) rows.push({ icon: '📱', label: 'Teléfono', value: phone, copy: true });
  const rut = (cs?.ruts?.[0]) || facts.find((f) => f.label === 'RUT')?.value;
  if (rut) rows.push({ icon: '🪪', label: 'RUT', value: rut, copy: true });
  const smOrders = cs?.smOrders || cwBlock?.data?.shopifyOrdersFromMessages || [];
  if (smOrders.length) rows.push({ icon: '📦', label: 'N° Pedido', value: smOrders.join('  ·  '), copy: true });
  const bsaleItem = bsBlock?.data?.items?.[0];
  if (bsaleItem) rows.push({ icon: '🧾', label: 'Boleta', value: `N° ${bsaleItem.number}`, link: bsaleItem.urlPublicView || null });
  const imei = facts.find((f) => f.label === 'ID / IMEI')?.value;
  if (imei) rows.push({ icon: '📡', label: 'IMEI', value: imei, copy: true });
  const sim = facts.find((f) => f.label === 'ICCID / SIM')?.value;
  if (sim) rows.push({ icon: '💳', label: 'N° SIM', value: sim, copy: true });

  if (!rows.length) return null;

  return (
    <div className="mb-4 rounded-xl border border-momo-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 bg-gradient-to-r from-momo-600 to-momo-500 flex items-center gap-2">
        <span className="text-white font-bold text-sm">Perfil del cliente</span>
      </div>
      <div className="divide-y divide-slate-100">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3 px-4 py-2.5">
            <span className="text-base shrink-0 w-6 text-center">{r.icon}</span>
            <span className="text-xs font-semibold text-slate-500 w-20 shrink-0">{r.label}</span>
            <span className="text-sm text-slate-900 flex-1 break-all">
              {r.link ? (
                <a href={r.link} target="_blank" rel="noreferrer" className="text-momo-700 underline font-medium">{r.value}</a>
              ) : r.value}
            </span>
            {r.copy && (
              <button type="button" onClick={() => copyText(r.value)} className="text-slate-300 hover:text-momo-600 transition-colors shrink-0 text-sm" title="Copiar">⧉</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── open tickets ─────────────────────────────────────────────────────────────

function SectionOpenTickets({ meta, onResolve, resolving, resolveError }) {
  const open = meta?.openConversations || [];
  if (!open.length) return null;
  const multiple = open.length > 1;

  return (
    <div className={`mb-4 rounded-xl border overflow-hidden shadow-sm ${multiple ? 'border-orange-300' : 'border-emerald-200'}`}>
      <div className={`px-4 py-2.5 flex items-center gap-2 ${multiple ? 'bg-orange-500' : 'bg-emerald-600'}`}>
        <span className="text-white font-bold text-sm">
          {open.length === 1 ? 'Ticket abierto' : `${open.length} tickets abiertos`}
        </span>
        {multiple && <span className="text-orange-100 text-xs ml-1">— Posibles duplicados, verifica</span>}
      </div>
      <div className="bg-white divide-y divide-slate-100">
        {open.map((oc) => {
          const url = chatwootConversationUrl(meta.chatwootApp, oc.conversationId);
          return (
            <div key={oc.conversationId} className="px-4 py-3 flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-slate-800 text-sm">#{oc.ticketId}</span>
                  <span className="text-xs text-slate-500">{oc.channel || '—'}</span>
                  <span className="text-xs text-slate-400">{formatIso(oc.date)}</span>
                </div>
                {oc.geminiSummary && (
                  <p className="text-xs text-slate-600 mt-1 leading-relaxed line-clamp-2">{oc.geminiSummary}</p>
                )}
                {oc.agent && <p className="text-[11px] text-slate-400 mt-0.5">Agente: {oc.agent}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {url && (
                  <a href={url} target="_blank" rel="noreferrer"
                    className="rounded-lg bg-momo-600 text-white text-xs font-semibold px-3 py-1.5 hover:bg-momo-700 transition-colors">
                    Abrir ticket
                  </a>
                )}
                {multiple && onResolve && (
                  <button type="button" disabled={resolving}
                    onClick={() => { if (window.confirm(`¿Marcar #${oc.ticketId} como resuelta?`)) onResolve(oc.conversationId); }}
                    className="rounded-lg border border-slate-300 text-slate-700 text-xs font-medium px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50">
                    Resolver
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {resolveError && <p className="text-red-700 text-xs px-4 pb-3">{resolveError}</p>}
    </div>
  );
}

// ─── similar tickets ──────────────────────────────────────────────────────────

function SectionSimilarTickets({ meta }) {
  const groups = meta?.similarTickets || [];
  if (!groups.length) return null;
  const chatwootApp = meta?.chatwootApp;

  return (
    <CollapsibleResultSection title="Tickets relacionados" badge={groups.length} defaultOpen>
      {groups.map((g) => {
        const url = chatwootConversationUrl(chatwootApp, g.conversationId);
        return (
          <div key={g.conversationId} className="px-4 py-3 flex flex-wrap items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-slate-800 text-sm">Conversación #{g.conversationId}</span>
                <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${g.confident ? 'bg-momo-100 text-momo-800' : 'bg-amber-100 text-amber-700'}`}>
                  {g.matches.length} coincidencia{g.matches.length !== 1 ? 's' : ''}
                </span>
              </div>
              {!g.confident && (
                <p className="text-[11px] text-amber-600 mt-0.5 italic">Solo 1 similitud — puede no ser el mismo caso</p>
              )}
              <div className="flex flex-wrap gap-1 mt-1.5">
                {g.matches.map((m, i) => (
                  <span key={i} className="text-[11px] bg-slate-100 text-slate-700 rounded-full px-2 py-0.5 font-medium">
                    {m.label}: {m.value}
                  </span>
                ))}
              </div>
            </div>
            {url && (
              <a href={url} target="_blank" rel="noreferrer"
                className="text-xs font-semibold text-momo-700 hover:text-momo-900 underline shrink-0 mt-0.5">
                Abrir →
              </a>
            )}
          </div>
        );
      })}
    </CollapsibleResultSection>
  );
}

// ─── bsale ────────────────────────────────────────────────────────────────────

function SectionBsale({ block, shopifyBlock }) {
  if (!block || block.status === 'error') {
    if (!block?.error) return null;
    return (
      <CollapsibleResultSection title="Boletas" badge={0} error={block.error} defaultOpen={false}>
        <p className="px-4 py-3 text-sm text-slate-400">Sin boletas</p>
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

  const subtitle = hasShopifyOrders ? 'También hay pedido en Shopify' : undefined;

  return (
    <CollapsibleResultSection title="Boletas" badge={items.length} subtitle={subtitle} defaultOpen>
      {[...grouped.entries()].map(([clientKey, docs]) => {
        const client = clientMap[clientKey];
        const clientName = client?.name || null;
        const showHeader = clientName && grouped.size > 1;

        return (
          <div key={clientKey}>
            {showHeader && (
              <div className="px-4 py-2 bg-slate-50 border-b border-slate-100">
                <p className="text-xs font-semibold text-slate-700">{clientName}</p>
                {client.email && <p className="text-[11px] text-slate-400">{client.email}</p>}
              </div>
            )}
            {docs.map((row) => (
              <div key={`bsale-${row.id}`} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-bold text-slate-800 text-sm">Boleta N° {row.number}</span>
                      <span className="text-xs text-slate-500">{formatUnix(row.emissionDate)}</span>
                      {row.total != null && (
                        <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                          ${Number(row.total).toLocaleString('es-CL')}
                        </span>
                      )}
                    </div>
                    {row.items?.length > 0 && (
                      <ul className="space-y-0.5">
                        {row.items.slice(0, 3).map((item, i) => (
                          <li key={i} className="text-xs text-slate-600 flex gap-1.5">
                            <span className="text-slate-400 shrink-0 font-medium">{item.quantity}×</span>
                            <span className="truncate">{item.description || '—'}</span>
                          </li>
                        ))}
                        {row.items.length > 3 && (
                          <li className="text-[11px] text-slate-400">+{row.items.length - 3} producto{row.items.length - 3 !== 1 ? 's' : ''} más</li>
                        )}
                      </ul>
                    )}
                  </div>
                  {row.urlPublicView && (
                    <a href={row.urlPublicView} target="_blank" rel="noreferrer"
                      className="rounded-lg bg-slate-800 text-white text-xs font-semibold px-3 py-1.5 hover:bg-slate-700 transition-colors shrink-0">
                      Ver boleta
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </CollapsibleResultSection>
  );
}

// ─── shopify ──────────────────────────────────────────────────────────────────

function SectionShopify({ block }) {
  if (!block || block.status === 'error') {
    if (!block?.error) return null;
    return (
      <CollapsibleResultSection title="Pedidos Shopify" badge={0} error={block.error} defaultOpen={false}>
        <p className="px-4 py-3 text-sm text-slate-400">Sin pedidos</p>
      </CollapsibleResultSection>
    );
  }
  if (!block.data || block.data.skipped) return null;
  const customers = block.data.customers || [];
  const orders = block.data.orders || [];
  if (!customers.length && !orders.length) return null;

  const payLabel = (s) => {
    if (!s) return null;
    const map = { paid: 'Pagado', pending: 'Pago pendiente', refunded: 'Reembolsado', partially_paid: 'Pago parcial', voided: 'Anulado' };
    return map[s] || s;
  };
  const fulfillLabel = (s) => {
    if (!s) return null;
    const map = { fulfilled: 'Entregado', partial: 'Entrega parcial', unfulfilled: 'Sin enviar', restocked: 'Devuelto' };
    return map[s] || s;
  };

  return (
    <CollapsibleResultSection title="Pedidos Shopify" badge={orders.length + customers.length} defaultOpen>
      {orders.map((o) => (
        <div key={o.id} className="px-4 py-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-black text-momo-700 text-lg tracking-tight">{o.name || `#${o.id}`}</span>
                {payLabel(o.financialStatus) && (
                  <span className="text-[11px] font-semibold rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5">
                    {payLabel(o.financialStatus)}
                  </span>
                )}
                {fulfillLabel(o.fulfillmentStatus) && (
                  <span className="text-[11px] font-semibold rounded-full bg-blue-100 text-blue-800 px-2 py-0.5">
                    {fulfillLabel(o.fulfillmentStatus)}
                  </span>
                )}
                <button type="button" onClick={() => copyText(o.name || String(o.id))}
                  className="text-slate-300 hover:text-momo-600 text-sm" title="Copiar N° pedido">⧉</button>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                {formatIso(o.createdAt)}{o.totalPrice ? ` · $${Number(o.totalPrice).toLocaleString('es-CL')} ${o.currency || ''}` : ''}
              </p>
            </div>
            <div className="flex flex-col gap-1.5 shrink-0">
              {o.adminUrl && (
                <a href={o.adminUrl} target="_blank" rel="noreferrer"
                  className="rounded-lg bg-momo-600 text-white text-xs font-semibold px-3 py-1.5 hover:bg-momo-700 transition-colors text-center">
                  Ver pedido
                </a>
              )}
              {o.adminOrdersSearchUrl && (
                <a href={o.adminOrdersSearchUrl} target="_blank" rel="noreferrer"
                  className="rounded-lg border border-momo-200 text-momo-700 text-xs font-medium px-3 py-1.5 hover:bg-momo-50 transition-colors text-center">
                  Buscar en admin
                </a>
              )}
            </div>
          </div>
        </div>
      ))}
      {customers.length > 0 && (
        <div className="px-4 py-3 border-t border-slate-100">
          <p className="text-xs font-semibold text-slate-500 mb-2">Cliente en Shopify</p>
          {customers.map((c) => (
            <div key={c.id} className="text-sm text-slate-800">
              <span className="font-medium">{[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}</span>
              <span className="text-xs text-slate-500 ml-2">{c.email || ''} {c.phone ? `· ${c.phone}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </CollapsibleResultSection>
  );
}

// ─── conversation card ────────────────────────────────────────────────────────

function ConversationCard({ row, chatwootApp }) {
  const url = chatwootConversationUrl(chatwootApp, row.conversationId);
  const { label: statusLabel, cls: statusCls } = statusBadge(row.status, row.isOpen);

  return (
    <div className="px-4 py-3">
      {/* header */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-slate-800 text-sm">#{row.ticketId}</span>
          <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${statusCls}`}>{statusLabel}</span>
          {row.stTagged && (
            <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-momo-100 text-momo-700">Serv. Técnico</span>
          )}
        </div>
        <span className="text-xs text-slate-400 shrink-0">{formatIso(row.date)}</span>
      </div>

      {/* summary — main content */}
      {row.geminiSummary ? (
        <div className="bg-momo-50 rounded-lg px-3 py-2.5 mb-2 border border-momo-100">
          <p className="text-[10px] font-bold text-momo-600 uppercase tracking-wide mb-1">Resumen IA</p>
          <p className="text-sm text-slate-800 leading-relaxed">{row.geminiSummary}</p>
        </div>
      ) : (
        <p className="text-xs text-slate-400 italic mb-2">Sin resumen disponible para este ticket</p>
      )}

      {/* device facts */}
      {row.deviceFacts?.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {row.deviceFacts.map((f, i) => (
            <span key={i} className="text-[11px] bg-slate-100 text-slate-700 rounded-full px-2 py-0.5">
              {f.label}: {f.value}
            </span>
          ))}
        </div>
      )}

      {/* footer */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-400">
          {row.channel || '—'}{row.agent ? ` · ${row.agent}` : ''}
        </span>
        {url && (
          <a href={url} target="_blank" rel="noreferrer"
            className="text-xs font-semibold text-momo-700 hover:text-momo-900 underline">
            Abrir ticket →
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
      {items.map((row) => (
        <ConversationCard key={`conv-${row.conversationId}`} row={row} chatwootApp={chatwootApp} />
      ))}
    </CollapsibleResultSection>
  );
}

// ─── drive ────────────────────────────────────────────────────────────────────

function DriveFileRow({ file }) {
  const [showPreview, setShowPreview] = useState(false);
  const previewSrc = driveEmbedPreviewUrl(file);
  const kind = driveFileKindLabel(file.mimeType);
  const href = file.webViewLink || (file.id ? `https://drive.google.com/file/d/${file.id}/view` : '#');
  const pdfExport = drivePdfAltUrl(file);

  return (
    <div className="flex items-start gap-3 py-2">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-800 truncate">{file.name}</p>
        <p className="text-xs text-slate-400">{kind}</p>
      </div>
      <div className="flex gap-2 shrink-0 text-xs font-medium text-momo-700">
        <a href={href} target="_blank" rel="noreferrer" className="underline hover:text-momo-900">Abrir</a>
        {pdfExport && <a href={pdfExport} target="_blank" rel="noreferrer" className="underline hover:text-momo-900">PDF</a>}
        {previewSrc && (
          <button type="button" onClick={() => setShowPreview((v) => !v)} className="underline hover:text-momo-900">
            {showPreview ? 'Cerrar' : 'Preview'}
          </button>
        )}
      </div>
      {showPreview && previewSrc && (
        <div className="mt-2 rounded border border-slate-200 overflow-hidden w-full">
          <iframe title={file.name} src={previewSrc} className="w-full h-48 border-0" />
        </div>
      )}
    </div>
  );
}

function SectionDrive({ block, meta, query }) {
  if (!block) return null;
  if (block.status === 'error') {
    return (
      <CollapsibleResultSection title="Google Drive" badge={0} error={block.error} defaultOpen>
        <p className="px-4 py-3 text-sm text-slate-400">Error al buscar en Drive</p>
      </CollapsibleResultSection>
    );
  }
  const d = block.data || {};
  const folders = d.folders || [];
  const hasHits = folders.some((f) => f.found);
  const stCount = (meta?.stOrdersFromChatwoot || []).length;
  if (!hasHits && d.skipped && !stCount) return null;

  return (
    <CollapsibleResultSection title="Drive (Servicio técnico)" badge={folders.filter((f) => f.found).length} defaultOpen={hasHits}>
      {!hasHits && d.skipped && (
        <p className="px-4 py-3 text-sm text-slate-400">
          Órdenes: {(meta?.stOrdersFromChatwoot || []).join(', ') || '—'}. {d.reason || ''}
        </p>
      )}
      {folders.map((f) => (
        <div key={f.order} className="px-4 py-3">
          <p className="text-sm font-semibold text-slate-700 mb-1">
            Orden {f.order} {f.found ? '' : '— sin carpeta'}
          </p>
          {f.error && <p className="text-xs text-red-600">{f.error}</p>}
          {f.files?.length > 0 && (
            <div className="space-y-1.5">{f.files.map((file) => <DriveFileRow key={file.id} file={file} />)}</div>
          )}
        </div>
      ))}
    </CollapsibleResultSection>
  );
}

// ─── ST banner ────────────────────────────────────────────────────────────────

function StBanner({ meta }) {
  if (!meta?.recentSt?.showBanner) return null;
  return (
    <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex gap-3 items-start">
      <span className="text-lg shrink-0">⚠️</span>
      <div>
        <p className="font-semibold text-amber-900 text-sm">Actividad en Servicio Técnico (últimos 90 días)</p>
        {meta.recentSt.lastDate && (
          <p className="text-xs text-amber-800 mt-0.5">Último hito: {formatIso(meta.recentSt.lastDate)}</p>
        )}
      </div>
    </div>
  );
}

// ─── main page ────────────────────────────────────────────────────────────────

export default function SearchPage() {
  const qc = useQueryClient();
  const embed = isDashboardEmbed();
  const [input, setInput] = useState('');
  const debounced = useDebouncedValue(input.trim(), 400);
  const canSearch = debounced.length >= 2;

  const resolveConversation = useMutation({
    mutationFn: resolveChatwootConversation,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['search', debounced] }),
  });

  const { data, isFetching, isError, error } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => fetchSearch(debounced),
    enabled: canSearch,
  });

  const cw = data?.chatwoot;
  const bs = data?.bsale;
  const sh = data?.shopify;
  const dr = data?.drive;
  const meta = data?.meta;

  return (
    <div className={embed ? 'px-3 py-4' : 'max-w-2xl mx-auto px-4 py-8'}>

      {/* search bar */}
      <div className="mb-5">
        <div className="relative">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-base pointer-events-none">🔍</span>
          <input
            id="q"
            type="search"
            autoComplete="off"
            placeholder="ID, IMEI, RUT, correo o nombre completo…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white pl-10 pr-4 py-3 text-slate-900 text-sm shadow-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-momo-400 focus:border-momo-400"
          />
        </div>
      </div>

      {/* debug (embed only) */}
      {/* empty state */}
      {!canSearch && !isFetching && (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white/60 py-10 text-center px-4">
          <p className="text-2xl mb-2">🔎</p>
          <p className="text-sm font-medium text-slate-600 mb-3">¿Qué puedes buscar?</p>
          <div className="flex flex-wrap justify-center gap-2 text-xs">
            {[
              ['ID conversación', '1234'],
              ['IMEI', '358123456789012'],
              ['RUT', '12.345.678-9'],
              ['Correo', 'cliente@mail.com'],
              ['Nombre completo', 'Ana García'],
              ['N° pedido', '#SM38293'],
            ].map(([label, ex]) => (
              <button
                key={label}
                type="button"
                onClick={() => setInput(ex)}
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-slate-600 hover:border-momo-300 hover:text-momo-700 hover:bg-momo-50 transition-colors"
              >
                <span className="font-medium">{label}</span>
                <span className="text-slate-400 ml-1">· {ex}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* loading */}
      {canSearch && isFetching && (
        <div className="flex items-center gap-2 text-sm text-momo-600 mb-4">
          <span className="inline-block h-3 w-3 rounded-full border-2 border-momo-400 border-t-transparent animate-spin" />
          Consultando Chatwoot, Bsale y Shopify…
        </div>
      )}

      {/* error */}
      {canSearch && isError && (
        <div className="rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm px-4 py-3 mb-4">
          {error?.message || 'Error al buscar'}
        </div>
      )}

      {canSearch && !isError && data && (
        <div className="space-y-4">
          {/* source pills */}
          <SourceStatusBar data={data} meta={meta} />

          {/* profile */}
          <ProfileCard meta={meta} bsBlock={bs} cwBlock={cw} />

          {/* open tickets */}
          <SectionOpenTickets
            meta={meta}
            onResolve={(id) => resolveConversation.mutate(id)}
            resolving={resolveConversation.isPending}
            resolveError={resolveConversation.isError ? resolveConversation.error?.message : null}
          />

          {/* ST banner */}
          <StBanner meta={meta} />

          {/* similar tickets */}
          <SectionSimilarTickets meta={meta} />

          {/* bsale */}
          <SectionBsale block={bs} shopifyBlock={sh} />

          {/* shopify */}
          <SectionShopify block={sh} />

          {/* chatwoot ST */}
          <SectionConversations
            block={cw}
            chatwootApp={meta?.chatwootApp}
            title="Servicio técnico"
            subtitle="Tickets con etiqueta ST"
            defaultOpen
          />

          {/* chatwoot general */}
          <SectionConversations
            block={cw}
            chatwootApp={meta?.chatwootApp}
            title="Historial de conversaciones"
            subtitle="Otros tickets del contacto"
            defaultOpen
          />

          {/* drive */}
          <SectionDrive block={dr} meta={meta} query={data?.query} />

          {/* notes */}
          {meta?.bsaleNote && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{meta.bsaleNote}</div>
          )}
          {meta?.shopifyNote && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{meta.shopifyNote}</div>
          )}
          {meta?.strictNameNote && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">{meta.strictNameNote}</div>
          )}
        </div>
      )}
    </div>
  );
}
