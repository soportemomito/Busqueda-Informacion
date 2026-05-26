import { createHmac, timingSafeEqual } from 'crypto';
import { Router } from 'express';
import { upsertContact } from '../db/contacts.js';
import { upsertConversation } from '../db/conversations.js';
import { saveMessage, markMessageProcessed } from '../db/messages.js';
import { linkDocument } from '../db/documents.js';
import { getDb } from '../db/supabase.js';
import { writeSyncLog } from '../db/sync_log.js';
import { extractEntities } from '../services/extractor.js';

export const panelWebhookRouter = Router();

function verifySignature(secret, rawBody, header) {
  if (!secret) return true; // dev mode: no secret configured
  if (!header || !rawBody) return false;
  const sig = header.replace(/^sha256=/i, '');
  try {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function toISO(v) {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v < 1e10 ? v * 1000 : v).toISOString();
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

panelWebhookRouter.post('/', async (req, res) => {
  const secret = process.env.CHATWOOT_WEBHOOK_SECRET || '';
  const sigHeader = req.headers['x-chatwoot-signature'] || '';

  if (!verifySignature(secret, req.rawBody, sigHeader)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const payload = req.body;

  // Respond 200 immediately — Chatwoot won't retry if we respond in time
  res.json({ ok: true });

  if (payload?.event !== 'message_created') return;

  // Process incoming customer messages (type 0) AND internal notes (type 2 / private=true)
  // Outgoing agent messages (type 1) are skipped — they contain agent data, not client data.
  const msgType = payload.message_type;
  const isCustomer    = msgType === 0 || msgType === 'incoming' || msgType === '0';
  const isInternalNote = payload.private === true || msgType === 2 || msgType === '2' || msgType === 'activity';
  if (!isCustomer && !isInternalNote) return;

  processWebhook(payload).catch(err => console.error('[webhook_panel] unhandled error:', err));
});

async function processWebhook(payload) {
  const db = getDb();
  const chatwootConvId = payload.conversation?.id;

  try {
    // 1. Upsert contact
    const sender = payload.sender || {};
    const metaSender = payload.conversation?.meta?.sender || {};
    const contact = await upsertContact({
      chatwoot_contact_id: sender.id || metaSender.id || null,
      name: sender.name || metaSender.name || null,
      email: sender.email || metaSender.email || null,
      phone_whatsapp: sender.phone_number || metaSender.phone_number || null,
    });

    // 2. Upsert conversation
    const conv = payload.conversation || {};
    const savedConv = await upsertConversation({
      chatwoot_conversation_id: chatwootConvId,
      chatwoot_inbox_id: conv.inbox_id || null,
      channel_type: conv.channel || null,
      contact_id: contact?.id || null,
      status: conv.status || null,
      assignee_name: conv.meta?.assignee?.name || null,
      labels: Array.isArray(conv.labels) ? conv.labels : [],
      chatwoot_created_at: toISO(conv.created_at),
    });

    // 3. Save message
    const savedMsg = await saveMessage({
      chatwoot_message_id: payload.id,
      conversation_id: savedConv?.id || null,
      content: payload.content || null,
      message_type: String(payload.message_type ?? ''),
      sender_type: sender.type || null,
    });

    // 4. Extract entities and persist
    if (savedMsg && payload.content) {
      const entities = extractEntities(payload.content);

      for (const entity of entities) {
        // Persist entity record
        const { data: savedEntity } = await db.from('extracted_entities').insert({
          message_id: savedMsg.id,
          conversation_id: savedConv?.id || null,
          entity_type: entity.entity_type,
          raw_value: entity.raw_value,
          normalized_value: entity.normalized_value,
          validated: false,
        }).select('id').single();

        if (entity.entity_type === 'imei' && entity.normalized_value) {
          const { data: device } = await db.from('devices')
            .upsert({ imei: entity.normalized_value }, { onConflict: 'imei' })
            .select('id').single();

          if (device && savedConv) {
            await db.from('conversation_devices').upsert({
              conversation_id: savedConv.id,
              device_id: device.id,
              extraction_method: 'regex',
              raw_text_fragment: entity.raw_value,
            }, { onConflict: 'conversation_id,device_id', ignoreDuplicates: true });

            if (contact) {
              await db.from('contact_devices').upsert({
                contact_id: contact.id,
                device_id: device.id,
                relationship: 'owner',
              }, { onConflict: 'contact_id,device_id', ignoreDuplicates: true });
            }
          }
        }

        if (entity.entity_type === 'shopify_order' && savedConv) {
          const { data: order } = await db.from('shopify_orders')
            .select('id').eq('order_name', entity.normalized_value).maybeSingle();
          if (order) await linkDocument({ conversation_id: savedConv.id, document_type: 'shopify', document_id: order.id, linked_method: 'extraction' });
        }

        if (entity.entity_type === 'boleta' && savedConv) {
          const { data: doc } = await db.from('bsale_documents')
            .select('id').eq('document_number', entity.normalized_value).maybeSingle();
          if (doc) await linkDocument({ conversation_id: savedConv.id, document_type: 'bsale', document_id: doc.id, linked_method: 'extraction' });
        }
      }

      await markMessageProcessed(savedMsg.id);
    }

    // 5. Detect duplicates via Supabase RPC
    if (chatwootConvId) {
      await db.rpc('detect_duplicates', { p_conversation_id: chatwootConvId });
    }

    await writeSyncLog({ event_type: 'message_created', source: 'webhook', reference_id: payload.id, status: 'success' });

  } catch (err) {
    console.error('[webhook_panel] processing error:', err);
    await writeSyncLog({ event_type: 'message_created', source: 'webhook', reference_id: payload.id, status: 'error', error_message: err.message }).catch(() => {});
  }
}
