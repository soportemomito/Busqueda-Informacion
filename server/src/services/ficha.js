import axios from 'axios';

/**
 * Ficha consolidada del cliente.
 *
 * Construye el markdown de la ficha (formato VISION.md §3b paso 5), la persiste
 * en Supabase (client_profiles) y la sincroniza como NOTA DE CONTACTO en
 * Chatwoot, de modo que el equipo vea la ficha sin depender del panel web.
 *
 * La nota se deduplica por el marcador FICHA_MARKER: si ya existe una nota de
 * ficha para el contacto se actualiza (PUT); si no, se crea (POST). Si el
 * contenido no cambió, no se llama a la API.
 */

export const FICHA_MARKER = '📋 **Ficha ST**';

// Detecta notas de ficha existentes: formato actual (📋 **Ficha ST**)
// y formato legacy (### 📋 Ficha ST Consolidada)
const FICHA_NOTE_RE = /📋\s*(?:\*\*)?\s*Ficha ST/;

// ─── Clasificación de dispositivo (espejo de getDeviceCategory del frontend) ──

export function getDeviceCategory(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  if (m.includes('baby monitor') || m.includes('monitor')) return 'Monitor / Baby Monitor';
  if (m.includes('tablet')) return 'Tablet';
  if (m.includes('momophone pro')) return 'Celular';
  if (m.includes('space') || m.includes('momophone') || m.includes('lite')) return 'Reloj / Smartwatch';
  return null;
}

// ─── Render markdown ──────────────────────────────────────────────────────────

