import { getDb } from './supabase.js';
import { writeSyncLog } from './sync_log.js';

export async function saveMessage({ chatwoot_message_id, conversation_id, content, message_type, sender_type }) {
  if (!chatwoot_message_id) return null;
  const db = getDb();
  const { data, error } = await db
    .from('messages')
    .upsert(
      { chatwoot_message_id, conversation_id, content, message_type, sender_type, processed_for_extraction: false },
      { onConflict: 'chatwoot_message_id' }
    )
    .select('id')
    .single();

  if (error) {
    await writeSyncLog({ event_type: 'save_message', source: 'webhook', reference_id: chatwoot_message_id, status: 'error', error_message: error.message });
    return null;
  }
  return data;
}

export async function markMessageProcessed(messageId) {
  const db = getDb();
  await db.from('messages').update({ processed_for_extraction: true }).eq('id', messageId);
}
