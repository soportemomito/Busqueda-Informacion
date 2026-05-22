import { Router } from 'express';
import { getDb } from '../db/supabase.js';
import { syncServiceOrdersFromSheet } from '../services/sheets_sync.js';

export const syncRouter = Router();

syncRouter.post('/service-orders', async (req, res) => {
  try {
    const result = await syncServiceOrdersFromSheet(getDb());
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[sync] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
