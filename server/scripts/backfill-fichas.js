/**
 * Backfill de fichas para conversaciones existentes en Chatwoot.
 *
 * El webhook solo genera la ficha cuando llega un mensaje nuevo. Las conversaciones
 * viejas (sin actividad desde el deploy) no tienen ficha. Este script las genera
 * "por adelantado" para los contactos de las conversaciones activas, de modo que
 * al abrirlas la nota ya esté.
 *
 * Reutiliza la misma lógica de cruce que el webhook (services/*), sin tocarlo.
 * Es idempotente: syncFicha deduplica la nota (created/updated/unchanged).
 *
 * Uso:
 *   node scripts/backfill-fichas.js                 → estados open + pending (default)
 *   node scripts/backfill-fichas.js open            → solo abiertas
 *   node scripts/backfill-fichas.js all 200         → todas, máx 200 conversaciones
 */

import 'dotenv/config';
import axios from 'axios';
import { getSupabase } from '../src/lib/supabase.js';
import { resolveCredentials } from '../src/lib/resolveCredentials.js';
import { extractDeviceFactsFromText } from '../src/lib/extractDeviceFacts.js';
import { buildSearchPlan } from '../src/lib/searchPlan.js';
import { searchShopify } from '../src/services/shopify.js';
import { searchBsale } from '../src/services/bsale.js';
import { syncFicha } from '../src/services/ficha.js';

const STATES = (process.argv[2] || 'open,pending').split(',').map((s) => s.trim());
const MAX = Number(process.argv[3] || 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /^(null|undefined|n\/a|-)$/i.test(s)) return null;
  return s;
}

async function listConversations(http, accountId, status) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const { data } = await http.get(`/api/v1/accounts/${accountId}/conversations`, {
      params: { status, page },
    });
    const payload = data?.data?.payload || data?.payload || [];
    if (!payload.length) break;
    out.push(...payload);
    if (out.length >= MAX) break;
  }
  return out;
}

async function getMessages(http, accountId, convId) {
  try {
    const { data } = await http.get(`/api/v1/accounts/${accountId}/conversations/${convId}/messages`);
    const raw = data?.payload;
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.payload) ? raw.payload : [];
    return list;
  } catch {
    return [];
  }
}

async function getContactConversations(http, accountId, contactId) {
  try {
    const { data } = await http.get(`/api/v1/accounts/${accountId}/contacts/${contactId}/conversations`);
    return data?.payload || [];
  } catch {
    return [];
  }
}

function ticketUrl(base, accountId, convId) {
  return `${base.replace(/\/+$/, '')}/app/accounts/${accountId}/conversations/${convId}`;
}

async function buildFichaForContact(ctx, contact, conversations) {
  const { http, accountId, supabase, creds, base } = ctx;
  const name = cleanStr(contact.name);
  const email = cleanStr(contact.email);
  const phone = cleanStr(contact.phone_number);

  // 1. Identificadores desde mensajes (de todas las conversaciones del contacto)
  const imeiSet = new Set();
  const simSet = new Set();
  for (const c of conversations.slice(0, 8)) {
    const msgs = await getMessages(http, accountId, c.id);
    for (const m of msgs) {
      const isOutgoing = m.message_type === 1 || m.message_type === 'outgoing';
      if (isOutgoing && !m.private) continue;
      const facts = extractDeviceFactsFromText(m.content || '');
      for (const f of facts) {
        if (f.label === 'ID / IMEI') imeiSet.add(f.value);
        if (f.label === 'ICCID / SIM') simSet.add(f.value);
      }
    }
  }
  const imeis = [...imeiSet].filter((v) => v.length === 15);
  const deviceIds = [...imeiSet].filter((v) => v.length === 10);
  const sims = [...simSet];

  // 2. Órdenes ST por email exacto + fallback por nombre
  const stConditions = [];
  if (email) stConditions.push(`contact_email.eq.${email.toLowerCase()}`);
  if (name) {
    const tokens = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/).filter((t) => t.length >= 3).slice(0, 3);
    if (tokens.length >= 2) {
      stConditions.push(`and(${tokens.map((t) => `contact_name.ilike.*${t}*`).join(',')})`);
      stConditions.push(`contact_email.ilike.${tokens.join('*')}*`);
    }
  }
  const ingresosSt = [];
  const salidasSt = [];
  if (stConditions.length) {
    const { data: stRows } = await supabase.from('service_orders')
      .select('order_number, status, entry_date, exit_date, received_at, report_url, entry_report_url, solution')
      .or(stConditions.join(',')).limit(20);
    for (const o of stRows || []) {
      const isExit = o.status === 'completed' || !!o.exit_date;
      if (isExit) salidasSt.push({ order_number: o.order_number, date: o.exit_date, report_url: o.report_url, solution: o.solution });
      if (o.entry_date || !isExit) ingresosSt.push({ order_number: o.order_number, date: o.entry_date || o.received_at, report_url: o.entry_report_url });
    }
  }

  // 3. Shopify + Bsale en vivo por email
  let boletas = [];
  let pedidos = [];
  if (email) {
    const plan = buildSearchPlan(email);
    const [shR, bsR] = await Promise.allSettled([searchShopify(plan, creds), searchBsale(plan, creds)]);
    if (shR.status === 'fulfilled' && !shR.value.skipped && shR.value.orders?.length) {
      pedidos = shR.value.orders.map((o) => ({
        name: o.name, url: o.adminUrl || o.adminOrdersSearchUrl || null,
        financialStatus: o.financialStatus, fulfillmentStatus: o.fulfillmentStatus,
      }));
    }
    if (bsR.status === 'fulfilled' && bsR.value.items?.length) {
      boletas = bsR.value.items.map((b) => ({ number: b.number, url: b.urlPublicView || null, total: b.total ?? null, date: b.emissionDate }));
    }
    const known = new Set(boletas.map((b) => String(b.number)));
    if (shR.status === 'fulfilled' && !shR.value.skipped) {
      for (const o of shR.value.orders || []) {
        if (o.bsaleFolio && !known.has(String(o.bsaleFolio))) {
          known.add(String(o.bsaleFolio));
          boletas.push({ number: o.bsaleFolio, url: o.bsaleFolioPdf || null, total: null, date: o.createdAt });
        }
      }
    }
  }

  // 4. Tickets del contacto
  const tickets = conversations.map((c) => ({
    ticketId: c.id,
    status: c.status,
    url: ticketUrl(base, accountId, c.id),
  }));

  return { name, email, phone, imeis, deviceIds, sims, boletas, pedidos, ingresosSt, salidasSt, tickets };
}

