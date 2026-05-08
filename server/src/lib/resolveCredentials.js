/**
 * Prioridad: valores en Supabase `config` (no vacíos) > variables de entorno.
 *
 * Bsale: BSALE_ACCESS_TOKEN o BSALE_API_TOKEN; base: BSALE_API_URL (si termina en /v1 se normaliza al host)
 *   o BSALE_API_BASE_URL.
 * Shopify: SHOPIFY_ACCESS_TOKEN (o SHOPIFY_API_TOKEN). URL Admin API: SHOPIFY_API_URL, o SHOPIFY_STORE_URL
 *   + SHOPIFY_API_VERSION, o por defecto la tienda SoyMomo Chile (override con SHOPIFY_SHOP_HOST).
 * Webhook: SHOPIFY_WEBHOOK_SECRET (solo si implementas endpoint de webhooks; no usado en /api/search).
 */
function stripTrailingSlashes(s) {
  return String(s || '').replace(/\/+$/, '');
}

/** Tienda por defecto de este despliegue. Cambiar con SHOPIFY_SHOP_HOST en .env si aplica otra tienda. */
const SHOPIFY_DEFAULT_SHOP_HOST = 'soymomo-chile.myshopify.com';

function normalizeBsaleBaseFromEnv() {
  const legacy = stripTrailingSlashes(process.env.BSALE_API_BASE_URL || '');
  const raw = stripTrailingSlashes(process.env.BSALE_API_URL || '');
  if (raw) {
    try {
      const u = new URL(raw);
      const path = (u.pathname || '').replace(/\/+$/, '') || '';
      if (path === '/v1' || path.endsWith('/v1')) {
        return u.origin;
      }
      if (!path || path === '/') return u.origin;
      return `${u.origin}${path}`;
    } catch {
      const stripped = raw.replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
      return stripped || legacy || 'https://api.bsale.app';
    }
  }
  if (legacy) return legacy;
  return 'https://api.bsale.app';
}

/**
 * Deja la base solo en https://tienda.myshopify.com/admin/api/YYYY-MM.
 * Evita 404 si en .env quedó …/shop.json, …/graphql.json o más segmentos.
 */
export function normalizeShopifyAdminApiBaseUrl(raw) {
  const s = stripTrailingSlashes(String(raw || '').trim().replace(/^\uFEFF/, ''));
  if (!s) return '';
  try {
    const u = new URL(s);
    let path = (u.pathname || '').replace(/\/+$/, '');
    path = path
      .replace(/\/shop\.json$/i, '')
      .replace(/\/graphql\.json$/i, '')
      .replace(/\/graphql$/i, '');
    const m = path.match(/^(\/admin\/api\/\d{4}-\d{2})(?:\/.*)?$/);
    if (m) return `${u.origin}${m[1]}`;
  } catch {
    /* URL no parseable; devolver tal cual */
  }
  return s;
}

function shopifyAdminBaseFromEnv() {
  const explicit = stripTrailingSlashes(process.env.SHOPIFY_API_URL || '');
  if (explicit) return explicit;
  const storeRaw = (process.env.SHOPIFY_STORE_URL || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  const ver = (process.env.SHOPIFY_API_VERSION || '2024-10').trim();
  if (storeRaw) return `https://${storeRaw}/admin/api/${ver}`;
  const host = (process.env.SHOPIFY_SHOP_HOST || SHOPIFY_DEFAULT_SHOP_HOST)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  return host ? `https://${host}/admin/api/${ver}` : '';
}

export async function resolveCredentials(supabase) {
  const fromEnv = {
    chatwootBaseUrl: process.env.CHATWOOT_BASE_URL || '',
    chatwootApiToken: process.env.CHATWOOT_API_TOKEN || '',
    chatwootAccountId: process.env.CHATWOOT_ACCOUNT_ID || '1',
    bsaleApiToken: (process.env.BSALE_ACCESS_TOKEN || process.env.BSALE_API_TOKEN || '').trim(),
    bsaleApiBaseUrl: normalizeBsaleBaseFromEnv(),
    driveParentFolderId: process.env.DRIVE_PARENT_FOLDER_ID || '',
    driveServiceAccountJson: process.env.DRIVE_SERVICE_ACCOUNT_KEY || '',
    shopifyAdminApiBaseUrl: normalizeShopifyAdminApiBaseUrl(shopifyAdminBaseFromEnv()),
    shopifyAccessToken: (process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_TOKEN || '').trim(),
    shopifyWebhookSecret: (process.env.SHOPIFY_WEBHOOK_SECRET || '').trim(),
  };

  if (!supabase) return fromEnv;

  const { data, error } = await supabase.from('config').select('*').eq('id', 1).maybeSingle();

  if (error || !data) return fromEnv;

  const pick = (dbVal, envVal) => {
    if (dbVal === null || dbVal === undefined) return envVal;
    const s = String(dbVal).trim();
    return s.length ? s : envVal;
  };

  const accountPick = pick(data.chatwoot_account_id, fromEnv.chatwootAccountId);

  return {
    chatwootBaseUrl: pick(data.chatwoot_base_url, fromEnv.chatwootBaseUrl),
    chatwootApiToken: pick(data.chatwoot_api_token, fromEnv.chatwootApiToken),
    chatwootAccountId: accountPick ? String(accountPick) : fromEnv.chatwootAccountId,
    bsaleApiToken: pick(data.bsale_api_token, fromEnv.bsaleApiToken),
    bsaleApiBaseUrl: fromEnv.bsaleApiBaseUrl,
    driveParentFolderId: pick(data.drive_parent_folder_id, fromEnv.driveParentFolderId),
    driveServiceAccountJson: pick(data.drive_service_account_key, fromEnv.driveServiceAccountJson),
    shopifyAdminApiBaseUrl: normalizeShopifyAdminApiBaseUrl(
      pick(data.shopify_admin_api_url, fromEnv.shopifyAdminApiBaseUrl),
    ),
    shopifyAccessToken: pick(data.shopify_api_token, fromEnv.shopifyAccessToken),
    shopifyWebhookSecret: pick(data.shopify_webhook_secret, fromEnv.shopifyWebhookSecret),
  };
}
