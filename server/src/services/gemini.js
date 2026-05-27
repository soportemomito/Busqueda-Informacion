import { extractEntities } from './extractor.js';

const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /(?:\+?56\s?)?9\d{8}/g;

function filterRelevantMessages(messages) {
  return (messages || []).filter((m) => {
    const type = m.message_type;
    const isCustomer     = type === 0 || type === '0' || type === 'incoming';
    const isInternalNote = m.private === true || type === 2 || type === '2' || type === 'activity';
    return isCustomer || isInternalNote;
  });
}

/**
 * Tries to fetch the AI summary Chatwoot generated via its own assistant.
 * Returns null if the endpoint is not available or AI is not configured.
 */
async function fetchChatwootAiSummary(client, accountId, conversationId) {
  try {
    const { data } = await client.get(
      `/api/v1/accounts/${accountId}/conversations/${conversationId}/summary`
    );
    return data?.summary || data?.ai_summary || null;
  } catch {
    return null;
  }
}

/**
 * Genera un resumen heurístico local, estructurado e inteligente a partir de los mensajes.
 * Corre 100% en local y de forma totalmente gratuita.
 */
export function generateLocalHeuristicSummary(messages) {
  const relevant = (messages || []).filter(
    (m) => m.content && (m.message_type === 0 || m.message_type === '0' || m.message_type === 'incoming' || m.sender_type === 'contact')
  );
  if (!relevant.length) return null;

  const imeis = new Set();
  const sims = new Set();
  const models = new Set();
  const fallas = new Set();
  const comunas = new Set();
  const ruts = new Set();

  for (const m of relevant) {
    const text = m.content || '';
    const entities = extractEntities(text);
    for (const e of entities) {
      if (e.entity_type === 'imei') imeis.add(e.normalized_value);
      if (e.entity_type === 'sim_id') sims.add(e.normalized_value);
      if (e.entity_type === 'device_model') models.add(e.normalized_value);
      if (e.entity_type === 'failure_keyword') fallas.add(e.normalized_value);
      if (e.entity_type === 'comuna') comunas.add(e.normalized_value);
      if (e.entity_type === 'rut') ruts.add(e.normalized_value);
    }
  }

  // Extraer un fragmento inicial del problema (primer mensaje del cliente)
  const firstMsg = relevant[0].content || '';
  const cleanFirst = firstMsg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const excerpt = cleanFirst.length > 130 ? cleanFirst.slice(0, 130) + '...' : cleanFirst;

  const parts = [];
  if (models.size > 0) parts.push(`Equipo: ${[...models].join(', ')}`);
  if (imeis.size > 0) parts.push(`IMEI: ${[...imeis].join(', ')}`);
  if (fallas.size > 0) parts.push(`Fallas: ${[...fallas].join(', ')}`);
  if (comunas.size > 0) parts.push(`Comuna: ${[...comunas].join(', ')}`);
  if (ruts.size > 0) parts.push(`RUT: ${[...ruts].join(', ')}`);

  const factsBlock = parts.length > 0 ? ` [${parts.join(' | ')}]` : '';
  return `Problema reportado: "${excerpt}"${factsBlock}`;
}

/**
 * Replaces Gemini: fetches Chatwoot's own AI summary and extracts entities
 * from customer messages and internal notes using regex.
 *
 * @param {Array}  messages     - Array of { content, message_type, private, sender_type }
 * @param {string} contactName  - Pre-known contact name (from Chatwoot contact record)
 * @param {object} _config      - Unused (kept for interface compatibility)
 * @param {object} chatwootMeta - { client, accountId, conversationId } for the Chatwoot API call
 */
export async function generateGeminiSummaryAndFacts(messages, contactName, _config, chatwootMeta) {
  // 1. Try Chatwoot's built-in AI summary
  let aiSummary = null;
  if (chatwootMeta) {
    const { client, accountId, conversationId } = chatwootMeta;
    aiSummary = await fetchChatwootAiSummary(client, accountId, conversationId);
  }

  // Fallback: Generar resumen heurístico local gratuito si no hay resumen oficial de Chatwoot
  if (!aiSummary) {
    aiSummary = generateLocalHeuristicSummary(messages);
  }

  // 2. Extract entities from customer messages and internal notes
  const relevant = filterRelevantMessages(messages);

  const emails   = new Set();
  const phones   = new Set();
  const imeis    = new Set();
  const sims     = new Set();
  const shopify  = new Set();
  const stOrders = new Set();
  const models   = new Set();
  const fallas   = new Set();
  const comunas  = new Set();
  const ruts     = new Set();

  for (const m of relevant) {
    const text = m.content || '';
    for (const e of (text.match(EMAIL_RE) || [])) emails.add(e.toLowerCase());
    for (const p of (text.match(PHONE_RE) || [])) phones.add(p);
    for (const entity of extractEntities(text)) {
      if (entity.entity_type === 'imei')            imeis.add(entity.normalized_value);
      if (entity.entity_type === 'sim_id')          sims.add(entity.normalized_value);
      if (entity.entity_type === 'shopify_order')   shopify.add(entity.normalized_value);
      if (entity.entity_type === 'service_order')   stOrders.add(entity.normalized_value);
      if (entity.entity_type === 'device_model')    models.add(entity.normalized_value);
      if (entity.entity_type === 'failure_keyword') fallas.add(entity.normalized_value);
      if (entity.entity_type === 'comuna')          comunas.add(entity.normalized_value);
      if (entity.entity_type === 'rut')             ruts.add(entity.normalized_value);
    }
  }

  return {
    ai_summary:               aiSummary,
    contact_name:             contactName || null,
    contact_email:            [...emails][0] || null,
    contact_phone:            [...phones][0] || null,
    extracted_imei:           [...imeis],
    extracted_sim:            [...sims],
    extracted_shopify_orders: [...shopify],
    extracted_st_tickets:     [...stOrders],
    extracted_device_models:  [...models],
    // Mantenemos fallas, comunas y ruts para expandir
    extracted_failures:       [...fallas],
    extracted_comunas:        [...comunas],
    extracted_ruts:           [...ruts],
  };
}
