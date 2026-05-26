import { Router } from 'express';
import { getSupabase } from '../lib/supabase.js';
import { resolveCredentials } from '../lib/resolveCredentials.js';

export const configRouter = Router();

function maskJson(s) {
  if (!s || !String(s).trim()) return '';
  return '•••• (JSON configurado)';
}

configRouter.get('/', async (req, res) => {
  try {
    const supabase = getSupabase();
    const creds = await resolveCredentials(supabase);

    res.json({
      chatwootBaseUrl: creds.chatwootBaseUrl,
      chatwootApiToken: creds.chatwootApiToken,
      chatwootAccountId: creds.chatwootAccountId || '1',
      bsaleApiToken: creds.bsaleApiToken,
      shopifyAdminApiUrl: creds.shopifyAdminApiBaseUrl || '',
      shopifyAccessToken: creds.shopifyAccessToken,
      shopifyWebhookSecret: creds.shopifyWebhookSecret ? '•••• (configurado)' : '',
      shopifyWebhookConfigured: Boolean(String(creds.shopifyWebhookSecret || '').trim()),
      driveParentFolderId: creds.driveParentFolderId || '',
      driveServiceAccountKey: creds.driveServiceAccountJson ? maskJson(creds.driveServiceAccountJson) : '',
      driveServiceAccountConfigured: Boolean(creds.driveServiceAccountJson?.trim()),
      supabaseAvailable: Boolean(supabase),
      fromDatabase: Boolean(supabase),
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Error leyendo configuración' });
  }
});

configRouter.put('/', async (req, res) => {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return res.status(503).json({
        error: 'Supabase no configurado. Define SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en server/.env',
      });
    }

    const {
      chatwootBaseUrl,
      chatwootApiToken,
      chatwootAccountId,
      bsaleApiToken,
      shopifyAdminApiUrl,
      shopifyAccessToken,
      shopifyWebhookSecret,
      driveParentFolderId,
      driveServiceAccountKey,
    } = req.body || {};

    const { data: existing } = await supabase.from('config').select('shopify_webhook_secret').eq('id', 1).maybeSingle();

    let webhookSecret = existing?.shopify_webhook_secret ?? null;
    if (shopifyWebhookSecret !== undefined) {
      const t = String(shopifyWebhookSecret || '').trim();
      if (t) webhookSecret = t;
    }

    const row = {
      id: 1,
      chatwoot_base_url: chatwootBaseUrl ?? null,
      chatwoot_api_token: chatwootApiToken ?? null,
      chatwoot_account_id: chatwootAccountId ?? null,
      bsale_api_token: bsaleApiToken ?? null,
      shopify_admin_api_url: shopifyAdminApiUrl ?? null,
      shopify_api_token: shopifyAccessToken ?? null,
      shopify_webhook_secret: webhookSecret,
      drive_parent_folder_id: driveParentFolderId ?? null,
      drive_service_account_key: driveServiceAccountKey ?? null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from('config').upsert(row).select().single();

    if (error) throw error;

    res.json({
      ok: true,
      config: {
        chatwootBaseUrl: data.chatwoot_base_url,
        chatwootApiToken: data.chatwoot_api_token,
        chatwootAccountId: data.chatwoot_account_id,
        bsaleApiToken: data.bsale_api_token,
        shopifyAdminApiUrl: data.shopify_admin_api_url,
        shopifyAccessToken: data.shopify_api_token,
        driveParentFolderId: data.drive_parent_folder_id,
        updatedAt: data.updated_at,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Error guardando configuración' });
  }
});
