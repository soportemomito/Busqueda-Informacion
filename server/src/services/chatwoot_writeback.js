import axios from 'axios';

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

/**
 * Sincroniza de vuelta a Chatwoot los atributos personalizados de contacto y conversación.
 * Totalmente gratis, utilizando la API REST nativa de Chatwoot.
 * 
 * @param {object} creds          - Credenciales obtenidas de Supabase (chatwootBaseUrl, chatwootApiToken)
 * @param {string|number} accountId - ID de la cuenta de Chatwoot (ej. 1)
 * @param {string|number} contactId - ID de contacto interno de Chatwoot
 * @param {string|number} conversationId - ID de conversación interno de Chatwoot
 * @param {object} attributes     - { rut, comuna, falla, resumen }
 */
export async function writeAttributesToChatwoot(creds, accountId, contactId, conversationId, attributes) {
  const base = normalizeBaseUrl(creds.chatwootBaseUrl);
  const token = creds.chatwootApiToken;

  if (!base || !token) {
    console.warn('[chatwoot_writeback] Saltando sincronización de vuelta: credenciales no configuradas');
    return;
  }

  const client = axios.create({
    baseURL: base,
    headers: {
      api_access_token: token,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });

  const contactAttrs = {};
  if (attributes.rut) contactAttrs.rut = attributes.rut;
  if (attributes.comuna) contactAttrs.comuna = attributes.comuna;
  if (attributes.direccion) contactAttrs.direccion = attributes.direccion;

  if (attributes.email) contactAttrs.correo_contacto = attributes.email;
  if (attributes.phone) contactAttrs.telefono_contacto = attributes.phone;

  const convAttrs = {};
  if (attributes.falla) convAttrs.tipo_falla = attributes.falla;
  if (attributes.resumen) convAttrs.resumen_heuristico = attributes.resumen;
  if (attributes.customer_sentiment) convAttrs.customer_sentiment = attributes.customer_sentiment;
  if (attributes.issue_complexity) convAttrs.issue_complexity = attributes.issue_complexity;

  const tasks = [];

  // 1. Actualizar atributos de contacto
  if (contactId && Object.keys(contactAttrs).length > 0) {
    const url = `/api/v1/accounts/${accountId}/contacts/${contactId}`;
    const payload = { custom_attributes: contactAttrs };
    
    tasks.push(
      client.put(url, payload)
        .then(() => console.log(`[chatwoot_writeback] Contacto #${contactId} actualizado con éxito:`))
        .catch((err) => console.error(`[chatwoot_writeback] Error actualizando contacto #${contactId}:`, err.message))
    );
  }

  // 2. Actualizar atributos de conversación
  if (conversationId && Object.keys(convAttrs).length > 0) {
    const url = `/api/v1/accounts/${accountId}/conversations/${conversationId}`;
    tasks.push(
      client.put(url, { custom_attributes: convAttrs })
        .then(() => console.log(`[chatwoot_writeback] Conversación #${conversationId} actualizada con éxito:`))
        .catch((err) => console.error(`[chatwoot_writeback] Error actualizando conversación #${conversationId}:`, err.message))
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
}
