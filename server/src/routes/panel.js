import { Router } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

export const panelRouter = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = join(__dirname, '../public/panel.html');

panelRouter.get('/', (_req, res) => {
  const html = readFileSync(PANEL_HTML, 'utf8');

  const cwUrl      = (process.env.CHATWOOT_BASE_URL || '').replace(/\/+$/, '');
  const cwAccount  = process.env.CHATWOOT_ACCOUNT_ID || '';
  const shopifyUrl = process.env.SHOPIFY_API_URL
    ? process.env.SHOPIFY_API_URL.replace(/\/admin\/api.*/, '')
    : (process.env.SHOPIFY_STORE_URL ? `https://${process.env.SHOPIFY_STORE_URL}` : '');

  const config = `<script>var CW_URL="${cwUrl}",CW_ACCOUNT="${cwAccount}",SHOPIFY_URL="${shopifyUrl}";</script>`;
  const injected = html.replace('</head>', config + '\n</head>');
  res.type('html').send(injected);
});
