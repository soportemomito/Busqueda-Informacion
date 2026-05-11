import { Router } from 'express';
import { getSupabase, upsertDeviceFacts, lookupRelatedByDevice } from '../lib/supabase.js';
import { resolveCredentials } from '../lib/resolveCredentials.js';
import { buildSearchPlan } from '../lib/searchPlan.js';
import { searchChatwoot } from '../services/chatwoot.js';
import { searchBsale } from '../services/bsale.js';
import { searchShopify } from '../services/shopify.js';
import { searchDriveForStOrders } from '../services/drive.js';
import { shopifyStoreOriginFromApiBase } from '../services/shopify.js';
import { flattenDeviceFactsForMeta } from '../lib/extractDeviceFacts.js';

export const searchRouter = Router();

const ST_MS = 90 * 24 * 60 * 60 * 1000;

function wrapOk(data) {
  return { status: 'ok', data };
}

function wrapErr(message) {
  return { status: 'error', data: null, error: message };
}

function parseWhenMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

function computeRecentSt({ servicioTecnicoItems, driveResult }) {
  const times = [];
  for (const item of servicioTecnicoItems || []) {
    const ms = parseWhenMs(item.date);
    if (ms != null) times.push(ms);
  }
  if (driveResult?.folders) {
    for (const f of driveResult.folders) {
      if (f.found && f.modifiedTime) {
        const t = Date.parse(f.modifiedTime);
        if (Number.isFinite(t)) times.push(t);
      }
    }
  }
  if (!times.length) return { showBanner: false, lastDate: null };
  const latest = Math.max(...times);
  const age = Date.now() - latest;
  return {
    showBanner: age >= 0 && age < ST_MS,
    lastDate: new Date(latest).toISOString(),
  };
}

function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

function collectEquipmentFactsFromCwData(cwData) {
  if (!cwData) return [];
  const m = new Map();
  for (const row of [...(cwData.servicioTecnico || []), ...(cwData.chatwoot || [])]) {
    if (row?.conversationId == null || !row.deviceFacts?.length) continue;
    m.set(row.conversationId, row.deviceFacts);
  }
  return flattenDeviceFactsForMeta(m);
}

/**
 * Recoge emails, teléfonos, RUTs y números de pedido Shopify de todos los
 * resultados disponibles. Se usa para enriquecer plataformas vacías.
 */
function buildEnrichmentPivot(chatwootBlock, bsaleBlock, shopifyBlock) {
  const emails = [];
  const orderNumbers = [];
  const phones = [];
  const ruts = [];

  if (chatwootBlock.status === 'ok' && chatwootBlock.data) {
    emails.push(...(chatwootBlock.data.emailsFromContacts || []));
    emails.push(...(chatwootBlock.data.emailsFromMessages || []));
    orderNumbers.push(...(chatwootBlock.data.shopifyOrdersFromMessages || []));
    phones.push(...(chatwootBlock.data.phonesFromContacts || []));
    ruts.push(...(chatwootBlock.data.rutsFromMessages || []));
  }
  if (bsaleBlock.status === 'ok' && bsaleBlock.data) {
    for (const c of bsaleBlock.data.clients || []) {
      if (c.email) emails.push(c.email.toLowerCase());
    }
  }
  if (shopifyBlock.status === 'ok' && shopifyBlock.data && !shopifyBlock.data.skipped) {
    for (const c of shopifyBlock.data.customers || []) {
      if (c.email) emails.push(c.email.toLowerCase());
      if (c.phone) phones.push(c.phone);
    }
    for (const o of shopifyBlock.data.orders || []) {
      if (o.name) orderNumbers.push(o.name);
    }
  }

  const uniqueEmails = [...new Set(emails.filter(Boolean))];
  const uniqueOrders = [...new Set(orderNumbers.filter(Boolean))];
  const uniquePhones = [...new Set(phones.filter(Boolean))];
  const uniqueRuts = [...new Set(ruts.filter(Boolean))];
  return {
    email: uniqueEmails[0] || null,
    emails: uniqueEmails,
    phone: uniquePhones[0] || null,
    phones: uniquePhones,
    rut: uniqueRuts[0] || null,
    ruts: uniqueRuts,
    orderNumber: uniqueOrders[0] || null,
    orderNumbers: uniqueOrders,
  };
}

