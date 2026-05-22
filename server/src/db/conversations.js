import { getDb } from './supabase.js';
import { writeSyncLog } from './sync_log.js';

export async function upsertConversation({
  chatwoot_conversation_id, chatwoot_inbox_id, channel_type,
  contact_id, status, assignee_name, labels, chatwoot_created_at,
}) {
  if (!chatwoot_conversation_id) return null;
  const db = getDb();
  const { data, error } = await db
    .from('conversations')
    .upsert(
      {
        chatwoot_conversation_id, chatwoot_inbox_id, channel_type,
        contact_id, status, assignee_name,
        labels: Array.isArray(labels) ? labels : [],
        chatwoot_created_at,
        synced_at: new Date().toISOString(),
      },
      { onConflict: 'chatwoot_conversation_id' }
    )
    .select('id')
    .single();

  if (error) {
    await writeSyncLog({ event_type: 'upsert_conversation', source: 'webhook', reference_id: chatwoot_conversation_id, status: 'error', error_message: error.message });
    return null;
  }
  return data;
}
