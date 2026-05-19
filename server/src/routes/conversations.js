import { Router } from 'express';
import { getSupabase } from '../lib/supabase.js';

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
      orConditions.push(`extracted_imei.cs.{${summary.extracted_imei.join(',')}}`);
      orConditions.push(`extracted_imei.cd.{${summary.extracted_imei.join(',')}}`); // overlap (&&) behavior in postgrest
    }
    if (summary.extracted_sim?.length) {
      orConditions.push(`extracted_sim.cs.{${summary.extracted_sim.join(',')}}`);
      orConditions.push(`extracted_sim.cd.{${summary.extracted_sim.join(',')}}`);
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
