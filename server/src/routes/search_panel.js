import { Router } from 'express';
import { getDb } from '../db/supabase.js';
import { findContact } from '../db/contacts.js';
import { getBsaleDocuments, getShopifyOrders, getServiceOrders } from '../db/documents.js';
import { getDuplicateSignals } from '../db/signals.js';
import { fetchBsaleForContact } from '../services/bsale_panel.js';
import { fetchShopifyForContact } from '../services/shopify_panel.js';
import { getContactFromConversation, getConversationMessages, searchContactInChatwoot } from '../services/chatwoot_panel.js';
import { extractEntities } from '../services/extractor.js';

export const panelSearchRouter = Router();

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Matches common email format in message text
const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
// Chilean mobile (+569XXXXXXXX, 569XXXXXXXX, 9XXXXXXXX)
const PHONE_RE = /(?:\+?56\s?)?9\d{8}/g;
// Internal SoyMomo domains — ignore emails from these
const INTERNAL_DOMAINS = new Set(['soymomo.com', 'soymomo.io', 'helpdesk.soymomo.io']);

function isStale(rows) {
  if (!rows.length) return true;
  const oldest = Math.min(...rows.map(r => new Date(r.fetched_at || 0).getTime()));
  return Date.now() - oldest > CACHE_TTL_MS;
}

function dedup(arr, key) {
  const seen = new Set();
  return arr.filter(r => { if (seen.has(r[key])) return false; seen.add(r[key]); return true; });
}

/**
 * Extracts all useful identifiers from conversation message text:
 * IMEIs, SIMs, order numbers, boletas, emails, phones.
 */
function extractFromMessages(messages) {
  const text = messages.map(m => m.content || '').join('\n');

  const entities = extractEntities(text);

  const imeis     = entities.filter(e => e.entity_type === 'imei').map(e => e.normalized_value);
  const simIds    = entities.filter(e => e.entity_type === 'sim_id').map(e => e.normalized_value);
  const shopifyOrders = entities.filter(e => e.entity_type === 'shopify_order').map(e => e.normalized_value);
  const boletas   = entities.filter(e => e.entity_type === 'boleta').map(e => e.normalized_value);
  const serviceOrders = entities.filter(e => e.entity_type === 'service_order').map(e => e.normalized_value);

  const emails = [...new Set(
    (text.match(EMAIL_RE) || [])
      .map(e => e.toLowerCase())
      .filter(e => !INTERNAL_DOMAINS.has(e.split('@')[1] || ''))
  )];

  const phones = [...new Set(
    (text.match(PHONE_RE) || []).map(p => p.replace(/[\s\-]/g, ''))
  )];

  return { imeis, simIds, shopifyOrders, boletas, serviceOrders, emails, phones, rawEntities: entities };
}

async function getDevicesForContact(db, contactInternalId, convInternalIds) {
  const seen = new Set();
  const devices = [];
  const add = (rows) => {
    for (const row of rows || []) {
      const dev = row.devices;
      if (!dev || seen.has(row.device_id)) continue;
      seen.add(row.device_id);
      devices.push(dev);
    }
  };
  if (convInternalIds.length) {
    const { data } = await db.from('conversation_devices')
      .select('device_id, devices(id, imei, sim_id, brand, model)')
      .in('conversation_id', convInternalIds);
    add(data);
  }
  const { data } = await db.from('contact_devices')
    .select('device_id, devices(id, imei, sim_id, brand, model)')
    .eq('contact_id', contactInternalId);
  add(data);
  return devices;
}