/**
 * Agrupa los resultados de relatedByDevice por conversationId y
 * cuenta cuántos identificadores coinciden.
 * Sólo incluye conversaciones con ≥1 match; marca `confident: true` si ≥2.
 */
function groupSimilarTickets(relatedByDevice) {
  const byConv = new Map();
  for (const row of relatedByDevice || []) {
    if (!byConv.has(row.conversationId)) {
      byConv.set(row.conversationId, { conversationId: row.conversationId, matches: [] });
    }
    byConv.get(row.conversationId).matches.push({ label: row.label, value: row.value });
  }
  return [...byConv.values()]
    .map((g) => ({ ...g, confident: g.matches.length >= 2 }))
    .sort((a, b) => b.matches.length - a.matches.length);
}

function buildUnifiedProfile(chatwootBlock, bsaleBlock, shopifyBlock) {
  const cwEmails = new Set();
  const bsEmails = new Set();
  const shEmails = new Set();
  let cwContactsLen = 0;
  let bsClientLen = 0;
  let shCustomerLen = 0;

  if (chatwootBlock.status === 'ok' && chatwootBlock.data) {
    const cw = chatwootBlock.data;
    cwContactsLen = (cw.contacts || []).length;
    for (const e of cw.emailsFromContacts || []) {
      const n = normalizeEmail(e);
      if (n) cwEmails.add(n);
    }
  }

  if (bsaleBlock.status === 'ok' && bsaleBlock.data) {
    const bs = bsaleBlock.data;
    bsClientLen = (bs.clientIds || []).length;
    for (const c of bs.clients || []) {
      const n = normalizeEmail(c.email);
      if (n) bsEmails.add(n);
    }
  }

  if (shopifyBlock.status === 'ok' && shopifyBlock.data && !shopifyBlock.data.skipped) {
    const sh = shopifyBlock.data;
    shCustomerLen = (sh.customers || []).length;
    for (const c of sh.customers || []) {
      const n = normalizeEmail(c.email);
      if (n) shEmails.add(n);
    }
  }

  const overlap = [...cwEmails].some((e) => bsEmails.has(e));
  const emails = [...new Set([...cwEmails, ...bsEmails, ...shEmails])];
  const merged =
    overlap && cwContactsLen > 0 && bsClientLen > 0 && chatwootBlock.status === 'ok' && bsaleBlock.status === 'ok';

  const chatwootContactIds =
    chatwootBlock.status === 'ok' && chatwootBlock.data
      ? (chatwootBlock.data.contacts || []).map((c) => c.id)
      : [];
  const bsaleClientIds =
    bsaleBlock.status === 'ok' && bsaleBlock.data ? bsaleBlock.data.clientIds || [] : [];
  const shopifyCustomerIds =
    shopifyBlock.status === 'ok' && shopifyBlock.data && !shopifyBlock.data.skipped
      ? (shopifyBlock.data.customers || []).map((c) => c.id).filter((id) => id != null)
      : [];

  return {
    merged,
    emails,
    chatwootContactIds,
    bsaleClientIds,
    shopifyCustomerIds,
    shopifyEmailOverlap:
      shCustomerLen > 0 && [...shEmails].some((e) => cwEmails.has(e) || bsEmails.has(e)),
  };
}

