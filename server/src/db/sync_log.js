import { getDb } from './supabase.js';

export async function writeSyncLog({ event_type, source, reference_id, status, error_message }) {
  try {
    const db = getDb();
    await db.from('sync_log').insert({
      event_type,
      source,
      reference_id: String(reference_id ?? ''),
      status,
      error_message: error_message || null,
    });
  } catch {
    // sync_log failures must never crash the caller
  }
}
