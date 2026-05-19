import { Router } from 'express';
import { getSupabase } from '../lib/supabase.js';
import { extractDeviceFactsFromText } from '../lib/extractDeviceFacts.js';

export const webhookRouter = Router();

const ST_CONTEXT_RE = /ST|servicio\s*t[eé]cnico/i;
const ORDER_TOKEN_RE = /[PES]-?\d+/gi;
const SHOPIFY_ORDER_IN_MSG_RE = /\b[A-Za-z]{1,4}#\d{3,8}\b/g;

function extractStOrdersFromText(text) {
  if (!text || typeof text !== 'string') return [];
  if (!ST_CONTEXT_RE.test(text)) return [];
  const raw = text.match(new RegExp(ORDER_TOKEN_RE.source, 'gi')) || [];
  return [...new Set(raw.map((x) => x.toUpperCase().replace(/\s/g, '')))];
}

function extractGeminiSummary(customAttributes) {
  if (!customAttributes || typeof customAttributes !== 'object') return null;
  const keys = [
    'gemini_summary',
    'geminiSummary',
    'ai_summary',
    'summary',
    'resumen_gemini',
    'conversation_summary',
    'ai_conversation_summary',
    'copilot_summary',
  ];
  for (const k of keys) {
    const v = customAttributes[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

webhookRouter.post('/chatwoot', async (req, res) => {
  const payload = req.body;
  if (!payload || !payload.event) {
    return res.status(400).json({ error: 'Payload inválido' });
  }

  // Responder rápido para no bloquear el webhook de Chatwoot
  res.json({ ok: true });

  // Procesamiento asíncrono
  (async () => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        console.error('Supabase no configurado, omitiendo webhook');
        return;
      }

      const event = payload.event;
      
      // Manejar message_created
      if (event === 'message_created') {
        const messageId = payload.id;
        const conversationId = payload.conversation?.id;
        const contactId = payload.sender?.id;
        const content = payload.content || '';
        const messageType = payload.message_type != null ? String(payload.message_type) : null;
        const senderType = payload.sender?.type;

        if (!conversationId) return;

        // 1. Guardar mensaje en crudo
        await supabase.from('chatwoot_messages').upsert({
          message_id: messageId,
          conversation_id: conversationId,
          contact_id: contactId,
          content: content,
          message_type: messageType,
          sender_type: senderType,
          raw_payload: payload,
        }, { onConflict: 'message_id' });

        // 2. Extraer datos y actualizar resumen
        const conversation = payload.conversation || {};
        const contact = payload.sender?.type === 'Contact' ? payload.sender : (conversation.meta?.sender || {});
        
        const contactName = contact.name || null;
        const contactEmail = contact.email || null;
        const contactPhone = contact.phone_number || null;
        
        const aiSummary = extractGeminiSummary(conversation.custom_attributes);
        
        // Obtener historial previo para no perder arrays si ya existen
        const { data: existing } = await supabase
          .from('conversation_summaries')
          .select('extracted_imei, extracted_sim, extracted_st_tickets, extracted_shopify_orders')
          .eq('conversation_id', conversationId)
          .single();

        const currentImeis = new Set(existing?.extracted_imei || []);
        const currentSims = new Set(existing?.extracted_sim || []);
        const currentSt = new Set(existing?.extracted_st_tickets || []);
        const currentShopify = new Set(existing?.extracted_shopify_orders || []);

        // Extraer nuevos de este mensaje
        const facts = extractDeviceFactsFromText(content);
        for (const f of facts) {
          if (f.label === 'ID / IMEI') currentImeis.add(f.value);
          if (f.label === 'ICCID / SIM') currentSims.add(f.value);
        }

        const newSt = extractStOrdersFromText(content);
        for (const st of newSt) currentSt.add(st);

        const newShopify = (content.match(SHOPIFY_ORDER_IN_MSG_RE) || []).map(o => o.toUpperCase());
        for (const sm of newShopify) currentShopify.add(sm);

        // Guardar resumen consolidado
        await supabase.from('conversation_summaries').upsert({
          conversation_id: conversationId,
          contact_id: contact.id || null,
          contact_name: contactName,
          contact_email: contactEmail,
          contact_phone: contactPhone,
          ai_summary: aiSummary,
          extracted_imei: [...currentImeis],
          extracted_sim: [...currentSims],
          extracted_st_tickets: [...currentSt],
          extracted_shopify_orders: [...currentShopify],
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }

      // Podríamos manejar conversation_updated aquí si queremos actualizar el resumen AI cuando cambia
      if (event === 'conversation_updated') {
        const conversationId = payload.id;
        const aiSummary = extractGeminiSummary(payload.custom_attributes);
        
        if (conversationId && aiSummary) {
          // Actualizar solo el ai_summary si existe
          await supabase.from('conversation_summaries')
            .update({ ai_summary: aiSummary, updated_at: new Date().toISOString() })
            .eq('conversation_id', conversationId);
        }
      }

    } catch (error) {
      console.error('Error procesando webhook Chatwoot:', error);
    }
  })();
});