function collectContactIdentifiers(cwData, shopifyBlock, plan) {
  const rows = [];
  if (!cwData) return rows;

  const allConvIds = (cwData.allConversations || []).map((c) => c.conversationId).filter(Boolean);
  if (!allConvIds.length) return rows;

  const primaryConvId =
    plan.type === 'conversationId' && plan.conversationId != null
      ? plan.conversationId
      : allConvIds[0];

  // Emails: contactos siempre (fiables).
  // Emails de mensajes solo para canales no-email (WhatsApp, etc.) — en hilos de
  // correo los mensajes contienen emails de CC/BCC que no son del cliente.
  const INTERNAL_DOMAINS = new Set(['soymomo.com', 'soymomo.io', 'helpdesk.soymomo.io']);
  const isInternal = (email) => INTERNAL_DOMAINS.has(email.split('@')[1] || '');

  const isEmailChannel = (cwData.allConversations || []).some((c) =>
    String(c.channel || '').toLowerCase().includes('email'),
  );

  const contactEmails = new Set(
    (cwData.emailsFromContacts || []).map((e) => e.trim().toLowerCase()).filter(Boolean),
  );
  const msgEmails = isEmailChannel
    ? []
    : (cwData.emailsFromMessages || [])
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e && !isInternal(e) && !contactEmails.has(e));

  for (const v of [...contactEmails, ...new Set(msgEmails)]) {
    if (v) rows.push({ label: 'Email', value: v, conversationId: primaryConvId });
  }

  // Teléfonos de los contactos Chatwoot
  for (const contact of cwData.contacts || []) {
    const phone = (contact.phone_number || contact.phone || '').trim();
    if (phone) rows.push({ label: 'Teléfono', value: phone, conversationId: primaryConvId });
  }

  // Pedidos Shopify hallados en mensajes
  for (const order of cwData.shopifyOrdersFromMessages || []) {
    if (order) rows.push({ label: 'Pedido Shopify', value: order, conversationId: primaryConvId });
  }

  // Pedidos Shopify de resultados reales
  const shData = shopifyBlock?.status === 'ok' && !shopifyBlock.data?.skipped ? shopifyBlock.data : null;
  for (const order of shData?.orders || []) {
    if (order.name) rows.push({ label: 'Pedido Shopify', value: order.name, conversationId: primaryConvId });
  }

  return rows;
}