panelSearchRouter.get('/', async (req, res) => {
  try {
    const { email, phone, name, conversation_id } = req.query;
    const db = getDb();

    // ── 1. Try Supabase first ─────────────────────────────────────────────────
    let contact = null;
    let searchedBy = 'none';

    if (conversation_id) {
      const { data: conv } = await db.from('conversations')
        .select('id, contact_id, contacts(id, chatwoot_contact_id, name, email, phone_whatsapp)')
        .eq('chatwoot_conversation_id', Number(conversation_id))
        .maybeSingle();
      if (conv?.contacts) { contact = conv.contacts; searchedBy = 'conversation_id'; }
    }
    if (!contact && email) { contact = await findContact({ email });  searchedBy = 'email'; }
    if (!contact && phone) { contact = await findContact({ phone });  searchedBy = 'phone'; }
    if (!contact && name)  { contact = await findContact({ name });   searchedBy = 'name'; }

    // ── 2. Chatwoot fallback — fetch contact + messages in parallel ────────────
    if (!contact) {
      const [cwResult, messages] = await Promise.all([
        conversation_id
          ? getContactFromConversation(conversation_id)
          : searchContactInChatwoot({ email, phone, name }),
        conversation_id ? getConversationMessages(conversation_id) : Promise.resolve([]),
      ]);

      if (!cwResult) {
        return res.json({
          contact: null, devices: [], conversations: [], bsale_documents: [],
          shopify_orders: [], service_orders: [], duplicate_signals: [],
          meta: { searched_by: searchedBy, found: false },
        });
      }

      const c = cwResult.contact;
      const extracted = extractFromMessages(messages);

      // Build full identifier set: contact data + extracted from messages
      const allEmails = [...new Set([c.email, ...extracted.emails].filter(Boolean))];
      const allPhones = [...new Set([c.phone_whatsapp, ...extracted.phones].filter(Boolean))];

      // Parallel: live API searches + Supabase lookups by extracted entities
      const [
        bsaleFromApi,
        shopifyFromApi,
        deviceRows,
        shopifyByOrder,
        bsaleByBoleta,
        serviceByOrder,
      ] = await Promise.all([
        fetchBsaleForContact(allEmails[0] || null, allPhones[0] || null, c.name),
        fetchShopifyForContact(allEmails[0] || null, allPhones[0] || null),
        extracted.imeis.length
          ? db.from('devices').select('imei, sim_id, brand, model').in('imei', extracted.imeis)
          : Promise.resolve({ data: [] }),
        extracted.shopifyOrders.length
          ? db.from('shopify_orders').select('*').in('order_name', extracted.shopifyOrders)
          : Promise.resolve({ data: [] }),
        extracted.boletas.length
          ? db.from('bsale_documents').select('*').in('document_number', extracted.boletas)
          : Promise.resolve({ data: [] }),
        extracted.serviceOrders.length
          ? db.from('service_orders').select('*').in('order_number', extracted.serviceOrders)
          : Promise.resolve({ data: [] }),
      ]);

      // Merge + deduplicate
      const allBsale   = dedup([...bsaleFromApi, ...(bsaleByBoleta.data || [])], 'document_number');
      const allShopify = dedup([...shopifyFromApi, ...(shopifyByOrder.data || [])], 'shopify_order_id');
      const devices    = deviceRows.data || [];

      // Cache results async (fire-and-forget)
      if (allBsale.length)
        db.from('bsale_documents').upsert(allBsale, { onConflict: 'document_number', ignoreDuplicates: false }).catch(() => {});
      if (allShopify.length)
        db.from('shopify_orders').upsert(allShopify, { onConflict: 'shopify_order_id', ignoreDuplicates: false }).catch(() => {});

      return res.json({
        contact: {
          id: null,
          name: c.name,
          email: allEmails[0] || c.email,
          phone: allPhones[0] || c.phone_whatsapp,
          chatwoot_contact_id: c.chatwoot_contact_id,
        },
        devices: devices.map(d => ({ imei: d.imei, sim_id: d.sim_id, brand: d.brand, model: d.model })),
        conversations: cwResult.conversations,
        bsale_documents: allBsale.map(d => ({
          document_number: d.document_number, document_type: d.document_type,
          total_amount: d.total_amount, issued_at: d.issued_at,
        })),
        shopify_orders: allShopify.map(o => ({
          order_name: o.order_name, status: o.status,
          financial_status: o.financial_status, total_price: o.total_price,
        })),
        service_orders: (serviceByOrder.data || []).map(o => ({
          order_number: o.order_number, status: o.status,
          technician: o.technician, received_at: o.received_at,
        })),
        duplicate_signals: [],
        meta: {
          searched_by: searchedBy + '_chatwoot',
          found: true,
          extracted: {
            emails: extracted.emails,
            phones: extracted.phones,
            imeis: extracted.imeis,
            shopify_orders: extracted.shopifyOrders,
            boletas: extracted.boletas,
            service_orders: extracted.serviceOrders,
          },
        },
      });
    }

    // ── 3. Contact found in Supabase — also enrich with conversation messages ──
    const [convRows, messages] = await Promise.all([
      db.from('conversations')
        .select('id, chatwoot_conversation_id, channel_type, status, assignee_name, labels, chatwoot_created_at')
        .eq('contact_id', contact.id)
        .eq('is_merged', false)
        .order('chatwoot_created_at', { ascending: false }),
      conversation_id ? getConversationMessages(conversation_id) : Promise.resolve([]),
    ]);

    const conversations = convRows.data || [];
    const convInternalIds = conversations.map(c => c.id);
    const convChatwootIds = conversations.map(c => c.chatwoot_conversation_id);

    const extracted = extractFromMessages(messages);
    const allEmails = [...new Set([contact.email, ...extracted.emails].filter(Boolean))];
    const allPhones = [...new Set([contact.phone_whatsapp, ...extracted.phones].filter(Boolean))];

    const devices = await getDevicesForContact(db, contact.id, convInternalIds);
    const deviceIds = devices.map(d => d.id);

    // Bsale: cache-or-fetch + merge with boletas found in messages
    let bsaleDocs = await getBsaleDocuments(contact.id, allEmails[0] || null, convInternalIds);
    if (isStale(bsaleDocs) && (process.env.BSALE_ACCESS_TOKEN || process.env.BSALE_API_TOKEN)) {
      const fresh = await fetchBsaleForContact(allEmails[0] || null, allPhones[0] || null, contact.name);
      if (fresh.length) {
        await db.from('bsale_documents').upsert(fresh, { onConflict: 'document_number', ignoreDuplicates: false });
        bsaleDocs = fresh;
      }
    }
    if (extracted.boletas.length) {
      const { data: byNum } = await db.from('bsale_documents').select('*').in('document_number', extracted.boletas);
      bsaleDocs = dedup([...bsaleDocs, ...(byNum || [])], 'document_number');
    }

    // Shopify: cache-or-fetch + merge with orders found in messages
    let shopifyOrders = await getShopifyOrders(contact.id, allEmails[0] || null, allPhones[0] || null, convInternalIds);
    if (isStale(shopifyOrders) && process.env.SHOPIFY_ACCESS_TOKEN && (process.env.SHOPIFY_API_URL || process.env.SHOPIFY_STORE_URL)) {
      const fresh = await fetchShopifyForContact(allEmails[0] || null, allPhones[0] || null);
      if (fresh.length) {
        await db.from('shopify_orders').upsert(fresh, { onConflict: 'shopify_order_id', ignoreDuplicates: false });
        shopifyOrders = fresh;
      }
    }
    if (extracted.shopifyOrders.length) {
      const { data: byName } = await db.from('shopify_orders').select('*').in('order_name', extracted.shopifyOrders);
      shopifyOrders = dedup([...shopifyOrders, ...(byName || [])], 'shopify_order_id');
    }

    // Devices from extracted IMEIs
    if (extracted.imeis.length) {
      const { data: extraDevices } = await db.from('devices').select('*').in('imei', extracted.imeis);
      const extraIds = (extraDevices || []).map(d => d.id);
      devices.push(...(extraDevices || []).filter(d => !deviceIds.includes(d.id)));
      deviceIds.push(...extraIds.filter(id => !deviceIds.includes(id)));
    }

    const serviceOrders = await getServiceOrders(contact.id, deviceIds, convInternalIds);
    const duplicateSignals = await getDuplicateSignals(convChatwootIds);

    res.json({
      contact: {
        id: contact.id,
        name: contact.name,
        email: allEmails[0] || contact.email,
        phone: allPhones[0] || contact.phone_whatsapp,
        chatwoot_contact_id: contact.chatwoot_contact_id,
      },
      devices: devices.map(d => ({ imei: d.imei, sim_id: d.sim_id, brand: d.brand, model: d.model })),
      conversations: conversations.map(c => ({
        chatwoot_conversation_id: c.chatwoot_conversation_id,
        channel_type: c.channel_type,
        status: c.status,
        chatwoot_created_at: c.chatwoot_created_at,
        assignee_name: c.assignee_name,
        labels: c.labels,
      })),
      bsale_documents: bsaleDocs.map(d => ({
        document_number: d.document_number, document_type: d.document_type,
        total_amount: d.total_amount, issued_at: d.issued_at,
      })),
      shopify_orders: shopifyOrders.map(o => ({
        order_name: o.order_name, status: o.status,
        financial_status: o.financial_status, total_price: o.total_price,
      })),
      service_orders: serviceOrders.map(o => ({
        order_number: o.order_number, status: o.status,
        technician: o.technician, received_at: o.received_at,
      })),
      duplicate_signals: duplicateSignals.map(s => ({
        signal_type: s.signal_type, signal_value: s.signal_value,
        conversation_id_a: s.conversation_id_a, conversation_id_b: s.conversation_id_b,
        status: s.status,
      })),
      meta: {
        searched_by: searchedBy,
        found: true,
        extracted: {
          emails: extracted.emails,
          phones: extracted.phones,
          imeis: extracted.imeis,
          shopify_orders: extracted.shopifyOrders,
          boletas: extracted.boletas,
          service_orders: extracted.serviceOrders,
        },
      },
    });

  } catch (err) {
    console.error('[search_panel] error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
