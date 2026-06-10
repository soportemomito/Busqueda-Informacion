import { Router } from 'express';
import axios from 'axios';
import { getSupabase } from '../lib/supabase.js';
import { resolveCredentials } from '../lib/resolveCredentials.js';
import { upsertContactFichaNote } from '../services/ficha.js';

export const chatwootActionsRouter = Router();

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

/**
 * Marca una conversación como resuelta (útil cuando hay varias abiertas para el mismo contacto).
 * POST /api/chatwoot/conversations/resolve  { "conversationId": 123 }
 */
chatwootActionsRouter.post('/conversations/resolve', async (req, res) => {
  const conversationId = Number(req.body?.conversationId);
  if (!Number.isFinite(conversationId) || conversationId < 1) {
    return res.status(400).json({ error: 'conversationId inválido' });
  }

  try {
    const supabase = getSupabase();
    const creds = await resolveCredentials(supabase);
    const base = normalizeBaseUrl(creds.chatwootBaseUrl);
    const token = creds.chatwootApiToken;
    const accountId = String(creds.chatwootAccountId || '1');

    if (!base || !token) {
      return res.status(503).json({ error: 'Chatwoot no configurado (CHATWOOT_BASE_URL / CHATWOOT_API_TOKEN)' });
    }

    const url = `${base}/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`;
    await axios.post(
      url,
      { status: 'resolved' },
      {
        headers: {
          api_access_token: token,
          'Content-Type': 'application/json',
        },
        timeout: 25000,
      },
    );

    res.json({ ok: true, conversationId });
  } catch (e) {
    const status = e.response?.status;
    const d = e.response?.data;
    const msg =
      typeof d === 'string'
        ? d
        : d?.error || d?.message || (typeof d === 'object' ? JSON.stringify(d).slice(0, 400) : e.message);
    res.status(status && status >= 400 ? status : 500).json({
      error: `Chatwoot: ${msg || e.message}`,
    });
  }
});

/**
 * Crea una nota interna en una conversación.
 * POST /api/chatwoot/conversations/:id/notes  { "content": "..." }
 */
chatwootActionsRouter.post('/conversations/:id/notes', async (req, res) => {
  const conversationId = Number(req.params.id);
  const content = req.body?.content;

  if (!Number.isFinite(conversationId) || conversationId < 1) {
    return res.status(400).json({ error: 'conversationId inválido' });
  }
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'El contenido de la nota no puede estar vacío.' });
  }

  try {
    const supabase = getSupabase();
    const creds = await resolveCredentials(supabase);
    const base = normalizeBaseUrl(creds.chatwootBaseUrl);
    const token = creds.chatwootApiToken;
    const accountId = String(creds.chatwootAccountId || '1');

    if (!base || !token) {
      return res.status(503).json({ error: 'Chatwoot no configurado (CHATWOOT_BASE_URL / CHATWOOT_API_TOKEN)' });
    }

    const url = `${base}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
    const { data } = await axios.post(
      url,
      {
        content: content.trim(),
        private: true, // Esto la hace nota interna (privada)
        message_type: 'outgoing'
      },
      {
        headers: {
          api_access_token: token,
          'Content-Type': 'application/json',
        },
        timeout: 25000,
      },
    );

    res.json({ ok: true, data });
  } catch (e) {
    const status = e.response?.status;
    const d = e.response?.data;
    const msg = typeof d === 'string' ? d : d?.error || d?.message || e.message;
    res.status(status && status >= 400 ? status : 500).json({
      error: `Chatwoot: ${msg}`,
    });
  }
});

/**
 * Re-sincroniza la ficha consolidada almacenada en client_profiles como
 * nota de contacto en Chatwoot. Útil para forzar la sincronización sin
 * esperar una nueva búsqueda o mensaje.
 * POST /api/chatwoot/contacts/:contactId/ficha
 */
chatwootActionsRouter.post('/contacts/:contactId/ficha', async (req, res) => {
  const contactId = Number(req.params.contactId);
  if (!Number.isFinite(contactId) || contactId < 1) {
    return res.status(400).json({ error: 'contactId inválido' });
  }

  try {
    const supabase = getSupabase();
    const creds = await resolveCredentials(supabase);
    const accountId = String(creds.chatwootAccountId || '1');

    if (!creds.chatwootBaseUrl || !creds.chatwootApiToken) {
      return res.status(503).json({ error: 'Chatwoot no configurado (CHATWOOT_BASE_URL / CHATWOOT_API_TOKEN)' });
    }
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase no configurado' });
    }

    const { data: profile } = await supabase
      .from('client_profiles')
      .select('ficha_markdown')
      .eq('chatwoot_contact_id', contactId)
      .maybeSingle();

    if (!profile?.ficha_markdown) {
      return res.status(404).json({
        error: 'No hay ficha almacenada para este contacto. Abre el ticket en el panel para generarla.',
      });
    }

    const result = await upsertContactFichaNote(creds, accountId, contactId, profile.ficha_markdown);
    await supabase
      .from('client_profiles')
      .update({ ficha_synced_at: new Date().toISOString() })
      .eq('chatwoot_contact_id', contactId);

    res.json({ ok: true, contactId, result });
  } catch (e) {
    const status = e.response?.status;
    const d = e.response?.data;
    const msg = typeof d === 'string' ? d : d?.error || d?.message || e.message;
    res.status(status && status >= 400 ? status : 500).json({ error: `Chatwoot: ${msg}` });
  }
});

/**
 * Actualiza o añade etiquetas a una conversación.
 * POST /api/chatwoot/conversations/:id/labels  { "labels": ["st"] }
 */
chatwootActionsRouter.post('/conversations/:id/labels', async (req, res) => {
  const conversationId = Number(req.params.id);
  const labels = req.body?.labels;

  if (!Number.isFinite(conversationId) || conversationId < 1) {
    return res.status(400).json({ error: 'conversationId inválido' });
  }
  if (!Array.isArray(labels)) {
    return res.status(400).json({ error: 'labels debe ser un arreglo de strings.' });
  }

  try {
    const supabase = getSupabase();
    const creds = await resolveCredentials(supabase);
    const base = normalizeBaseUrl(creds.chatwootBaseUrl);
    const token = creds.chatwootApiToken;
    const accountId = String(creds.chatwootAccountId || '1');

    if (!base || !token) {
      return res.status(503).json({ error: 'Chatwoot no configurado (CHATWOOT_BASE_URL / CHATWOOT_API_TOKEN)' });
    }

    const url = `${base}/api/v1/accounts/${accountId}/conversations/${conversationId}/labels`;
    const { data } = await axios.post(
      url,
      { labels },
      {
        headers: {
          api_access_token: token,
          'Content-Type': 'application/json',
        },
        timeout: 25000,
      },
    );

    res.json({ ok: true, labels: data?.payload || data });
  } catch (e) {
    const status = e.response?.status;
    const d = e.response?.data;
    const msg = typeof d === 'string' ? d : d?.error || d?.message || e.message;
    res.status(status && status >= 400 ? status : 500).json({
      error: `Chatwoot: ${msg}`,
    });
  }
});
