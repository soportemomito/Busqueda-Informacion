import { Router } from 'express';
import { getSupabase } from '../lib/supabase.js';
import { resolveCredentials } from '../lib/resolveCredentials.js';
import { generateGeminiSummaryAndFacts } from '../services/gemini.js';
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

    // Adaptamos los mensajes al formato esperado por generateGeminiSummaryAndFacts
    const messagesForSummary = rawMessages.map(m => ({
      content: m.content || '',
      message_type: String(m.message_type),
      sender_type: m.sender?.type,
      private: m.private || false
    })).sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));

    // 3. Ejecutar Gemini (esto ignora atributos viejos de Chatwoot y extrae 100% fresco del texto)
    const aiData = await generateGeminiSummaryAndFacts(
      messagesForSummary, 
      contactName, 
      { geminiApiKey: geminiKey }, 
      null // chatwootMeta null para forzar que use Gemini
    );

    const email = aiData.contact_email;
    const phone = aiData.contact_phone;
    const rut = aiData.extracted_ruts?.[0] || null;
    const comuna = aiData.extracted_comunas?.[0] || null;
    const falla = aiData.extracted_failures?.[0] || null;
    // Ojo: generateGeminiSummaryAndFacts (en su fallback) extrae del texto, 
    // pero idealmente extrajo un objeto de IA en webhook.js
    // Como lo llamamos directamente, nos devuelve un objeto.
    
    // NOTA: 'generateGeminiSummaryAndFacts' prioriza callGeminiApi que devuelve un JSON estructurado.
    // Ese JSON luego es pisado a string por "aiSummary = await callGeminiApi(..)". 
    // Wait, let's use our robust manual call directly to gemini to ensure we get the full JSON 
    // as webhook.js does!
    
    // Mejor copiamos la lógica sólida del webhook:
    const { callGeminiApi } = await import('../services/gemini.js');
    const fullAiJson = await callGeminiApi(geminiKey, messagesForSummary);
    
    let aiSummary = fullAiJson?.ai_summary || aiData.ai_summary;
    let finalRut = rut;
    let finalComuna = comuna;
    let finalAddress = null;
    let finalFalla = falla;
    let finalEmail = email;
    let finalPhone = phone;
    let sentiment = null;
    let complexity = null;

    if (fullAiJson && typeof fullAiJson === 'object') {
      if (fullAiJson.rut) finalRut = String(fullAiJson.rut).replace(/[\s.-]/g, '').toUpperCase().slice(0, -1) + '-' + String(fullAiJson.rut).replace(/[\s.-]/g, '').toUpperCase().slice(-1);
      if (fullAiJson.location?.comuna) finalComuna = fullAiJson.location.comuna;
      if (fullAiJson.location?.address) finalAddress = fullAiJson.location.address;
      if (fullAiJson.failure_categories?.[0]) finalFalla = fullAiJson.failure_categories[0];
      if (fullAiJson.alt_email) finalEmail = fullAiJson.alt_email.toLowerCase();
      if (fullAiJson.phone) finalPhone = String(fullAiJson.phone).replace(/[^\d+]/g, '');
      sentiment = fullAiJson.customer_sentiment;
      complexity = fullAiJson.issue_complexity;
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

    // 5. Actualizar Supabase
    const summaryPayload = {
      conversation_id: conversationId,
      contact_id: contactId,
      contact_name: contactName,
      contact_email: finalEmail,
      contact_phone: finalPhone,
      ai_summary: aiSummary,
      extracted_address: finalAddress,
      updated_at: new Date().toISOString()
    };
    
    // Intentar upsert del summary
    await supabase.from('conversation_summaries').upsert(summaryPayload);

    // Para los ruts y otros arrays, podemos meterlos, pero ya limpiamos lo importante.

    return res.json({ success: true, extracted: attributesToWrite });
  } catch (err) {
    console.error('[aiSync] Error global:', err);
    return res.status(500).json({ error: err.message });
  }
});
