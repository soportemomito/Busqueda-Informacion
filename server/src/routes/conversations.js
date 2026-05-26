import { Router } from 'express';
import { getSupabase } from '../lib/supabase.js';
import axios from 'axios';
import { resolveCredentials } from '../lib/resolveCredentials.js';
import { fetchConversationMessages } from '../services/chatwoot.js';
import { generateGeminiSummaryAndFacts } from '../services/gemini.js';

export const conversationsRouter = Router();

conversationsRouter.get('/:id/summary', async (req, res) => {
  const conversationId = Number(req.params.id);
  if (!Number.isFinite(conversationId)) {
    return res.status(400).json({ error: 'ID inválido' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase no configurado' });
  }

  try {
    // 1. Obtener la conversación actual
    const { data: summary, error: summaryErr } = await supabase
      .from('conversation_summaries')
      .select('*')
      .eq('conversation_id', conversationId)
      .single();

    if (summaryErr && summaryErr.code !== 'PGRST116') {
      console.error('Error fetching summary:', summaryErr);
    }

    if (!summary) {
      return res.json({
        conversationId,
        found: false,
        summary: null,
        relatedTickets: []
      });
    }

    // 2. Buscar tickets relacionados (Cruce Inteligente)
    // Construir query OR dinámicamente con los arrays (overlaps) e emails/telefonos
    const orConditions = [];
    
    if (summary.contact_email) {
      orConditions.push(`contact_email.eq."${summary.contact_email}"`);
    }
    if (summary.contact_phone) {
      orConditions.push(`contact_phone.eq."${summary.contact_phone}"`);
    }
    if (summary.extracted_imei?.length) {
      orConditions.push(`extracted_imei.ov.{${summary.extracted_imei.join(',')}}`);
    }
    if (summary.extracted_sim?.length) {
      orConditions.push(`extracted_sim.ov.{${summary.extracted_sim.join(',')}}`);
    }

    let relatedTickets = [];
    
    if (orConditions.length > 0) {
      const orQuery = orConditions.join(',');
      
      const { data: related, error: relatedErr } = await supabase
        .from('conversation_summaries')
        .select('*')
        .or(orQuery)
        .neq('conversation_id', conversationId) // Excluir la actual
        .order('updated_at', { ascending: false })
        .limit(10);
        
      if (!relatedErr && related) {
        relatedTickets = related;
      }
    }

    return res.json({
      conversationId,
      found: true,
      summary,
      relatedTickets
    });

  } catch (error) {
    console.error('Error in GET /summary:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

conversationsRouter.post('/:id/summary/generate', async (req, res) => {
  const conversationId = Number(req.params.id);
  if (!Number.isFinite(conversationId) || conversationId < 1) {
    return res.status(400).json({ error: 'ID inválido' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase no configurado' });
  }

  try {
    const creds = await resolveCredentials(supabase);
    const base = String(creds.chatwootBaseUrl || '').replace(/\/+$/, '');
    const token = creds.chatwootApiToken;
    const accountId = creds.chatwootAccountId || '1';

    if (!base || !token) {
      return res.status(503).json({ error: 'Chatwoot no configurado' });
    }

    const client = axios.create({
      baseURL: base,
      headers: {
        api_access_token: token,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    // 1. Obtener mensajes recientes
    const messages = await fetchConversationMessages(client, accountId, conversationId, 80);

    // 2. Obtener detalles del contacto
    let contactName = '';
    let contactEmail = '';
    let contactPhone = '';
    let contactId = null;

    try {
      const { data: convData } = await client.get(`/api/v1/accounts/${accountId}/conversations/${conversationId}`);
      const payload = convData?.payload || convData;
      contactId = payload?.contact_id ?? payload?.meta?.contact?.id;
      if (contactId) {
        const { data: contData } = await client.get(`/api/v1/accounts/${accountId}/contacts/${contactId}`);
        const c = contData?.payload || contData;
        contactName = c?.name || [c?.first_name, c?.last_name].filter(Boolean).join(' ') || '';
        contactEmail = c?.email || '';
        contactPhone = c?.phone_number || '';
      }
    } catch (e) {
      console.warn('Error al buscar contacto para resumen:', e.message);
    }

    // 3. Generar resumen con Gemini
    const result = await generateGeminiSummaryAndFacts(messages, contactName, creds);

    // 4. Guardar en Supabase
    const dbRow = {
      conversation_id: conversationId,
      contact_id: contactId || null,
      contact_name: result.contact_name || contactName || null,
      contact_email: result.contact_email || contactEmail || null,
      contact_phone: result.contact_phone || contactPhone || null,
      ai_summary: result.ai_summary,
      extracted_imei: result.extracted_imei || [],
      extracted_sim: result.extracted_sim || [],
      extracted_st_tickets: result.extracted_st_tickets || [],
      extracted_shopify_orders: result.extracted_shopify_orders || [],
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: summary, error: dbErr } = await supabase
      .from('conversation_summaries')
      .upsert(dbRow)
      .select()
      .single();

    if (dbErr) throw dbErr;

    // 5. Escribir en atributos personalizados de Chatwoot
    try {
      await client.put(`/api/v1/accounts/${accountId}/conversations/${conversationId}`, {
        custom_attributes: {
          gemini_summary: result.ai_summary,
          geminiSummary: result.ai_summary
        }
      });
    } catch (e) {
      console.warn('Error al actualizar atributos en Chatwoot:', e.message);
    }

    return res.json({
      success: true,
      conversationId,
      summary
    });

  } catch (error) {
    console.error('Error al generar resumen con Gemini:', error);
    return res.status(500).json({ error: error.message || 'Error interno del servidor' });
  }
});