async function main() {
  const supabase = getSupabase();
  const creds = await resolveCredentials(supabase);
  const base = String(creds.chatwootBaseUrl || '').replace(/\/+$/, '');
  const accountId = String(creds.chatwootAccountId || '1');
  const http = axios.create({ baseURL: base, headers: { api_access_token: creds.chatwootApiToken }, timeout: 25000 });

  console.log(`[backfill] Estados: ${STATES.join(', ')} | máx ${MAX} conversaciones`);

  // Reunir conversaciones de los estados pedidos y agrupar por contacto
  const convs = [];
  for (const st of STATES) {
    const list = await listConversations(http, accountId, st);
    console.log(`[backfill] ${st}: ${list.length} conversaciones`);
    convs.push(...list);
  }

  const byContact = new Map();
  for (const c of convs) {
    const cid = c.meta?.sender?.id;
    if (!cid) continue;
    if (!byContact.has(cid)) byContact.set(cid, c.meta.sender);
  }
  console.log(`[backfill] Contactos únicos a procesar: ${byContact.size}\n`);

  const ctx = { http, accountId, supabase, creds, base };
  let created = 0, updated = 0, unchanged = 0, errors = 0, i = 0;

  for (const [contactId, senderStub] of byContact) {
    i++;
    try {
      // Contacto completo + todas sus conversaciones (para los tickets)
      const { data: full } = await http.get(`/api/v1/accounts/${accountId}/contacts/${contactId}`);
      const contact = full?.payload || full || senderStub;
      const conversations = await getContactConversations(http, accountId, contactId);
      const convList = conversations.length ? conversations : [{ id: senderStub.conversation_id, status: 'open' }].filter((c) => c.id);

      const ficha = await buildFichaForContact(ctx, contact, convList);

      // Capturar el resultado de la nota
      let result = '?';
      const origLog = console.log;
      console.log = (...a) => { const s = a.join(' '); const m = s.match(/Nota de contacto #\d+: (\w+)/); if (m) result = m[1]; origLog(...a); };
      await syncFicha({ supabase, creds, accountId, contactId, ficha });
      console.log = origLog;

      if (result === 'created') created++;
      else if (result === 'updated') updated++;
      else if (result === 'unchanged') unchanged++;
      console.log(`[backfill] (${i}/${byContact.size}) contacto #${contactId} ${contact.name || ''} → ${result}`);
    } catch (e) {
      errors++;
      console.error(`[backfill] (${i}/${byContact.size}) contacto #${contactId} ERROR: ${e.message}`);
    }
    await sleep(400); // rate limit suave
  }

  console.log(`\n[backfill] LISTO. created=${created} updated=${updated} unchanged=${unchanged} errors=${errors}`);
}

main().catch((e) => { console.error('[backfill] fatal:', e); process.exit(1); });
