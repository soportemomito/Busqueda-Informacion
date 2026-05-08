import { Router } from 'express';
import axios from 'axios';
import { getSupabase } from '../lib/supabase.js';
import { resolveCredentials } from '../lib/resolveCredentials.js';

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
