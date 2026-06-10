import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { configRouter } from './routes/config.js';
import { setupRouter } from './routes/setup.js';
import { chatwootActionsRouter } from './routes/chatwootActions.js';
import { webhookRouter } from './routes/webhook.js';
import { conversationsRouter } from './routes/conversations.js';
import { aiSyncRouter } from './routes/aiSync.js';
import { healthRouter } from './routes/health.js';
import { panelWebhookRouter } from './routes/webhook_panel.js';
import { mergeRouter } from './routes/merge.js';
import { syncRouter } from './routes/sync.js';
import { getDb } from './db/supabase.js';
import { syncServiceOrdersFromSheet } from './services/sheets_sync.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors({ origin: true }));
// Guarda el body crudo para verificar firma HMAC en el webhook de Chatwoot
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Servicio solo-backend: sin web. La ficha se entrega como nota de contacto en
// Chatwoot a través del webhook (/api/webhook/chatwoot).
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'soymomo-st-system', mode: 'backend-only (notas Chatwoot)' });
});
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'soymomo-st-system' });
});

app.use('/health', healthRouter);
app.use('/webhook', panelWebhookRouter);
app.use('/merge', mergeRouter);
app.use('/sync', syncRouter);

app.use('/api/setup', setupRouter);
app.use('/api/chatwoot', chatwootActionsRouter);
app.use('/api/config', configRouter);
app.use('/api/webhook', webhookRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/force-sync', aiSyncRouter);

app.listen(PORT, () => {
  console.log(`SoyMomo ST System API http://localhost:${PORT}`);
});

// ─── Auto-sync de órdenes ST desde Google Sheets ──────────────────────────────
// Sin esto las hojas "Entradas", "Entrada recepción" y "Salida" quedan
// desactualizadas y la ficha no encuentra los informes (caso ticket 14890 / OS 5283).
// Intervalo configurable con SHEETS_SYNC_INTERVAL_MIN (0 = desactivado).
const SYNC_INTERVAL_MIN = process.env.SHEETS_SYNC_INTERVAL_MIN != null
  ? Number(process.env.SHEETS_SYNC_INTERVAL_MIN)
  : 30;

if (SYNC_INTERVAL_MIN > 0) {
  let syncing = false;
  const runSheetSync = async (reason) => {
    if (syncing) return;
    syncing = true;
    try {
      const result = await syncServiceOrdersFromSheet(getDb());
      console.log(`[sheets_sync] (${reason}) ${result.synced} órdenes sincronizadas`);
    } catch (err) {
      console.error(`[sheets_sync] (${reason}) error:`, err.message);
    } finally {
      syncing = false;
    }
  };

  setTimeout(() => runSheetSync('arranque'), 10_000);
  setInterval(() => runSheetSync('programado'), SYNC_INTERVAL_MIN * 60_000);
  console.log(`[sheets_sync] Auto-sync activado cada ${SYNC_INTERVAL_MIN} min`);
}
