import { Router } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const panelRouter = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = join(__dirname, '../public/panel.html');

panelRouter.get('/', (_req, res) => {
  res.sendFile(PANEL_HTML);
});
