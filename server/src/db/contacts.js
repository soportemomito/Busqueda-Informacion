import { getDb } from './supabase.js';
import { writeSyncLog } from './sync_log.js';

export async function upsertContact({ chatwoot_contact_id, name, email, phone_whatsapp }) {
  if (!chatwoot_contact_id) return null;
  const db = getDb();
  const { data, error } = await db
    .from('contacts')
    .upsert(
      { chatwoot_contact_id, name, email, phone_whatsapp, synced_at: new Date().toISOString() },
      { onConflict: 'chatwoot_contact_id' }
    )
    .select('id, chatwoot_contact_id, name, email, phone_whatsapp')
    .single();

  if (error) {
    await writeSyncLog({ event_type: 'upsert_contact', source: 'webhook', reference_id: chatwoot_contact_id, status: 'error', error_message: error.message });
    return null;
  }
  return data;
}

export async function findContact({ email, phone, name }) {
  const db = getDb();

  if (email) {
    const { data } = await db.from('contacts').select('*').ilike('email', email).limit(1).maybeSingle();
    if (data) return data;
  }
  if (phone) {
    const { data } = await db.from('contacts').select('*').eq('phone_whatsapp', phone).limit(1).maybeSingle();
    if (data) return data;
  }
  if (name) {
    const { data } = await db.from('contacts').select('*').ilike('name', `%${name}%`).limit(1).maybeSingle();
    if (data) return data;
  }
  return null;
}
