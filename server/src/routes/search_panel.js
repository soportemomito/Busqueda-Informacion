import { Router } from 'express';
import { getDb } from '../db/supabase.js';
import { getContactFromConversation, getConversationMessages } from '../services/chatwoot_panel.js';
import { runEnrichment } from '../services/enrichment.js';
import { getDuplicateSignals } from '../db/signals.js';

export const panelSearchRouter = Router();

panelSearchRouter.get('/', async (req, res) => {
  try {
    const { email, phone, name, conversation_id, imei, shopify_order, boleta, service_order } = req.query;
    const db = getDb();

    const seed = {};

    // If conversation_id: pre-fetch contact + messages from Chatwoot and seed them
    if (conversation_id) {
      const [cwResult, messages] = await Promise.all([
        getContactFromConversation(conversation_id),
        getConversationMessages(conversation_id),
      ]);

      if (cwResult) {
        seed.cwContact       = cwResult.contact;
        seed.cwConversations = cwResult.conversations;
      }
      seed.messages = messages;
    }

    // Explicit query params always win / supplement
    if (email)         seed.email         = email;
    if (phone)         seed.phone         = phone;
    if (name)          seed.name          = name;
    if (imei)          seed.imei          = imei;
    if (shopify_order) seed.shopify_order = shopify_order;
    if (boleta)        seed.boleta        = boleta;
    if (service_order) seed.service_order = service_order;

    // Nothing to search with
    if (!Object.keys(seed).length) {
      return res.json({
        contact: null, conversations: [], devices: [],
        bsale_documents: [], shopify_orders: [], service_orders: [],
        identifiers: {},
        meta: { found: false, reason: 'no_seed' },
      });
    }

    const ctx = await runEnrichment(seed, db);
    const result = ctx.toResult();

    const found = !!(
      result.contact ||
      result.conversations.length ||
      result.devices.length ||
      result.shopify_orders.length ||
      result.bsale_documents.length ||
      result.service_orders.length
    );

    const chatwootConvIds = result.conversations
      .map((c) => c.chatwoot_conversation_id)
      .filter(Boolean);
    const duplicateSignals = chatwootConvIds.length
      ? await getDuplicateSignals(chatwootConvIds).catch(() => [])
      : [];

    res.json({
      ...result,
      duplicate_signals: duplicateSignals,
      meta: { found },
    });

  } catch (err) {
    console.error('[search_panel] error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
