import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchConfig, fetchSetup, saveConfig } from '../api/client.js';

function Check({ ok, label }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={ok ? 'text-green-600' : 'text-red-600'} aria-hidden>
        {ok ? '✓' : '✗'}
      </span>
      <span className={ok ? 'text-momo-800' : 'text-momo-700'}>{label}</span>
    </div>
  );
}

export default function SettingsPage() {
  const qc = useQueryClient();
  const { data: setup, isLoading: setupLoading } = useQuery({
    queryKey: ['setup'],
    queryFn: fetchSetup,
    staleTime: 30_000,
  });

  const { data, isLoading: configLoading, error } = useQuery({
    queryKey: ['config'],
    queryFn: fetchConfig,
    enabled: Boolean(setup?.supabaseAvailable),
  });

  const [form, setForm] = useState({
    chatwootBaseUrl: '',
    chatwootApiToken: '',
    chatwootAccountId: '1',
    bsaleApiToken: '',
    shopifyAdminApiUrl: '',
    shopifyAccessToken: '',
    shopifyWebhookSecret: '',
    driveParentFolderId: '',
    driveServiceAccountKey: '',
  });

  useEffect(() => {
    if (!data) return;
    setForm({
      chatwootBaseUrl: data.chatwootBaseUrl || '',
      chatwootApiToken: data.chatwootApiToken || '',
      chatwootAccountId: data.chatwootAccountId || '1',
      bsaleApiToken: data.bsaleApiToken || '',
      shopifyAdminApiUrl: data.shopifyAdminApiUrl || '',
      shopifyAccessToken: data.shopifyAccessToken || '',
      shopifyWebhookSecret: '',
      driveParentFolderId: data.driveParentFolderId || '',
      driveServiceAccountKey: '',
    });
  }, [data]);

  const mutation = useMutation({
    mutationFn: () =>
      saveConfig({
        chatwootBaseUrl: form.chatwootBaseUrl,
        chatwootApiToken: form.chatwootApiToken,
        chatwootAccountId: form.chatwootAccountId,
        bsaleApiToken: form.bsaleApiToken,
        shopifyAdminApiUrl: form.shopifyAdminApiUrl || null,
        shopifyAccessToken: form.shopifyAccessToken || null,
        shopifyWebhookSecret: form.shopifyWebhookSecret.trim() || undefined,
        driveParentFolderId: form.driveParentFolderId || null,
        driveServiceAccountKey: form.driveServiceAccountKey.trim() || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config'] });
      qc.invalidateQueries({ queryKey: ['setup'] });
    },
  });

  const loading = setupLoading || (setup?.supabaseAvailable && configLoading);
  const cloudMode = Boolean(setup?.supabaseAvailable);

  return (
    <div className="max-w-xl mx-auto px-4 py-8">
      <h2 className="text-lg font-semibold text-momo-900 mb-1">Configuración</h2>

      {loading && <p className="text-sm text-momo-600 mb-4">Cargando…</p>}

      {setup && (
        <div className="mb-6 rounded-xl border border-momo-200 bg-white p-5 shadow-sm space-y-3">
          <h3 className="text-sm font-semibold text-momo-900">Estado en este servidor</h3>
          {!cloudMode && (
            <p className="text-xs text-momo-700 font-medium">
              Modo local: credenciales en <code className="text-momo-900">server/.env</code>.
            </p>
          )}
          <div className="space-y-1 pt-1">
            <Check ok={setup.chatwoot?.ready} label="Chatwoot" />
            <Check ok={setup.bsale?.ready} label="Bsale" />
            <Check ok={setup.shopify?.ready} label="Shopify" />
            <Check ok={setup.drive?.ready} label="Google Drive (opcional)" />
            {setup.shopify?.ready === false && setup.shopify?.hint && (
              <p className="text-xs text-momo-500 pl-6">{setup.shopify.hint}</p>
            )}
            {setup.drive?.ready === false && setup.drive?.hint && (
              <p className="text-xs text-momo-500 pl-6">{setup.drive.hint}</p>
            )}
          </div>
        </div>
      )}

      {!cloudMode && setup && (
        <div className="mb-6 rounded-xl border border-momo-200 bg-momo-50/80 p-4 text-xs text-momo-800 space-y-2">
          <p className="font-medium text-momo-900">Ejemplo server/.env</p>
          <pre className="whitespace-pre-wrap break-all rounded-lg bg-white border border-momo-200 p-3 text-[11px] leading-relaxed">
            {`CHATWOOT_BASE_URL=
CHATWOOT_API_TOKEN=
CHATWOOT_ACCOUNT_ID=1
BSALE_ACCESS_TOKEN=
BSALE_API_URL=https://api.bsale.io/v1
SHOPIFY_ACCESS_TOKEN=shpat_...
# Opcional: SHOPIFY_API_URL o SHOPIFY_STORE_URL; si no, tienda SoyMomo Chile por defecto
# SHOPIFY_SHOP_HOST=otra-tienda.myshopify.com
SHOPIFY_WEBHOOK_SECRET=
DRIVE_PARENT_FOLDER_ID=
DRIVE_SERVICE_ACCOUNT_KEY={"type":"service_account",...}`}
          </pre>
        </div>
      )}

      {error && cloudMode && (
        <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2">
          {error.message}
        </div>
      )}

      {cloudMode && (
        <div className="rounded-xl border border-momo-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-momo-900 mb-1">Credenciales en Supabase</h3>
          <p className="text-xs text-momo-600 mb-4">
            Ejecuta migraciones <code className="text-momo-800">002_config_extended.sql</code> y{' '}
            <code className="text-momo-800">003_shopify_config.sql</code> si falla el guardado.
          </p>

          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              mutation.mutate();
            }}
          >
            <div>
              <label htmlFor="chatwootBaseUrl" className="block text-xs font-medium text-momo-700 mb-1">Chatwoot Base URL</label>
              <input
                id="chatwootBaseUrl"
                name="chatwootBaseUrl"
                className="w-full rounded-lg border border-momo-200 px-3 py-2 text-sm"
                value={form.chatwootBaseUrl}
                onChange={(e) => setForm((f) => ({ ...f, chatwootBaseUrl: e.target.value }))}
              />
            </div>
            <div>
              <label htmlFor="chatwootApiToken" className="block text-xs font-medium text-momo-700 mb-1">Chatwoot API Token</label>
              <input
                id="chatwootApiToken"
                name="chatwootApiToken"
                type="password"
                className="w-full rounded-lg border border-momo-200 px-3 py-2 text-sm"
                value={form.chatwootApiToken}
                onChange={(e) => setForm((f) => ({ ...f, chatwootApiToken: e.target.value }))}
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="chatwootAccountId" className="block text-xs font-medium text-momo-700 mb-1">Chatwoot Account ID</label>
              <input
                id="chatwootAccountId"
                name="chatwootAccountId"
                className="w-full rounded-lg border border-momo-200 px-3 py-2 text-sm"
                value={form.chatwootAccountId}
                onChange={(e) => setForm((f) => ({ ...f, chatwootAccountId: e.target.value }))}
              />
            </div>
            <div>
              <label htmlFor="bsaleApiToken" className="block text-xs font-medium text-momo-700 mb-1">Bsale API Token</label>
              <input
                id="bsaleApiToken"
                name="bsaleApiToken"
                type="password"
                className="w-full rounded-lg border border-momo-200 px-3 py-2 text-sm"
                value={form.bsaleApiToken}
                onChange={(e) => setForm((f) => ({ ...f, bsaleApiToken: e.target.value }))}
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="shopifyAdminApiUrl" className="block text-xs font-medium text-momo-700 mb-1">Shopify — URL Admin API</label>
              <input
                id="shopifyAdminApiUrl"
                name="shopifyAdminApiUrl"
                className="w-full rounded-lg border border-momo-200 px-3 py-2 text-sm font-mono text-xs"
                value={form.shopifyAdminApiUrl}
                onChange={(e) => setForm((f) => ({ ...f, shopifyAdminApiUrl: e.target.value }))}
                placeholder="https://tienda.myshopify.com/admin/api/2025-10"
              />
            </div>
            <div>
              <label htmlFor="shopifyAccessToken" className="block text-xs font-medium text-momo-700 mb-1">Shopify — Access token (shpat_…)</label>
              <input
                id="shopifyAccessToken"
                name="shopifyAccessToken"
                type="password"
                className="w-full rounded-lg border border-momo-200 px-3 py-2 text-sm"
                value={form.shopifyAccessToken}
                onChange={(e) => setForm((f) => ({ ...f, shopifyAccessToken: e.target.value }))}
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="shopifyWebhookSecret" className="block text-xs font-medium text-momo-700 mb-1">Shopify — Webhook secret (opcional)</label>
              <input
                id="shopifyWebhookSecret"
                name="shopifyWebhookSecret"
                type="password"
                className="w-full rounded-lg border border-momo-200 px-3 py-2 text-sm"
                value={form.shopifyWebhookSecret}
                onChange={(e) => setForm((f) => ({ ...f, shopifyWebhookSecret: e.target.value }))}
                placeholder={
                  data?.shopifyWebhookConfigured
                    ? 'Dejar vacío para mantener; pegar nuevo valor para reemplazar'
                    : 'Para verificar webhooks (HMAC) cuando implementes el endpoint'
                }
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="driveParentFolderId" className="block text-xs font-medium text-momo-700 mb-1">Drive — ID carpeta padre</label>
              <input
                id="driveParentFolderId"
                name="driveParentFolderId"
                className="w-full rounded-lg border border-momo-200 px-3 py-2 text-sm font-mono text-xs"
                value={form.driveParentFolderId}
                onChange={(e) => setForm((f) => ({ ...f, driveParentFolderId: e.target.value }))}
                placeholder="DRIVE_PARENT_FOLDER_ID"
              />
            </div>
            <div>
              <label htmlFor="driveServiceAccountKey" className="block text-xs font-medium text-momo-700 mb-1">Drive — JSON cuenta de servicio</label>
              <textarea
                id="driveServiceAccountKey"
                name="driveServiceAccountKey"
                className="w-full rounded-lg border border-momo-200 px-3 py-2 text-xs font-mono min-h-[120px]"
                value={form.driveServiceAccountKey}
                onChange={(e) => setForm((f) => ({ ...f, driveServiceAccountKey: e.target.value }))}
                placeholder={
                  data?.driveServiceAccountConfigured
                    ? 'Dejar vacío para mantener el actual; pegar JSON completo para reemplazar'
                    : 'Pegar JSON de la service account'
                }
              />
            </div>

            {mutation.isError && (
              <p className="text-sm text-red-700">{mutation.error?.message || 'Error al guardar'}</p>
            )}
            {mutation.isSuccess && <p className="text-sm text-green-700">Guardado.</p>}

            <button
              type="submit"
              disabled={mutation.isPending}
              className="rounded-lg bg-momo-600 text-white text-sm font-medium px-4 py-2.5 hover:bg-momo-700 disabled:opacity-50"
            >
              {mutation.isPending ? 'Guardando…' : 'Guardar en Supabase'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
