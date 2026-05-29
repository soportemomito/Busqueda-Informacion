import { Router } from 'express';
import { getSupabase } from '../lib/supabase.js';
import { resolveCredentials } from '../lib/resolveCredentials.js';
import { callGeminiApi } from '../services/gemini.js';
import { writeAttributesToChatwoot } from '../services/chatwoot_writeback.js';
import { fetchConversationMessages } from '../services/chatwoot.js';
import axios from 'axios';

export const aiSyncRouter = Router();

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

async function fetchContactInfo(base, token, accountId, contactId) {
  if (!contactId) return null;
  const client = axios.create({ baseURL: base, headers: { api_access_token: token } });
  try {
    const { data } = await client.get(`/api/v1/accounts/${accountId}/contacts/${contactId}`);
    return data?.payload || data;
  } catch (err) {
    console.error(`[aiSync] Error fetching contact ${contactId}:`, err.message);
    return null;
  }
}

async function fetchConversationDetail(base, token, accountId, convId) {
  const client = axios.create({ baseURL: base, headers: { api_access_token: token } });
  try {
    const { data } = await client.get(`/api/v1/accounts/${accountId}/conversations/${convId}`);
    return data?.payload || data;
  } catch (err) {
    console.error(`[aiSync] Error fetching conversation ${convId}:`, err.message);
    return null;
  }
}

aiSyncRouter.post('/:conversationId', async (req, res) => {
  const conversationId = req.params.conversationId;
  const supabase = getSupabase();

  if (!supabase) {
    return res.status(500).json({ error: 'Supabase no configurado' });
  }

  let creds;
  try {
    creds = await resolveCredentials(supabase);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const base = normalizeBaseUrl(creds.chatwootBaseUrl);
  const token = creds.chatwootApiToken;
  const accountId = creds.chatwootAccountId || '1';
  const geminiKey = creds.geminiApiKey || process.env.GEMINI_API_KEY;

  if (!base || !token) {
    return res.status(400).json({ error: 'Credenciales de Chatwoot no configuradas' });
  }

  if (!geminiKey) {
    return res.status(400).json({ error: 'API Key de Gemini no configurada' });
  }

  try {
    console.log(`[aiSync] Forzando análisis IA para conv #${conversationId}...`);
    
    // 1. Fetch conversación y contacto desde Chatwoot
    const conv = await fetchConversationDetail(base, token, accountId, conversationId);
    if (!conv) {
      return res.status(404).json({ error: 'Conversación no encontrada en Chatwoot' });
    }
    const contactId = conv.meta?.sender?.id;
    const contact = await fetchContactInfo(base, token, accountId, contactId);
    const contactName = contact?.name || conv.meta?.sender?.name || null;

    // 2. Fetch mensajes
    const client = axios.create({ baseURL: base, headers: { api_access_token: token } });
    const rawMessages = await fetchConversationMessages(client, accountId, conversationId, 100);
    if (!rawMessages || rawMessages.length === 0) {
      return res.status(400).json({ error: 'No hay mensajes para analizar' });
    }

    const messagesForSummary = rawMessages.map(m => ({
      content: m.content || '',
      message_type: String(m.message_type),
      sender_type: m.sender?.type,
      private: m.private || false
    }));

    // 3. Single Gemini call — structured JSON with all fields
    const fullAiJson = await callGeminiApi(geminiKey, messagesForSummary);

    let aiSummary = fullAiJson?.ai_summary || null;
    let finalRut = null;
    let finalComuna = null;
    let finalAddress = null;
    let finalFalla = null;
    let finalEmail = contact?.email || null;
    let finalPhone = contact?.phone_number || null;
    let sentiment = null;
    let complexity = null;

    if (fullAiJson && typeof fullAiJson === 'object') {
      if (fullAiJson.rut) {
        const r = String(fullAiJson.rut).replace(/[\s.-]/g, '').toUpperCase();
        finalRut = r.slice(0, -1) + '-' + r.slice(-1);
      }
      if (fullAiJson.location?.comuna) finalComuna = fullAiJson.location.comuna;
      if (fullAiJson.location?.address) finalAddress = fullAiJson.location.address;
      if (fullAiJson.failure_categories?.[0]) finalFalla = fullAiJson.failure_categories[0];
      if (fullAiJson.alt_email) finalEmail = fullAiJson.alt_email.toLowerCase();
      if (fullAiJson.phone) finalPhone = String(fullAiJson.phone).replace(/[^\d+]/g, '');
      sentiment = fullAiJson.customer_sentiment || null;
      complexity = fullAiJson.issue_complexity || null;
    }

    // 4. Sobrescribir Chatwoot (limpiar basura)
    // Para limpiar la basura, mandamos atributos con string vacío si la IA no encontró nada
    // para que borre el 975394012 que estaba metido en "rut" por el regex viejo.
    const attributesToWrite = {
      rut: finalRut || '',
      comuna: finalComuna || '',
      direccion: finalAddress || '',
      falla: finalFalla || '',
      resumen: aiSummary || '',
      email: finalEmail || contact?.email,
      phone: finalPhone || contact?.phone_number,
      customer_sentiment: sentiment || '',
      issue_complexity: complexity || ''
    };

    console.log(`[aiSync] Enviando atributos limpios a Chatwoot:`, attributesToWrite);
    await writeAttributesToChatwoot(creds, accountId, contactId, conversationId, attributesToWrite);

    // 5. Actualizar Supabase — preservar arrays existentes (extracted_imei, etc.)
    const convIdInt = Number(conversationId);

    // Fetch existing row so we don't wipe arrays already stored by the webhook
    const { data: existing } = await supabase
      .from('conversation_summaries')
      .select('extracted_imei, extracted_sim, extracted_st_tickets, extracted_shopify_orders, extracted_device_models, last_message_at')
      .eq('conversation_id', convIdInt)
      .maybeSingle();

    // Merge Gemini-extracted arrays from messages into existing ones
    const mergeArrays = (...arrs) => [...new Set(arrs.flat().filter(Boolean))];
    const geminiServiceOrders = (fullAiJson?.service_orders || []).map(String);
    const geminiShopifyOrders = (fullAiJson?.shopify_orders || []).map(String);
    const geminiDevices       = (fullAiJson?.devices_mentioned || []).map(d => d.imei).filter(Boolean);
    const geminiSims          = (fullAiJson?.devices_mentioned || []).map(d => d.sim).filter(Boolean);

    const summaryPayload = {
      conversation_id: convIdInt,
      contact_id: contactId,
      contact_name: contactName,
      contact_email: finalEmail,
      contact_phone: finalPhone,
      ai_summary: aiSummary,
      extracted_address: finalAddress,
      customer_sentiment: sentiment,
      issue_complexity: complexity,
      extracted_imei:           mergeArrays(existing?.extracted_imei || [], geminiDevices),
      extracted_sim:            mergeArrays(existing?.extracted_sim  || [], geminiSims),
      extracted_st_tickets:     mergeArrays(existing?.extracted_st_tickets || [], geminiServiceOrders),
      extracted_shopify_orders: mergeArrays(existing?.extracted_shopify_orders || [], geminiShopifyOrders),
      extracted_device_models:  existing?.extracted_device_models || [],
      last_message_at:          existing?.last_message_at || new Date().toISOString(),
      updated_at:               new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase.from('conversation_summaries').upsert(summaryPayload);
    if (upsertErr) console.error('[aiSync] Error upserting summary:', upsertErr.message);

    return res.json({ success: true, extracted: attributesToWrite });
  } catch (err) {
    console.error('[aiSync] Error global:', err);
    return res.status(500).json({ error: err.message });
  }
});
