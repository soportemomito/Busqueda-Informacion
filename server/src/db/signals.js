import { getDb } from './supabase.js';

export async function getDuplicateSignals(chatwootConvIds) {
  if (!chatwootConvIds.length) return [];
  const db = getDb();

  const [resA, resB] = await Promise.all([
    db.from('duplicate_signals')
      .select('signal_type, signal_value, conversation_id_a, conversation_id_b, status')
      .eq('status', 'pending')
      .in('conversation_id_a', chatwootConvIds),
    db.from('duplicate_signals')
      .select('signal_type, signal_value, conversation_id_a, conversation_id_b, status')
      .eq('status', 'pending')
      .in('conversation_id_b', chatwootConvIds),
  ]);

  const seen = new Set();
  const results = [];
  for (const row of [...(resA.data || []), ...(resB.data || [])]) {
    const key = `${row.signal_type}:${row.conversation_id_a}:${row.conversation_id_b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(row);
  }
  return results;
}

export async function updateSignalStatusForMerge(baseConvId, mergeeConvId) {
  const db = getDb();
  const ids = [baseConvId, mergeeConvId];
  await Promise.all([
    db.from('duplicate_signals').update({ status: 'merged' }).in('conversation_id_a', ids),
    db.from('duplicate_signals').update({ status: 'merged' }).in('conversation_id_b', ids),
  ]);
}
