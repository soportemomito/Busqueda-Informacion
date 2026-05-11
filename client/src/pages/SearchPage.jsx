import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSearch, fetchSetup, resolveChatwootConversation } from '../api/client.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { useChatwootDashboardContext, isDashboardEmbed } from '../hooks/useChatwootDashboardContext.js';
import { CollapsibleResultSection, ExpandableRow } from '../components/CollapsibleResultSection.jsx';

function formatUnix(ts) {
  if (ts == null) return '—';
  const n = Number(ts);
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('es-CL') : '—';
}

function formatIso(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('es-CL') : String(iso);
}

function chatwootConversationUrl(app, conversationId) {
  if (!app?.baseUrl || conversationId == null) return null;
  return `${app.baseUrl}/app/accounts/${app.accountId}/conversations/${conversationId}`;
}

function driveFileKindLabel(mimeType) {
  const m = String(mimeType || '');
  if (m === 'application/pdf') return 'PDF';
  if (m === 'application/vnd.google-apps.document') return 'Google Doc';
  if (m === 'application/vnd.google-apps.spreadsheet') return 'Hoja';
  if (m === 'application/vnd.google-apps.presentation') return 'Presentación';
  if (m.startsWith('image/')) return 'Imagen';
  return 'Archivo';
}

function drivePdfAltUrl(file) {
  const mime = file.mimeType || '';
  const id = file.id;
  if (!id) return null;
  if (mime === 'application/vnd.google-apps.document') {
    return `https://docs.google.com/document/d/${id}/export?format=pdf`;
  }
  if (mime === 'application/vnd.google-apps.spreadsheet') {
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=pdf`;
  }
  return null;
}

function driveEmbedPreviewUrl(file) {
  const id = file?.id;
  if (!id) return null;
  const mime = file.mimeType || '';
  if (mime === 'application/pdf') return `https://drive.google.com/file/d/${id}/preview`;
  if (mime === 'application/vnd.google-apps.document') {
    return `https://docs.google.com/document/d/${id}/preview`;
  }
  if (mime === 'application/vnd.google-apps.spreadsheet') {
    return `https://docs.google.com/spreadsheets/d/${id}/preview`;
  }
  return null;
}

function DeviceFactsTable({ facts, showConvCol }) {
  if (!facts?.length) return null;
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200/90 bg-white">
      <table className="min-w-full text-left text-xs">
        <tbody>
          {facts.map((r, i) => (
            <tr key={`${r.label}-${i}`} className="border-t border-slate-100 first:border-t-0">
              <th className="py-1.5 px-2 font-semibold text-slate-600 align-top whitespace-nowrap w-[1%]">
                {r.label}
              </th>
              <td className="py-1.5 px-2 text-slate-900 tabular-nums break-all">{r.value}</td>
              {showConvCol && r.conversationId != null && (
                <td className="py-1.5 px-2 text-slate-500 whitespace-nowrap w-[1%]">
                  #{r.conversationId}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeviceFactsChips({ facts, max = 4 }) {
  if (!facts?.length) return null;
  const slice = facts.slice(0, max);
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {slice.map((r, i) => (
        <span
          key={`${r.label}-${i}`}
          className="inline-flex items-center gap-1 rounded-md bg-slate-100 text-slate-800 px-1.5 py-0.5 text-[10px] leading-tight"
        >
          <span className="font-semibold text-slate-600">{r.label}:</span>
          <span className="truncate max-w-[140px]">{r.value}</span>
        </span>
      ))}
      {facts.length > max && (
        <span className="text-[10px] text-slate-500 self-center">+{facts.length - max}</span>
      )}
    </div>
  );
}

async function copyText(text) {
  const t = String(text || '');
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    window.prompt('Copiar:', t);
  }
}

/** Estado por fuente para la tira de checkboxes (sin depender del párrafo largo). */
function deriveSourceStatuses(data, meta) {
  const items = [];

  const cw = data?.chatwoot;
  if (cw?.status === 'error') {
    items.push({
      id: 'chatwoot',
      label: 'Chatwoot',
      tone: 'error',
      checked: false,
      caption: 'Falló',
      title: cw.error || 'Error',
    });
  } else {
    const s = meta?.sources?.chatwoot;
    items.push({
      id: 'chatwoot',
      label: 'Chatwoot',
      tone: 'ok',
      checked: true,
      caption: 'Ok',
      title: s
        ? `${s.contacts} contactos · ${s.conversations} conv. · ${s.openConversations} abiertas · ST en mensajes: ${s.stOrdersDetected}`
        : 'Consulta correcta',
    });
  }

  const bs = data?.bsale;
  if (bs?.status === 'error') {
    items.push({
      id: 'bsale',
      label: 'Bsale',
      tone: 'error',
      checked: false,
      caption: 'Falló',
      title: bs.error || 'Error',
    });
  } else {
    const s = meta?.sources?.bsale;
    items.push({
      id: 'bsale',
      label: 'Bsale',
      tone: 'ok',
      checked: true,
      caption: 'Ok',
      title: s ? `${s.clients} clientes · ${s.documents} documentos` : 'Consulta correcta',
    });
  }

  const sh = data?.shopify;
  if (sh?.status === 'error') {
    items.push({
      id: 'shopify',
      label: 'Shopify',
      tone: 'error',
      checked: false,
      caption: 'Falló',
      title: sh.error || 'Error',
    });
  } else if (sh?.data?.skipped) {
    items.push({
      id: 'shopify',
      label: 'Shopify',
      tone: 'skipped',
      checked: false,
      caption: 'N/A',
      title: 'No consultado (sin término o sin token)',
    });
  } else {
    const s = meta?.sources?.shopify;
    items.push({
      id: 'shopify',
      label: 'Shopify',
      tone: 'ok',
      checked: true,
      caption: 'Ok',
      title: s ? `${s.customers} clientes · ${s.orders} pedidos` : 'Consulta correcta',
    });
  }

  const dr = data?.drive;
  if (dr?.status === 'error') {
    items.push({
      id: 'drive',
      label: 'Drive',
      tone: 'error',
      checked: false,
      caption: 'Falló',
      title: dr.error || 'Error',
    });
  } else if (dr?.data?.skipped) {
    items.push({
      id: 'drive',
      label: 'Drive',
      tone: 'skipped',
      checked: false,
      caption: 'N/A',
      title: dr.data?.reason || 'No se buscó en Drive',
    });
  } else {
    const folders = dr?.data?.folders || [];
    const hasFiles = folders.some((f) => (f.files && f.files.length > 0) || f.found);
    if (!folders.length) {
      items.push({
        id: 'drive',
        label: 'Drive',
        tone: 'warn',
        checked: false,
        caption: 'Sin datos',
        title: 'Sin carpetas ni archivos para las órdenes detectadas',
      });
    } else if (hasFiles) {
      items.push({
        id: 'drive',
        label: 'Drive',
        tone: 'ok',
        checked: true,
        caption: 'Ok',
        title: `${folders.length} orden(es) revisada(s) en Drive`,
      });
    } else {
      items.push({
        id: 'drive',
        label: 'Drive',
        tone: 'warn',
        checked: false,
        caption: 'Sin datos',
        title: 'Órdenes listadas pero sin archivos',
      });
    }
  }

  return items;
}

function SourceStatusBar({ data, meta }) {
  if (!data || !meta) return null;
  const items = deriveSourceStatuses(data, meta);
  const pill = {
    ok: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    error: 'bg-red-50 text-red-800 border-red-200',
    warn: 'bg-amber-50 text-amber-800 border-amber-200',
    skipped: 'bg-slate-50 text-slate-500 border-slate-200',
  };
  const dot = {
    ok: 'bg-emerald-500',
    error: 'bg-red-500',
    warn: 'bg-amber-400',
    skipped: 'bg-slate-300',
  };
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {items.map((it) => (
        <span
          key={it.id}
          title={it.title}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${pill[it.tone]}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dot[it.tone]}`} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export default function SearchPage() {
  const qc = useQueryClient();
  const embed = isDashboardEmbed();
  const dashCtx = useChatwootDashboardContext();
  const [input, setInput] = useState('');
  const debounced = useDebouncedValue(input.trim(), 400);
  const canSearch = debounced.length >= 2;

  const resolveConversation = useMutation({
    mutationFn: resolveChatwootConversation,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['search', debounced] });
    },
  });

  useEffect(() => {
    if (dashCtx?.query) setInput(dashCtx.query);
  }, [dashCtx?.query, dashCtx?.receivedAt]);

  const { data: setup } = useQuery({
    queryKey: ['setup'],
    queryFn: fetchSetup,
    staleTime: 60_000,
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

  const shellCls = embed ? 'max-w-4xl mx-auto px-3 py-4' : 'max-w-5xl mx-auto px-4 py-8';

  return (
    <div className={shellCls}>
      {embed && (
        <p className="text-[11px] text-momo-600 mb-3 border-b border-momo-200 pb-2 leading-snug">
          Búsqueda automática al abrir una conversación: extrae contacto, tickets, pedidos Shopify (#SM…), IMEI/SIM y más. Puedes buscar también manualmente.
        </p>
      )}

      {setup && (!setup.chatwoot?.ready || !setup.bsale?.ready) && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <p className="font-medium">Modo local: revisa credenciales en server/.env</p>
          <ul className="mt-2 space-y-1 text-amber-900/90 list-disc list-inside text-xs">
            {!setup.chatwoot?.ready && <li>Chatwoot: {setup.chatwoot?.hint}</li>}
            {!setup.bsale?.ready && <li>Bsale: {setup.bsale?.hint}</li>}
          </ul>
          <p className="mt-2 text-xs">{setup.localEnvHelp?.restart}</p>
        </div>
      )}

      {meta?.unifiedProfile?.merged && canSearch && !isError && (
        <div className="mb-3 rounded-lg bg-green-50 border border-green-200 text-green-900 text-xs px-3 py-2">
          Perfil unificado: mismo correo detectado en Chatwoot y Bsale.
        </div>
      )}

      {meta?.unifiedProfile?.shopifyEmailOverlap && canSearch && !isError && (
        <div className="mb-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs px-3 py-2">
          Correo del cliente también aparece en Shopify.
        </div>
      )}


      <div className="mb-5">
        <label htmlFor="q" className={`block font-medium text-momo-800 mb-1.5 ${embed ? 'text-xs' : 'text-sm'}`}>
          Búsqueda unificada
        </label>
        <input
          id="q"
          type="search"
          autoComplete="off"
          placeholder="correo · +569… · nombre apellido · #SM1234 · cw:12345"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className={`w-full rounded-xl border border-momo-200 bg-white px-3 text-momo-900 shadow-sm placeholder:text-momo-400 focus:outline-none focus:ring-2 focus:ring-momo-400 focus:border-momo-400 ${
            embed ? 'py-2 text-sm' : 'py-3'
          }`}
        />
        <p className="mt-1.5 text-[11px] text-momo-500 leading-snug">
          {canSearch
            ? 'Debounce 400 ms. Pedido Shopify: #SM1234. Ticket Chatwoot: cw:12345.'
            : 'Mínimo 2 caracteres.'}
        </p>
      </div>

      {!canSearch && (
        <p className="text-sm text-momo-600 text-center py-8 border border-dashed border-momo-200 rounded-xl bg-white/60">
          Bsale (documentos), Shopify (clientes y pedidos), Chatwoot (ST + conversaciones + mensajes) y Drive (órdenes ST).
        </p>
      )}

      {canSearch && isFetching && (
        <p className="text-sm text-momo-600 mb-4 animate-pulse">Consultando fuentes…</p>
      )}

      {canSearch && isError && (
        <div className="rounded-xl bg-red-50 border border-red-200 text-red-900 text-sm px-4 py-3 mb-4">
          {error?.message || 'Error al buscar'}
        </div>
      )}

      {canSearch && !isError && data && (
        <>
          <ContactInfoTable meta={meta} bsBlock={bs} cwBlock={cw} dense={embed} />
          <SectionOpenTickets
            meta={meta}
            onResolve={(id) => resolveConversation.mutate(id)}
            resolving={resolveConversation.isPending}
            resolveError={resolveConversation.isError ? resolveConversation.error?.message : null}
            dense={embed}
          />
          <SourceStatusBar data={data} meta={meta} />
        </>
      )}

      {meta?.bsaleNote && canSearch && !isError && (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {meta.bsaleNote}
        </div>
      )}

      {meta?.shopifyNote && canSearch && !isError && (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {meta.shopifyNote}
        </div>
      )}

      {meta?.strictNameNote && canSearch && !isError && (
        <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
          <span className="font-medium">Filtro de nombre: </span>
          {meta.strictNameNote}
        </div>
      )}

      {meta?.equipmentFacts?.length > 0 && canSearch && !isError && (
        <div className="mb-3 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
          <p className="text-[11px] font-semibold text-slate-700 uppercase tracking-wide mb-2">
            Datos de equipo (desde mensajes)
          </p>
          <DeviceFactsTable facts={meta.equipmentFacts} showConvCol />
        </div>
      )}

      {meta?.recentSt?.showBanner && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-amber-950 text-sm flex gap-2 items-start">
          <span aria-hidden>⚠️</span>
          <div>
            <p className="font-semibold">Actividad ST reciente (&lt; 90 días)</p>
            <p className="text-xs mt-1 text-amber-900/90">
              {meta.recentSt.lastDate ? `Último hito: ${formatIso(meta.recentSt.lastDate)}` : ''}
            </p>
          </div>
        </div>
      )}

      {canSearch && !isError && data && (
        <div className={`space-y-2 ${embed ? 'space-y-2' : 'space-y-3'}`}>
          {cw?.status === 'error' && (
            <div className="rounded-lg border border-red-200 bg-red-50 text-red-900 text-xs px-3 py-2">
              Chatwoot: {cw.error}
            </div>
          )}
          <SectionSimilarTickets meta={meta} dense={embed} />
          <SectionBsale block={bs} dense={embed} />
          <SectionShopify block={sh} dense={embed} />
          <SectionChatwootST block={cw} chatwootApp={meta?.chatwootApp} dense={embed} />
          <SectionChatwootGeneral block={cw} chatwootApp={meta?.chatwootApp} dense={embed} />
          <SectionDrive block={dr} meta={meta} dense={embed} query={data?.query} />
        </div>
      )}
    </div>
  );
}

function ContactInfoTable({ meta, bsBlock, cwBlock, dense }) {
  const cs = meta?.contactSummary;
  const facts = meta?.equipmentFacts || [];
  const rows = [];

  const name = cs?.name || cwBlock?.data?.contacts?.[0]?.name;
  if (name) rows.push({ label: 'Nombre', value: name, copy: true });

  const email = cs?.email;
  if (email) rows.push({ label: 'Mail', value: email, copy: true });

  const phone = cs?.phone || cwBlock?.data?.contacts?.[0]?.phone;
  if (phone) rows.push({ label: 'Teléfono', value: phone, copy: true });

  const rut = (cs?.ruts || facts.filter((f) => f.label === 'RUT').map((f) => f.value))[0];
  if (rut) rows.push({ label: 'RUT', value: rut, copy: true });

  const smOrders = cs?.smOrders || cwBlock?.data?.shopifyOrdersFromMessages || [];
  if (smOrders.length) rows.push({ label: 'SM / Pedido', value: smOrders.join(', '), copy: true });

  const bsaleItem = bsBlock?.data?.items?.[0];
  if (bsaleItem) {
    rows.push({
      label: 'Boleta Bsale',
      value: `N° ${bsaleItem.number} · ${bsaleItem.documentType || 'Doc'}`,
      link: bsaleItem.urlPublicView || null,
    });
  }

  const imei = facts.find((f) => f.label === 'ID / IMEI')?.value;
  if (imei) rows.push({ label: 'ID / IMEI', value: imei, copy: true });

  const sim = facts.find((f) => f.label === 'ICCID / SIM')?.value;
  if (sim) rows.push({ label: 'SIM (ICCID)', value: sim, copy: true });

  if (!rows.length) return null;

  return (
    <div className="mb-3 rounded-lg border border-momo-200 bg-white shadow-sm overflow-hidden">
      <p className="text-[10px] font-semibold text-momo-700 uppercase tracking-wide px-3 py-2 border-b border-momo-100 bg-momo-50/60">
        Datos recopilados del cliente
      </p>
      <div className="divide-y divide-slate-100">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2 px-3 py-1.5">
            <span className={`font-semibold text-momo-600 shrink-0 ${dense ? 'text-[10px] w-20' : 'text-[11px] w-24'}`}>
              {r.label}
            </span>
            <span className={`text-slate-900 break-all flex-1 ${dense ? 'text-[11px]' : 'text-xs'}`}>
              {r.link ? (
                <a href={r.link} target="_blank" rel="noreferrer" className="underline text-momo-700">
                  {r.value}
                </a>
              ) : (
                r.value
              )}
            </span>
            {r.copy && (
              <button
                type="button"
                onClick={() => copyText(r.value)}
                className="text-[10px] text-momo-400 hover:text-momo-700 shrink-0"
                title="Copiar"
              >
                ⧉
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionSimilarTickets({ meta, dense }) {
  const groups = meta?.similarTickets || [];
  if (!groups.length) return null;

  const chatwootApp = meta?.chatwootApp;

  return (
    <CollapsibleResultSection
      title="Tickets similares"
      subtitle="Comparten identificadores con este ticket"
      badge={groups.length}
      defaultOpen
      dense={dense}
    >
      {groups.map((g) => {
        const url = chatwootConversationUrl(chatwootApp, g.conversationId);
        return (
          <ExpandableRow
            key={g.conversationId}
            dense={dense}
            summary={
              <div className="space-y-1">
                <div className={`flex flex-wrap items-center gap-2 ${dense ? 'text-[11px]' : 'text-xs'}`}>
                  <span className="font-semibold text-momo-900">
                    Conversación #{g.conversationId}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      g.confident
                        ? 'bg-momo-100 text-momo-800'
                        : 'bg-amber-100 text-amber-800'
                    }`}
                  >
                    {g.matches.length} coincidencia{g.matches.length !== 1 ? 's' : ''}
                  </span>
                  {!g.confident && (
                    <span className="text-[10px] text-amber-700 italic">
                      — Solo 1 similitud, puede no ser el mismo caso
                    </span>
                  )}
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-momo-600 underline font-semibold text-[11px] ml-auto"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Abrir →
                    </a>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  {g.matches.map((m, i) => (
                    <span
                      key={i}
                      className="text-[10px] bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded"
                    >
                      {m.label}: {m.value}
                    </span>
                  ))}
                </div>
              </div>
            }
          >
            {JSON.stringify(g, null, 2)}
          </ExpandableRow>
        );
      })}
    </CollapsibleResultSection>
  );
}

