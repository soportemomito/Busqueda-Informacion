import { Router } from 'express';
import { getSupabase } from '../lib/supabase.js';
import { resolveCredentials } from '../lib/resolveCredentials.js';

export const setupRouter = Router();

function tailHint(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (s.length <= 4) return '••••';
  return `••••${s.slice(-4)}`;
}

setupRouter.get('/', async (req, res) => {
  try {
    const supabase = getSupabase();
    const creds = await resolveCredentials(supabase);

    const chatwootReady = Boolean(creds.chatwootBaseUrl && creds.chatwootApiToken);
    const bsaleReady = Boolean(creds.bsaleApiToken);
    const shopifyReady = Boolean(creds.shopifyAccessToken);
    const driveReady = Boolean(creds.driveParentFolderId && creds.driveServiceAccountJson);

    res.json({
      supabaseAvailable: Boolean(supabase),
      mode: supabase ? 'supabase_merged' : 'local_env',
      chatwoot: {
        ready: chatwootReady,
        baseUrl: creds.chatwootBaseUrl || null,
        accountId: String(creds.chatwootAccountId || '1'),
        tokenHint: tailHint(creds.chatwootApiToken),
        hint: chatwootReady
          ? null
          : 'Define CHATWOOT_BASE_URL y CHATWOOT_API_TOKEN en server/.env y reinicia el servidor.',
      },
      bsale: {
        ready: bsaleReady,
        baseUrl: creds.bsaleApiBaseUrl || 'https://api.bsale.app',
        tokenHint: tailHint(creds.bsaleApiToken),
        hint: bsaleReady
          ? null
          : 'Define BSALE_ACCESS_TOKEN (o BSALE_API_TOKEN) y BSALE_API_URL o BSALE_API_BASE_URL en server/.env.',
      },
      shopify: {
        ready: shopifyReady,
        adminApiBase: creds.shopifyAdminApiBaseUrl || null,
        tokenHint: tailHint(creds.shopifyAccessToken),
        webhookConfigured: Boolean(String(creds.shopifyWebhookSecret || '').trim()),
        hint: shopifyReady
          ? null
          : 'Define SHOPIFY_ACCESS_TOKEN en server/.env. Si no pones SHOPIFY_API_URL ni SHOPIFY_STORE_URL, se usa la tienda SoyMomo Chile por defecto (cambia con SHOPIFY_SHOP_HOST). SHOPIFY_WEBHOOK_SECRET solo para webhooks.',
      },
      drive: {
        ready: driveReady,
        folderConfigured: Boolean(creds.driveParentFolderId),
        serviceAccountConfigured: Boolean(creds.driveServiceAccountJson),
        hint: driveReady
          ? null
          : 'Opcional: DRIVE_PARENT_FOLDER_ID y DRIVE_SERVICE_ACCOUNT_KEY (JSON) para evidencias ST en Drive.',
      },
      localEnvHelp: {
        file: 'server/.env',
        restart: 'Detén y vuelve a ejecutar npm run dev (o el proceso del servidor) tras cambiar .env.',
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Error en /api/setup' });
  }
});