function fmtDate(v) {
  if (!v) return null;
  const d = new Date(typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : v);
  if (!Number.isFinite(d.getTime())) return null;
  // UTC: las fechas de planilla vienen como medianoche UTC; renderizar en local
  // las corre un día hacia atrás en Chile.
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function line(parts) {
  return parts.filter(Boolean).join(' ');
}

/**
 * @param {object} f
 * @param {string|null} f.name
 * @param {string|null} f.email
 * @param {string|null} f.phone
 * @param {string[]} [f.imeis]   IMEIs de 15 dígitos
 * @param {string[]} [f.deviceIds] IDs de 10 dígitos
 * @param {string[]} [f.sims]
 * @param {{number:string|number,url?:string|null,total?:number|null,date?:any}[]} [f.boletas]
 * @param {{name:string,url?:string|null,financialStatus?:string|null,fulfillmentStatus?:string|null,date?:any}[]} [f.pedidos]
 * @param {{order_number:string,date?:any,report_url?:string|null}[]} [f.ingresosSt]
 * @param {{order_number:string,date?:any,report_url?:string|null,solution?:string|null}[]} [f.salidasSt]
 * @param {{ticketId:number|string,status?:string|null,url?:string|null}[]} [f.tickets]
 * @returns {string} markdown
 */
export function buildFichaMarkdown(f) {
  const L = [];
  L.push(FICHA_MARKER);
  L.push(`👤 **Nombre:** ${f.name || '—'}`);
  L.push(`✉️ **Correo:** ${f.email || '—'}`);
  L.push(`📱 **Teléfono:** ${f.phone || '—'}`);

  const ids = [...(f.imeis || []), ...(f.deviceIds || [])];
  L.push(`📡 **IMEI/ID:** ${ids.length ? ids.join(', ') : '—'}`);
  L.push(`💳 **SIM:** ${f.sims?.length ? f.sims.join(', ') : '—'}`);

  if (f.boletas?.length) {
    const rendered = f.boletas.map((b) =>
      line([
        `Folio ${b.number}`,
        b.total != null ? `($${Number(b.total).toLocaleString('es-CL')})` : null,
        fmtDate(b.date) ? `· ${fmtDate(b.date)}` : null,
        b.url ? `[PDF](${b.url})` : null,
      ]),
    );
    L.push(`🧾 **Boletas:** ${rendered.join(' | ')}`);
  } else {
    L.push('🧾 **Boletas:** —');
  }

  if (f.pedidos?.length) {
    const payMap = { paid: 'Pagado', pending: 'Pago pendiente', refunded: 'Reembolsado', partially_paid: 'Pago parcial', voided: 'Anulado' };
    const fulfillMap = { fulfilled: 'Enviado', partial: 'Envío parcial', unfulfilled: 'Sin enviar', restocked: 'Devuelto' };
    const rendered = f.pedidos.map((o) => {
      const states = [payMap[o.financialStatus], fulfillMap[o.fulfillmentStatus]].filter(Boolean).join('/');
      const label = o.url ? `[${o.name}](${o.url})` : o.name;
      return line([label, states ? `(${states})` : null]);
    });
    L.push(`📦 **Pedidos:** ${rendered.join(' | ')}`);
  } else {
    L.push('📦 **Pedidos:** —');
  }

  if (f.ingresosSt?.length) {
    const rendered = f.ingresosSt.map((o) =>
      line([
        `${o.order_number}`,
        fmtDate(o.date) ? `(${fmtDate(o.date)})` : null,
        o.report_url ? `[Informe](${o.report_url})` : null,
      ]),
    );
    L.push(`🔧 **Ingresos a ST:** ${rendered.join(' | ')}`);
  } else {
    L.push('🔧 **Ingresos a ST:** —');
  }

  if (f.salidasSt?.length) {
    const shortSolution = (s) => {
      const clean = String(s || '').replace(/\s+/g, ' ').trim();
      if (!clean) return null;
      return clean.length > 140 ? `— ${clean.slice(0, 140)}…` : `— ${clean}`;
    };
    const rendered = f.salidasSt.map((o) =>
      line([
        `${o.order_number}`,
        fmtDate(o.date) ? `(${fmtDate(o.date)})` : null,
        shortSolution(o.solution),
        o.report_url ? `[Informe](${o.report_url})` : null,
      ]),
    );
    L.push(`✅ **Salidas ST:** ${rendered.join(' | ')}`);
  } else {
    L.push('✅ **Salidas ST:** —');
  }

  if (f.tickets?.length) {
    L.push('');
    L.push('🎫 **Tickets:**');
    for (const t of f.tickets.slice(0, 12)) {
      // pending cuenta como abierto, igual que isOpen en services/chatwoot.js
      const s = String(t.status || '').toLowerCase();
      const status = t.status ? (s === 'open' || s === 'pending' ? 'OPEN' : 'CLOSED') : null;
      const label = t.url ? `[#${t.ticketId}](${t.url})` : `#${t.ticketId}`;
      L.push(line([`- Ticket ${label}`, status ? `**(${status})**` : null]));
    }
  }

  return L.join('\n');
}

// ─── Nota de contacto en Chatwoot (upsert deduplicado) ───────────────────────

function chatwootClient(creds) {
  const base = String(creds.chatwootBaseUrl || '').replace(/\/+$/, '');
  const token = creds.chatwootApiToken;
  if (!base || !token) return null;
  return axios.create({
    baseURL: base,
    headers: { api_access_token: token, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
}

/** Quita la línea de timestamp legacy para comparar contenido real. */
function stripSyncLine(content) {
  return String(content || '')
    .split('\n')
    .filter((l) => !l.startsWith('_Sync automático'))
    .join('\n')
    .trim();
}

/**
 * Crea o actualiza la nota de ficha en el CONTACTO de Chatwoot.
 * Devuelve 'created' | 'updated' | 'unchanged' | 'skipped'.
 */
export async function upsertContactFichaNote(creds, accountId, contactId, markdown) {
  const http = chatwootClient(creds);
  if (!http || !contactId) return 'skipped';

  const notesPath = `/api/v1/accounts/${accountId}/contacts/${contactId}/notes`;
  const content = markdown;

  const { data } = await http.get(notesPath);
  const notes = Array.isArray(data) ? data : data?.payload || [];
  const existing = notes.find((n) => FICHA_NOTE_RE.test(String(n.content || '')));

  if (existing) {
    if (stripSyncLine(existing.content) === stripSyncLine(content)) return 'unchanged';
    await http.put(`${notesPath}/${existing.id}`, { content });
    return 'updated';
  }

  await http.post(notesPath, { content });
  return 'created';
}

// ─── Persistencia en Supabase ─────────────────────────────────────────────────

export async function persistFichaProfile(supabase, contactId, f, markdown) {
  if (!supabase || !contactId) return;

  const devices = [];
  const imeisArr = [...(f.imeis || []), ...(f.deviceIds || [])];
  const simsArr = f.sims || [];
  const maxLen = Math.max(imeisArr.length, simsArr.length);
  for (let i = 0; i < maxLen; i++) {
    devices.push({ imei: imeisArr[i] || null, sim: simsArr[i] || null });
  }

  const row = {
    chatwoot_contact_id: contactId,
    updated_at: new Date().toISOString(),
    ficha_markdown: markdown,
    ficha_synced_at: new Date().toISOString(),
  };
  if (f.name) row.name = f.name;
  if (f.email) row.email = f.email;
  if (f.phone) row.phone = f.phone;
  if (devices.length) row.devices = devices;
  if (f.pedidos?.length) row.shopify_orders = f.pedidos.map((o) => o.name).filter(Boolean);
  if (f.boletas?.length) {
    row.bsale_folios = f.boletas.map((b) => ({
      number: b.number, url: b.url || null, total: b.total ?? null,
    }));
  }
  const stAll = [...(f.ingresosSt || []), ...(f.salidasSt || [])];
  if (stAll.length) row.service_orders = [...new Set(stAll.map((o) => o.order_number).filter(Boolean))];
  if (f.tickets?.length) {
    row.tickets = f.tickets.map((t) => ({
      ticket_id: t.ticketId, status: t.status || null, url: t.url || null,
    }));
  }

  const { error } = await supabase
    .from('client_profiles')
    .upsert(row, { onConflict: 'chatwoot_contact_id' });
  if (error) throw new Error(`client_profiles upsert: ${error.message}`);
}

// ─── Orquestación ─────────────────────────────────────────────────────────────

/**
 * Persiste la ficha en Supabase y la sincroniza como nota de contacto.
 * Diseñada para fire-and-forget: nunca lanza, solo loggea.
 */
export async function syncFicha({ supabase, creds, accountId, contactId, ficha }) {
  if (!contactId) return;
  const markdown = buildFichaMarkdown(ficha);

  const results = await Promise.allSettled([
    persistFichaProfile(supabase, contactId, ficha, markdown),
    upsertContactFichaNote(creds, accountId, contactId, markdown),
  ]);

  const [profileR, noteR] = results;
  if (profileR.status === 'rejected') {
    console.error('[ficha] Error persistiendo perfil:', profileR.reason?.message);
  }
  if (noteR.status === 'rejected') {
    console.error('[ficha] Error sincronizando nota de contacto:', noteR.reason?.message);
  } else {
    console.log(`[ficha] Nota de contacto #${contactId}: ${noteR.value}`);
  }
}