searchRouter.get('/', async (req, res) => {
  const rawQ = String(req.query.q || '').trim();
  const plan = buildSearchPlan(rawQ);
  const supabase = getSupabase();
  let creds;
  try {
    creds = await resolveCredentials(supabase);
  } catch (e) {
    return res.status(500).json({ query: rawQ, error: e.message });
  }

  let settled;

  if (plan.type === 'orderNumber') {
    // Fase 1: Shopify por nombre de pedido + Chatwoot por términos del pedido (paralelo)
    const [cwOrderR, shR] = await Promise.allSettled([
      searchChatwoot(plan, creds),
      searchShopify(plan, creds),
    ]);

    // Extraer emails del cliente encontrado en Shopify
    const shData = shR.status === 'fulfilled' ? shR.value : null;
    const customerEmails = (shData?.customers || []).map((c) => c.email).filter(Boolean);

    // Fase 2: Bsale por email del cliente + Chatwoot por email si la búsqueda por orden no encontró nada
    const cwHasResults =
      cwOrderR.status === 'fulfilled' &&
      ((cwOrderR.value.contacts?.length ?? 0) > 0 || (cwOrderR.value.conversationCount ?? 0) > 0);

    let bsR, cwEmailR;
    if (customerEmails.length) {
      const emailPlan = buildSearchPlan(customerEmails[0]);
      [bsR, cwEmailR] = await Promise.allSettled([
        searchBsale(emailPlan, creds),
        !cwHasResults ? searchChatwoot(emailPlan, creds) : Promise.resolve(null),
      ]);
    } else {
      const noEmailNote = shData?.orders?.length
        ? 'Pedido encontrado en Shopify pero el cliente no tiene email; no se puede cruzar con Bsale.'
        : null;
      bsR = { status: 'fulfilled', value: { items: [], clientIds: [], clients: [], note: noEmailNote } };
      cwEmailR = { status: 'fulfilled', value: null };
    }

    // Chatwoot: usar resultado por email si el de orden llegó vacío
    const finalCwR =
      !cwHasResults && cwEmailR?.status === 'fulfilled' && cwEmailR.value != null
        ? cwEmailR
        : cwOrderR;

    settled = [finalCwR, bsR, shR];
  } else {
    settled = await Promise.allSettled([
      searchChatwoot(plan, creds),
      searchBsale(plan, creds),
      searchShopify(plan, creds),
    ]);
  }

  let chatwootBlock = wrapOk(null);
  let bsaleBlock = wrapOk({ items: [], clientIds: [], clients: [], note: null });
  let shopifyBlock = wrapOk({ customers: [], orders: [], note: null, skipped: true });
  let sourceStats = { chatwoot: null, bsale: null, shopify: null };

  if (settled[0].status === 'fulfilled') {
    const r = settled[0].value;
    chatwootBlock = wrapOk(r);
    sourceStats.chatwoot = {
      contacts: r.contactCount ?? 0,
      conversations: r.conversationCount ?? 0,
      openConversations: r.openConversationsCount ?? 0,
      stOrdersDetected: (r.stOrdersFromMessages || []).length,
    };
  } else {
    chatwootBlock = wrapErr(settled[0].reason?.message || 'Error Chatwoot');
  }

  if (settled[1].status === 'fulfilled') {
    const r = settled[1].value;
    bsaleBlock = wrapOk(r);
    sourceStats.bsale = {
      clients: (r.clientIds || []).length,
      documents: (r.items || []).length,
    };
  } else {
    bsaleBlock = wrapErr(settled[1].reason?.message || 'Error Bsale');
  }

  if (settled[2].status === 'fulfilled') {
    const r = settled[2].value;
    shopifyBlock = wrapOk(r);
    if (!r.skipped) {
      sourceStats.shopify = {
        customers: (r.customers || []).length,
        orders: (r.orders || []).length,
      };
    }
  } else {
    shopifyBlock = wrapErr(settled[2].reason?.message || 'Error Shopify');
  }

  // === ENRIQUECIMIENTO CRUZADO ===
  // Después del primer wave, si alguna plataforma quedó vacía,
  // buscamos con emails/pedidos extraídos de las otras.
  {
    const pivot = buildEnrichmentPivot(chatwootBlock, bsaleBlock, shopifyBlock);

    const cwEmpty = chatwootBlock.status === 'ok' && (chatwootBlock.data?.contactCount ?? 0) === 0;
    const bsEmpty = bsaleBlock.status === 'ok' && (bsaleBlock.data?.items?.length ?? 0) === 0;
    const shEmpty =
      shopifyBlock.status === 'ok' &&
      (shopifyBlock.data?.skipped === true ||
        ((shopifyBlock.data?.orders?.length ?? 0) === 0 &&
          (shopifyBlock.data?.customers?.length ?? 0) === 0));

    if ((pivot.email || pivot.phone || pivot.rut || pivot.orderNumber) && (cwEmpty || bsEmpty || shEmpty)) {
      const tasks = [];
      if (pivot.email) {
        const ep = buildSearchPlan(pivot.email);
        if (bsEmpty) tasks.push({ key: 'bsale', p: searchBsale(ep, creds) });
        if (shEmpty) tasks.push({ key: 'shopify', p: searchShopify(ep, creds) });
        if (cwEmpty) tasks.push({ key: 'chatwoot', p: searchChatwoot(ep, creds) });
      }
      // Enriquecer Bsale con teléfono si sigue vacío
      if (pivot.phone && bsEmpty && !tasks.find((t) => t.key === 'bsale')) {
        tasks.push({ key: 'bsale', p: searchBsale(buildSearchPlan(pivot.phone), creds) });
      }
      // Enriquecer Bsale con RUT si sigue vacío
      if (pivot.rut && bsEmpty && !tasks.find((t) => t.key === 'bsale')) {
        tasks.push({ key: 'bsale', p: searchBsale(buildSearchPlan(pivot.rut), creds) });
      }
      // Si no hay email pero hay número de pedido Shopify, intentar Shopify por ese pedido
      if (pivot.orderNumber && shEmpty && !tasks.find((t) => t.key === 'shopify')) {
        tasks.push({ key: 'shopify', p: searchShopify(buildSearchPlan(pivot.orderNumber), creds) });
      }

      if (tasks.length) {
        const enriched = await Promise.allSettled(tasks.map((t) => t.p));
        for (let i = 0; i < tasks.length; i++) {
          const { key } = tasks[i];
          if (enriched[i].status !== 'fulfilled') continue;
          const v = enriched[i].value;
          if (key === 'bsale' && (v.items?.length ?? 0) > 0) {
            bsaleBlock = wrapOk(v);
            sourceStats.bsale = { clients: (v.clientIds || []).length, documents: v.items.length };
          }
          if (
            key === 'shopify' &&
            !v.skipped &&
            ((v.orders?.length ?? 0) > 0 || (v.customers?.length ?? 0) > 0)
          ) {
            shopifyBlock = wrapOk(v);
            sourceStats.shopify = {
              customers: (v.customers || []).length,
              orders: (v.orders || []).length,
            };
          }
          if (key === 'chatwoot' && (v.contactCount ?? 0) > 0) {
            chatwootBlock = wrapOk(v);
            sourceStats.chatwoot = {
              contacts: v.contactCount ?? 0,
              conversations: v.conversationCount ?? 0,
              openConversations: v.openConversationsCount ?? 0,
              stOrdersDetected: (v.stOrdersFromMessages || []).length,
            };
          }
        }
      }
    }
  }
  // === FIN ENRIQUECIMIENTO ===

  const stOrders = chatwootBlock.status === 'ok'
    ? chatwootBlock.data?.stOrdersFromMessages || []
    : [];

  let driveBlock = wrapOk({ folders: [], skipped: true, reason: 'Sin órdenes ST en mensajes' });
  if (stOrders.length && creds.driveParentFolderId && creds.driveServiceAccountJson) {
    const dSettled = await Promise.allSettled([searchDriveForStOrders(stOrders, creds)]);
    if (dSettled[0].status === 'fulfilled') {
      const dr = dSettled[0].value;
      driveBlock = wrapOk(dr);
    } else {
      driveBlock = wrapErr(dSettled[0].reason?.message || 'Error Google Drive');
    }
  } else if (stOrders.length) {
    driveBlock = wrapOk({
      folders: [],
      skipped: true,
      reason: 'Drive no configurado (DRIVE_PARENT_FOLDER_ID / DRIVE_SERVICE_ACCOUNT_KEY)',
    });
  }

  const servicioTecnicoItems =
    chatwootBlock.status === 'ok' ? chatwootBlock.data.servicioTecnico || [] : [];
  const driveData = driveBlock.status === 'ok' ? driveBlock.data : null;

  const strictNameNotes = [];
  if (settled[0].status === 'fulfilled' && settled[0].value.strictNameNote) {
    strictNameNotes.push(settled[0].value.strictNameNote);
  }
  if (settled[1].status === 'fulfilled' && settled[1].value.strictNameNote) {
    strictNameNotes.push(settled[1].value.strictNameNote);
  }
  if (settled[2].status === 'fulfilled' && settled[2].value.strictNameNote) {
    strictNameNotes.push(settled[2].value.strictNameNote);
  }

  const cwData = chatwootBlock.status === 'ok' ? chatwootBlock.data : null;
  const openConversations = (cwData?.allConversations || [])
    .filter((x) => x.isOpen)
    .map((x) => ({
      conversationId: x.conversationId,
      ticketId: x.ticketId,
      status: x.status,
      channel: x.channel,
      agent: x.agent,
      date: x.date,
      geminiSummary: x.geminiSummary,
      stTagged: x.stTagged,
    }));

  const chatwootBase = creds.chatwootBaseUrl ? String(creds.chatwootBaseUrl).replace(/\/+$/, '') : '';
  const shopifyOrigin = shopifyStoreOriginFromApiBase(creds.shopifyAdminApiBaseUrl || '');

  const equipmentFacts = collectEquipmentFactsFromCwData(cwData);

  // Reúne todos los identificadores de contacto extraídos de la búsqueda actual:
  // email, teléfono y pedidos Shopify, para persistirlos y cruzarlos históricamente.
  const contactIdentifiers = collectContactIdentifiers(cwData, shopifyBlock, plan);
  const allIdentifiers = [...equipmentFacts, ...contactIdentifiers];

  const currentConvIds = [...new Set(allIdentifiers.map((f) => f.conversationId).filter(Boolean))];
  const relatedByDevice = await lookupRelatedByDevice(supabase, allIdentifiers, currentConvIds);
  const similarTickets = groupSimilarTickets(relatedByDevice);
  upsertDeviceFacts(supabase, allIdentifiers); // fire-and-forget, no bloquea respuesta

  const meta = {
    recentSt: computeRecentSt({
      servicioTecnicoItems,
      driveResult: driveData,
    }),
    sources: sourceStats,
    unifiedProfile: buildUnifiedProfile(chatwootBlock, bsaleBlock, shopifyBlock),
    bsaleNote: settled[1].status === 'fulfilled' && settled[1].value.note ? settled[1].value.note : null,
    shopifyNote:
      settled[2].status === 'fulfilled' && settled[2].value.note && !settled[2].value.skipped
        ? settled[2].value.note
        : null,
    stOrdersFromChatwoot: stOrders,
    multipleOpenChats:
      chatwootBlock.status === 'ok' && (chatwootBlock.data.openConversationsCount || 0) > 1,
    openConversationsCount:
      chatwootBlock.status === 'ok' ? chatwootBlock.data.openConversationsCount || 0 : 0,
    openConversations,
    chatwootApp: chatwootBase
      ? { baseUrl: chatwootBase, accountId: String(creds.chatwootAccountId || '1') }
      : null,
    shopifyStoreOrigin: shopifyOrigin || null,
    plan: {
      type: plan.type,
      ...(plan.type === 'conversationId' && plan.conversationId != null
        ? { conversationId: plan.conversationId }
        : {}),
    },
    equipmentFacts,
    relatedByDevice,
    similarTickets,
    contactSummary: {
      name: cwData?.contacts?.[0]?.name || null,
      email: (cwData?.emailsFromContacts || [])[0] || null,
      phone: (cwData?.phonesFromContacts || [])[0] || null,
      ruts: cwData?.rutsFromMessages || [],
      smOrders: cwData?.shopifyOrdersFromMessages || [],
    },
    strictNameNote: strictNameNotes.length ? [...new Set(strictNameNotes)].join(' ') : null,
  };

  res.json({
    query: rawQ,
    chatwoot: {
      status: chatwootBlock.status,
      error: chatwootBlock.error,
      data:
        chatwootBlock.status === 'ok'
          ? {
              contacts: chatwootBlock.data.contacts,
              servicioTecnico: chatwootBlock.data.servicioTecnico,
              chatwoot: chatwootBlock.data.chatwoot,
              stOrdersFromMessages: chatwootBlock.data.stOrdersFromMessages,
              openConversationsCount: chatwootBlock.data.openConversationsCount,
              messagesAnalyzed: chatwootBlock.data.messagesAnalyzed,
            }
          : null,
    },
    bsale: bsaleBlock,
    shopify: shopifyBlock,
    drive: driveBlock,
    meta,
  });
});
