import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function getSupabase() {
  if (!url || !key) return null;
  return createClient(url, key);
}

const IDENTIFIER_LABELS = new Set(['ID / IMEI', 'ICCID / SIM', 'Serial', 'Email', 'Teléfono', 'Pedido Shopify']);

/**
 * Guarda los device facts extraídos de una búsqueda.
 * @param {import('@supabase/supabase-js').SupabaseClient|null} supabase
 * @param {{ label: string, value: string, conversationId?: number, contactId?: number }[]} facts
 */
export async function upsertDeviceFacts(supabase, facts) {
  if (!supabase || !facts?.length) return;
  const rows = facts
    .filter((f) => f.conversationId != null && f.label && f.value)
    .map((f) => ({
      conversation_id: f.conversationId,
      contact_id: f.contactId ?? null,
      label: f.label,
      value: f.value,
    }));
  if (!rows.length) return;
  await supabase
    .from('device_facts')
    .upsert(rows, { onConflict: 'conversation_id,label,value', ignoreDuplicates: true });
}

/**
 * Busca otros tickets que compartan los mismos identificadores de dispositivo.
 * Solo cruza por labels únicos: IMEI, ICCID/SIM, Serial.
 * @param {import('@supabase/supabase-js').SupabaseClient|null} supabase
 * @param {{ label: string, value: string, conversationId?: number }[]} facts
 * @param {number[]} excludeConversationIds IDs de la búsqueda actual (para no devolver los mismos)
 * @returns {Promise<{ conversationId: number, contactId: number|null, label: string, value: string }[]>}
 */
export async function lookupRelatedByDevice(supabase, facts, excludeConversationIds = []) {
  if (!supabase || !facts?.length) return [];
  const identifiers = facts.filter((f) => IDENTIFIER_LABELS.has(f.label));
  if (!identifiers.length) return [];

  const excludeSet = new Set(excludeConversationIds);
  const results = [];
  const seen = new Set();

  for (const { label, value } of identifiers) {
    const { data } = await supabase
      .from('device_facts')
      .select('conversation_id, contact_id, label, value')
      .eq('label', label)
      .eq('value', value);
    for (const row of data || []) {
      if (excludeSet.has(row.conversation_id)) continue;
      const k = `${row.conversation_id}:${row.label}:${row.value}`;
      if (seen.has(k)) continue;
      seen.add(k);
      results.push({
        conversationId: row.conversation_id,
        contactId: row.contact_id,
        label: row.label,
        value: row.value,
      });
    }
  }
  return results;
}
