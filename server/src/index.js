import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { searchRouter } from './routes/search.js';
import { configRouter } from './routes/config.js';
import { setupRouter } from './routes/setup.js';
import { chatwootActionsRouter } from './routes/chatwootActions.js';
import { webhookRouter } from './routes/webhook.js';
import { conversationsRouter } from './routes/conversations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '../../client/dist');

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors({ origin: true }));
// Guarda el body crudo para verificar firma HMAC en el webhook de Chatwoot
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'soymomo-st-system' });
});

app.use('/api/setup', setupRouter);
app.use('/api/search', searchRouter);
app.use('/api/chatwoot', chatwootActionsRouter);
app.use('/api/config', configRouter);
app.use('/api/webhook', webhookRouter);
app.use('/api/conversations', conversationsRouter);

// Sirve el cliente React buildado. En desarrollo no existe la carpeta, se ignora.
// Assets con hash (JS/CSS): cache largo. index.html: sin cache para ver cambios al instante.
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) next(); // en dev la carpeta no existe, no es error
  });
});

app.listen(PORT, () => {
  console.log(`SoyMomo ST System API http://localhost:${PORT}`);
});
