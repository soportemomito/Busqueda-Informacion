import { Router } from 'express';
import axios from 'axios';
import { getDb } from '../db/supabase.js';
import { writeSyncLog } from '../db/sync_log.js';
import { updateSignalStatusForMerge } from '../db/signals.js';

export const mergeRouter = Router();

mergeRouter.post('/', async (req, res) => {
  const { base_conversation_id, mergee_conversation_id, triggered_by } = req.body || {};

  const baseId = Number(base_conversation_id);
  const mergeeId = Number(mergee_conversation_id);
  if (!Number.isFinite(baseId) || baseId < 1 || !Number.isFinite(mergeeId) || mergeeId < 1) {
    return res.status(400).json({ success: false, error: 'base_conversation_id and mergee_conversation_id are required and must be positive integers' });
  }

  const baseUrl = (process.env.CHATWOOT_BASE_URL || '').replace(/\/+$/, '');
  const accountId = process.env.CHATWOOT_ACCOUNT_ID;
  const token = process.env.CHATWOOT_API_TOKEN;

  if (!baseUrl || !accountId || !token) {
    return res.status(500).json({ success: false, error: 'Chatwoot credentials not configured' });
  }

  try {
    // Call Chatwoot merge API
    await axios.post(
      `${baseUrl}/api/v1/accounts/${accountId}/conversations/merge`,
      { base_conversation_id: baseId, mergee_conversation_id: mergeeId },
      { headers: { api_access_token: token }, timeout: 10000 }
    );

    const db = getDb();
    const mergedAt = new Date().toISOString();

    await db.from('conversation_merges').insert({
      base_conversation_id: baseId,
      merged_conversation_id: mergeeId,
      triggered_by: triggered_by || 'panel',
      merged_at: mergedAt,
      chatwoot_merge_confirmed: true,
    });

    await db.from('conversations')
      .update({ is_merged: true, merged_into_conversation_id: baseId })
      .eq('chatwoot_conversation_id', mergeeId);

    await updateSignalStatusForMerge(baseId, mergeeId);

    await writeSyncLog({
      event_type: 'merge',
      source: 'panel',
      reference_id: `${baseId}:${mergeeId}`,
      status: 'success',
    });

    res.json({ success: true, merged_at: mergedAt });

  } catch (err) {
    console.error('[merge] error:', err);
    await writeSyncLog({
      event_type: 'merge',
      source: 'panel',
      reference_id: String(baseId),
      status: 'error',
      error_message: err.message,
    }).catch(() => {});
    res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});