function SectionOpenTickets({ meta, onResolve, resolving, resolveError, dense }) {
  const open = meta?.openConversations || [];
  if (!open.length) return null;
  const multiple = open.length > 1;
  return (
    <div
      className={`mb-3 rounded-lg border px-3 py-2.5 ${
        multiple ? 'border-orange-300 bg-orange-50' : 'border-momo-200 bg-momo-50/60'
      }`}
    >
      <p
        className={`text-[11px] font-semibold uppercase tracking-wide mb-2 ${
          multiple ? 'text-orange-900' : 'text-momo-800'
        }`}
      >
        {open.length === 1 ? 'Ticket abierto' : `${open.length} tickets abiertos`}
        {multiple && (
          <span className="ml-2 normal-case font-medium text-orange-700">
            — Verifica si hay duplicados
          </span>
        )}
      </p>
      <ul className="space-y-1.5">
        {open.map((oc) => {
          const url = chatwootConversationUrl(meta.chatwootApp, oc.conversationId);
          return (
            <li
              key={oc.conversationId}
              className={`flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 bg-white/80 ${
                multiple ? 'border-orange-200' : 'border-momo-200/70'
              }`}
            >
              <span
                className={`font-semibold ${dense ? 'text-[11px]' : 'text-xs'} ${
                  multiple ? 'text-orange-950' : 'text-momo-900'
                }`}
              >
                #{oc.ticketId}
              </span>
              <span className={`text-momo-600 ${dense ? 'text-[10px]' : 'text-[11px]'}`}>
                {oc.channel || '—'} · {oc.agent || '—'}
              </span>
              <span className="text-[10px] text-momo-500">{formatIso(oc.date)}</span>
              {url && (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-momo-600 underline font-semibold text-[11px] ml-auto"
                >
                  Abrir →
                </a>
              )}
              {onResolve && (
                <button
                  type="button"
                  disabled={resolving}
                  onClick={() => {
                    if (!window.confirm(`¿Marcar #${oc.ticketId} como resuelta?`)) return;
                    onResolve(oc.conversationId);
                  }}
                  className={`rounded border px-2 py-0.5 text-[11px] disabled:opacity-50 ${
                    multiple
                      ? 'border-orange-300 text-orange-900 hover:bg-orange-50'
                      : 'border-momo-300 text-momo-800 hover:bg-momo-50'
                  } bg-white`}
                >
                  Resolver
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {resolveError && <p className="text-red-800 text-[11px] mt-1">{resolveError}</p>}
    </div>
  );
}

function SectionChatwootST({ block, chatwootApp, dense }) {
  if (!block || block.status !== 'ok' || !block.data) return null;
  const items = block.data.servicioTecnico || [];
  if (!items.length) return null;
  return (
    <CollapsibleResultSection
      title="Servicio técnico (Chatwoot)"
      subtitle="Etiqueta ST · resumen IA si está en atributos"
      badge={items.length}
      defaultOpen
      dense={dense}
    >
      {items.map((row) => (
        <ExpandableRow
          key={`st-${row.conversationId}`}
          dense={dense}
          summary={<CwRowSummary row={row} chatwootApp={chatwootApp} dense={dense} />}
          extra={
            <>
              {row.geminiSummary ? (
                <div className="rounded-md border border-violet-200/80 bg-violet-50/90 px-2.5 py-2 text-violet-950">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-700 mb-1">
                    Resumen IA (Chatwoot)
                  </p>
                  <p className={`leading-relaxed whitespace-pre-wrap ${dense ? 'text-xs' : 'text-sm'}`}>
                    {row.geminiSummary}
                  </p>
                </div>
              ) : null}
              {row.deviceFacts?.length > 0 ? (
                <div>
                  <p className="text-[10px] font-semibold text-slate-600 mb-1">Equipo en mensajes</p>
                  <DeviceFactsTable facts={row.deviceFacts} showConvCol={false} />
                </div>
              ) : null}
            </>
          }
        >
          {JSON.stringify(row.raw ?? row, null, 2)}
        </ExpandableRow>
      ))}
    </CollapsibleResultSection>
  );
}

function SectionChatwootGeneral({ block, chatwootApp, dense }) {
  if (!block || block.status !== 'ok' || !block.data) return null;
  const items = block.data.chatwoot || [];
  if (!items.length) return null;
  return (
    <CollapsibleResultSection
      title="Chatwoot (general)"
      subtitle="Otras conversaciones del contacto"
      badge={items.length}
      defaultOpen={!dense}
      dense={dense}
    >
      {items.map((row) => (
        <ExpandableRow
          key={`cw-${row.conversationId}`}
          dense={dense}
          summary={<CwRowSummary row={row} chatwootApp={chatwootApp} dense={dense} />}
          extra={
            <>
              {row.geminiSummary ? (
                <div className="rounded-md border border-violet-200/80 bg-violet-50/90 px-2.5 py-2 text-violet-950">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-700 mb-1">
                    Resumen IA (Chatwoot)
                  </p>
                  <p className={`leading-relaxed whitespace-pre-wrap ${dense ? 'text-xs' : 'text-sm'}`}>
                    {row.geminiSummary}
                  </p>
                </div>
              ) : null}
              {row.deviceFacts?.length > 0 ? (
                <div>
                  <p className="text-[10px] font-semibold text-slate-600 mb-1">Equipo en mensajes</p>
                  <DeviceFactsTable facts={row.deviceFacts} showConvCol={false} />
                </div>
              ) : null}
            </>
          }
        >
          {JSON.stringify(row.raw ?? row, null, 2)}
        </ExpandableRow>
      ))}
    </CollapsibleResultSection>
  );
}

function CwRowSummary({ row, chatwootApp, dense }) {
  const cwUrl = chatwootConversationUrl(chatwootApp, row.conversationId);
  return (
    <div className="space-y-1">
      <div
        className={`font-medium text-momo-900 flex flex-wrap items-center gap-x-2 gap-y-1 ${dense ? 'text-xs' : 'text-sm'}`}
      >
        <span className="tabular-nums">
          #{row.ticketId} · id {row.conversationId}
        </span>
        <span className="text-momo-600 font-normal">{row.status || '—'}</span>
        {row.isOpen && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-momo-100 text-momo-800">Abierta</span>
        )}
        {cwUrl && (
          <a
            href={cwUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] font-semibold text-momo-600 underline"
            onClick={(e) => e.stopPropagation()}
          >
            Abrir ticket
          </a>
        )}
      </div>
      <div className={`text-momo-600 ${dense ? 'text-[11px]' : 'text-xs'}`}>
        {formatIso(row.date)} · {row.channel || '—'} · {row.agent || '—'}
      </div>
      {row.geminiSummary && (
        <div className={`text-momo-800 line-clamp-2 ${dense ? 'text-[11px]' : 'text-xs'}`}>
          <span className="font-semibold text-violet-800">IA:</span> {row.geminiSummary}
        </div>
      )}
      <DeviceFactsChips facts={row.deviceFacts} max={dense ? 3 : 5} />
    </div>
  );
}

function SectionShopify({ block, dense }) {
  if (!block || block.status === 'error') {
    const err = block?.error;
    if (!err) return null;
    return (
      <CollapsibleResultSection
        title="Shopify"
        subtitle="Admin API"
        badge={0}
        error={err}
        defaultOpen={false}
        dense={dense}
      >
        <p className="text-xs text-momo-500 px-2">Sin datos</p>
      </CollapsibleResultSection>
    );
  }
  if (!block.data || block.data.skipped) return null;
  const customers = block.data.customers || [];
  const orders = block.data.orders || [];
  if (!customers.length && !orders.length) return null;

  return (
    <CollapsibleResultSection
      title="Shopify"
      subtitle="Clientes y pedidos (enlaces al admin)"
      badge={customers.length + orders.length}
      defaultOpen
      dense={dense}
    >
      {customers.length > 0 && (
        <div className="mb-3 px-2">
          <p className="text-xs font-medium text-momo-700 mb-2">Clientes</p>
          <ul className="space-y-2 text-sm">
            {customers.map((c) => (
              <li key={c.id} className="rounded-lg border border-momo-100 bg-white p-2">
                <span className="font-medium text-momo-900">
                  {[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}
                </span>
                <div className="text-xs text-momo-600 mt-1">
                  {c.email || '—'} · {c.phone || '—'} · pedidos: {c.ordersCount ?? '—'}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {orders.length > 0 && (
        <div className="px-1">
          <p className="text-[11px] font-semibold text-momo-700 mb-1.5">Pedidos</p>
          <ul className="space-y-1.5">
            {orders.map((o) => (
              <ExpandableRow
                key={o.id}
                dense={dense}
                summary={
                  <div className={`space-y-1 ${dense ? 'text-xs' : 'text-sm'}`}>
                    <div className="font-medium text-momo-900 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="inline-flex items-center rounded-md bg-emerald-50 text-emerald-900 px-2 py-0.5 font-mono text-xs border border-emerald-200/80">
                        {o.name || `#${o.id}`}
                      </span>
                      <span className="text-momo-600 font-normal text-[11px]">
                        {o.financialStatus || '—'} · {o.fulfillmentStatus || '—'}
                      </span>
                      <button
                        type="button"
                        className="text-[11px] font-semibold text-momo-700 underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          copyText(o.name || String(o.id));
                        }}
                      >
                        Copiar n.º
                      </button>
                      {o.adminUrl && (
                        <a
                          href={o.adminUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] font-semibold text-emerald-700 underline"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          Ficha pedido
                        </a>
                      )}
                      {o.adminOrdersSearchUrl && (
                        <a
                          href={o.adminOrdersSearchUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] font-semibold text-emerald-600/90 underline"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          Buscar en admin
                        </a>
                      )}
                    </div>
                    <div className="text-[11px] text-momo-600">
                      {formatIso(o.createdAt)} · Total: {o.totalPrice ?? '—'} {o.currency || ''}
                    </div>
                  </div>
                }
              >
                {JSON.stringify(o.raw ?? o, null, 2)}
              </ExpandableRow>
            ))}
          </ul>
        </div>
      )}
    </CollapsibleResultSection>
  );
}

function SectionBsale({ block, dense }) {
  if (!block || block.status === 'error') {
    const err = block?.error;
    if (!err) return null;
    return (
      <CollapsibleResultSection
        title="Bsale"
        subtitle="Documentos"
        badge={0}
        error={err}
        defaultOpen={false}
        dense={dense}
      >
        <p className="text-xs text-momo-500 px-2">Sin datos</p>
      </CollapsibleResultSection>
    );
  }
  const items = block.data?.items || [];
  if (!items.length) return null;
  return (
    <CollapsibleResultSection
      title="Bsale"
      subtitle="Facturación"
      badge={items.length}
      defaultOpen
      dense={dense}
    >
      {items.map((row) => (
        <ExpandableRow
          key={`bsale-${row.id}`}
          dense={dense}
          summary={
            <div className="space-y-1 text-sm">
              <div className="font-medium text-momo-900 flex flex-wrap items-center gap-2">
                <span>
                  N° {row.number} · {row.documentType || 'Doc'}
                </span>
                {row.urlPublicView && (
                  <a
                    href={row.urlPublicView}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-semibold text-momo-600 underline"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    Ver documento (Bsale)
                  </a>
                )}
              </div>
              <div className="text-xs text-momo-600">
                {row.branch || '—'} · {formatUnix(row.emissionDate)} · Total: {row.total ?? '—'}
              </div>
            </div>
          }
        >
          {JSON.stringify(row.raw ?? row, null, 2)}
        </ExpandableRow>
      ))}
    </CollapsibleResultSection>
  );
}

function DriveFileRow({ file }) {
  const [showPreview, setShowPreview] = useState(false);
  const previewSrc = driveEmbedPreviewUrl(file);
  const kind = driveFileKindLabel(file.mimeType);
  const href = file.webViewLink || (file.id ? `https://drive.google.com/file/d/${file.id}/view` : '#');
  const pdfExport = drivePdfAltUrl(file);

  return (
    <li className="rounded-md bg-white/90 border border-momo-100/90 px-2 py-2">
      <div className="font-medium text-momo-900 text-xs">{file.name}</div>
      <div className="text-momo-500 mt-0.5 text-[10px]">{kind}</div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 items-center">
        <a href={href} target="_blank" rel="noreferrer" className="text-momo-700 underline font-medium text-[11px]">
          Abrir
        </a>
        {pdfExport && (
          <a href={pdfExport} target="_blank" rel="noreferrer" className="text-momo-700 underline font-medium text-[11px]">
            PDF
          </a>
        )}
        {previewSrc && (
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            className="text-momo-700 underline font-medium text-[11px]"
          >
            {showPreview ? 'Ocultar vista previa' : 'Vista previa'}
          </button>
        )}
      </div>
      {showPreview && previewSrc && (
        <div className="mt-2 rounded border border-momo-200 overflow-hidden bg-black/5">
          <iframe title={file.name} src={previewSrc} className="w-full h-[min(240px,40vh)] border-0" />
        </div>
      )}
    </li>
  );
}

function SectionDrive({ block, meta, dense, query }) {
  if (!block) return null;
  if (block.status === 'error') {
    return (
      <CollapsibleResultSection
        title="Google Drive (ST)"
        subtitle="Evidencias"
        badge={0}
        error={block.error}
        defaultOpen
        dense={dense}
      >
        <span className="text-xs text-momo-500">Error en Drive</span>
      </CollapsibleResultSection>
    );
  }
  const d = block.data || {};
  const folders = d.folders || [];
  const hasHits = folders.some((f) => f.found);
  const stCount = (meta?.stOrdersFromChatwoot || []).length;

  if (!hasHits && d.skipped && !stCount) return null;

  if (!hasHits && d.skipped && stCount) {
    return (
      <CollapsibleResultSection
        title="Google Drive (ST)"
        subtitle="Órdenes detectadas en chat"
        badge={stCount}
        defaultOpen={false}
        dense={dense}
      >
        <p className="text-[11px] text-momo-600 px-1 leading-snug">
          Órdenes: {(meta.stOrdersFromChatwoot || []).join(', ')}. {d.reason || 'Drive no disponible o sin coincidencias.'}
          {meta?.plan?.type === 'name' && query ? (
            <span className="block mt-1 text-momo-500">
              Informes “a nombre de” cliente: úsalos cuando el archivo o el mensaje incluya el nombre; la indexación
              aquí sigue el código ST (P/E/S).
            </span>
          ) : null}
        </p>
      </CollapsibleResultSection>
    );
  }

  if (!folders.length) return null;

  return (
    <CollapsibleResultSection
      title="Google Drive (ST)"
      subtitle="Carpetas y archivos por código de orden"
      badge={folders.length}
      defaultOpen
      dense={dense}
    >
      {meta?.plan?.type === 'name' && query && (
        <p className="text-[10px] text-momo-500 px-1 mb-2 leading-snug">
          Contexto búsqueda: <span className="font-medium text-momo-700">{query}</span> — revisa nombres en nombres de
          archivo al abrir evidencias.
        </p>
      )}
      {folders.map((f) => (
        <div key={f.order} className="mb-2 rounded-md border border-momo-100 bg-momo-50/40 p-2 text-xs">
          <div className="font-semibold text-momo-900">
            Orden {f.order} {f.found ? '· carpeta' : '· sin carpeta'}
          </div>
          {f.error && <p className="text-[11px] text-red-700 mt-1">{f.error}</p>}
          {f.files?.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {f.files.map((file) => (
                <DriveFileRow key={file.id} file={file} />
              ))}
            </ul>
          )}
        </div>
      ))}
    </CollapsibleResultSection>
  );
}
