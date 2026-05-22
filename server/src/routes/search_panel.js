import { Router } from 'express';
import { getDb } from '../db/supabase.js';
import { findContact } from '../db/contacts.js';
import { getBsaleDocuments, getShopifyOrders, getServiceOrders } from '../db/documents.js';
import { getDuplicateSignals } from '../db/signals.js';
import { fetchBsaleForContact } from '../services/bsale_panel.js';
import { fetchShopifyForContact } from '../services/shopify_panel.js';
import { getContactFromConversation, searchContactInChatwoot } from '../services/chatwoot_panel.js';

export const panelSearchRouter = Router();

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function isStale(rows) {
  if (!rows.length) return true;
  const oldest = Math.min(...rows.map(r => new Date(r.fetched_at || 0).getTime()));
  return Date.now() - oldest > CACHE_TTL_MS;
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

    // Locate contact
    let contact = null;
    let searchedBy = 'none';

    if (conversation_id) {
      const { data: conv } = await db.from('conversations')
        .select('id, contact_id, contacts(id, chatwoot_contact_id, name, email, phone_whatsapp)')
        .eq('chatwoot_conversation_id', Number(conversation_id))
        .maybeSingle();
      if (conv?.contacts) { contact = conv.contacts; searchedBy = 'conversation_id'; }
    }
    if (!contact && email)  { contact = await findContact({ email });  searchedBy = 'email'; }
    if (!contact && phone)  { contact = await findContact({ phone });  searchedBy = 'phone'; }
    if (!contact && name)   { contact = await findContact({ name });   searchedBy = 'name'; }

    // Fallback: Supabase empty → resolve full contact from Chatwoot
    if (!contact) {
      // Prefer conversation_id (gives full contact with all channel data)
      let cwResult = null;
      if (conversation_id) {
        cwResult = await getContactFromConversation(conversation_id);
      }
      // Manual search fallback
      if (!cwResult) {
        cwResult = await searchContactInChatwoot({ email, phone, name });
      }
      if (!cwResult) {
        return res.json({
          contact: null, devices: [], conversations: [], bsale_documents: [],
          shopify_orders: [], service_orders: [], duplicate_signals: [],
          meta: { searched_by: searchedBy, found: false },
        });
      }

      const c = cwResult.contact;

      // Use ALL available identifiers: email + phone + name
      const [bsaleDocs, shopifyOrders] = await Promise.all([
        fetchBsaleForContact(c.email, c.phone_whatsapp, c.name),
        fetchShopifyForContact(c.email, c.phone_whatsapp),
      ]);

      // Cache results in Supabase for next time
      const db = getDb();
      if (bsaleDocs.length) {
        db.from('bsale_documents')
          .upsert(bsaleDocs, { onConflict: 'document_number', ignoreDuplicates: false })
          .catch(() => {});
      }
      if (shopifyOrders.length) {
        db.from('shopify_orders')
          .upsert(shopifyOrders, { onConflict: 'shopify_order_id', ignoreDuplicates: false })
          .catch(() => {});
      }

      return res.json({
        contact: {
          id: null,
          name: c.name,
          email: c.email,
          phone: c.phone_whatsapp,
          chatwoot_contact_id: c.chatwoot_contact_id,
        },
        devices: [],
        conversations: cwResult.conversations,
        bsale_documents: bsaleDocs.map(d => ({
          document_number: d.document_number,
          document_type: d.document_type,
          total_amount: d.total_amount,
          issued_at: d.issued_at,
        })),
        shopify_orders: shopifyOrders.map(o => ({
          order_name: o.order_name,
          status: o.status,
          financial_status: o.financial_status,
          total_price: o.total_price,
        })),
        service_orders: [],
        duplicate_signals: [],
        meta: { searched_by: searchedBy + '_chatwoot', found: true },
      });
    }

    // Conversations (non-merged)
    const { data: convRows } = await db.from('conversations')
      .select('id, chatwoot_conversation_id, channel_type, status, assignee_name, labels, chatwoot_created_at')
      .eq('contact_id', contact.id)
      .eq('is_merged', false)
      .order('chatwoot_created_at', { ascending: false });

    const conversations = convRows || [];
    const convInternalIds = conversations.map(c => c.id);
    const convChatwootIds = conversations.map(c => c.chatwoot_conversation_id);

    // Devices
    const devices = await getDevicesForContact(db, contact.id, convInternalIds);
    const deviceIds = devices.map(d => d.id);

    // Bsale (cache-or-fetch)
    let bsaleDocs = await getBsaleDocuments(contact.id, contact.email, convInternalIds);
    if (isStale(bsaleDocs) && (process.env.BSALE_ACCESS_TOKEN || process.env.BSALE_API_TOKEN)) {
      const fresh = await fetchBsaleForContact(contact.email, contact.phone_whatsapp, contact.name);
      if (fresh.length) {
        await db.from('bsale_documents')
          .upsert(fresh, { onConflict: 'document_number', ignoreDuplicates: false });
        bsaleDocs = fresh;
      }
    }

    // Shopify (cache-or-fetch)
    let shopifyOrders = await getShopifyOrders(contact.id, contact.email, contact.phone_whatsapp, convInternalIds);
    if (isStale(shopifyOrders) && process.env.SHOPIFY_ACCESS_TOKEN && (process.env.SHOPIFY_API_URL || process.env.SHOPIFY_STORE_URL)) {
      const fresh = await fetchShopifyForContact(contact.email, contact.phone_whatsapp);
      if (fresh.length) {
        await db.from('shopify_orders')
          .upsert(fresh, { onConflict: 'shopify_order_id', ignoreDuplicates: false });
        shopifyOrders = fresh;
      }
    }

    // Service orders
    const serviceOrders = await getServiceOrders(contact.id, deviceIds, convInternalIds);

    // Duplicate signals
    const duplicateSignals = await getDuplicateSignals(convChatwootIds);

    res.json({
      contact: {
        id: contact.id,
        name: contact.name,
        email: contact.email,
        phone: contact.phone_whatsapp,
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
        document_number: d.document_number,
        document_type: d.document_type,
        total_amount: d.total_amount,
        issued_at: d.issued_at,
      })),
      shopify_orders: shopifyOrders.map(o => ({
        order_name: o.order_name,
        status: o.status,
        financial_status: o.financial_status,
        total_price: o.total_price,
      })),
      service_orders: serviceOrders.map(o => ({
        order_number: o.order_number,
        status: o.status,
        technician: o.technician,
        received_at: o.received_at,
      })),
      duplicate_signals: duplicateSignals.map(s => ({
        signal_type: s.signal_type,
        signal_value: s.signal_value,
        conversation_id_a: s.conversation_id_a,
        conversation_id_b: s.conversation_id_b,
        status: s.status,
      })),
      meta: { searched_by: searchedBy, found: true },
    });

  } catch (err) {
    console.error('[search_panel] error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
