import axios from 'axios';

function makeClient() {
  const base = (process.env.CHATWOOT_BASE_URL || '').replace(/\/+$/, '');
  const token = process.env.CHATWOOT_API_TOKEN;
  const accountId = process.env.CHATWOOT_ACCOUNT_ID;
  if (!base || !token || !accountId) return null;
  return {
    http: axios.create({ baseURL: base, headers: { api_access_token: token }, timeout: 10000 }),
    accountId,
  };
}

function mapConversations(convs) {
  return (convs || []).map(c => ({
    chatwoot_conversation_id: c.id,
    channel_type: c.channel || c.meta?.channel || null,
    status: c.status || null,
    chatwoot_created_at: c.created_at
      ? new Date(typeof c.created_at === 'number' ? c.created_at * 1000 : c.created_at).toISOString()
      : null,
    assignee_name: c.meta?.assignee?.name || c.assignee?.name || null,
    labels: Array.isArray(c.labels) ? c.labels : [],
  }));
}

function mapContact(c) {
  return {
    chatwoot_contact_id: c.id,
    name: c.name || null,
    email: c.email || null,
    // Chatwoot stores WhatsApp/phone in phone_number
    phone_whatsapp: c.phone_number || null,
    // Additional identifiers that might be available
    additional_attributes: c.additional_attributes || {},
  };
}

/**
 * Given a conversation_id, fetches the FULL contact record from Chatwoot.
 * This gives all available identifiers regardless of the channel used.
 */
export async function getContactFromConversation(conversation_id) {
  const client = makeClient();
  if (!client) return null;
  const { http, accountId } = client;

  try {
    // 1. Get conversation to find contact_id
    const { data: conv } = await http.get(
      `/api/v1/accounts/${accountId}/conversations/${conversation_id}`
    );
    const contactId = conv?.meta?.sender?.id;
    if (!contactId) return null;

    // 2. Fetch full contact (has all channels data consolidated)
    const { data: contact } = await http.get(
      `/api/v1/accounts/${accountId}/contacts/${contactId}`
    );

    // 3. Fetch all conversations for this contact
    let conversations = [];
    try {
      const { data: cd } = await http.get(
        `/api/v1/accounts/${accountId}/contacts/${contactId}/conversations`
      );
      conversations = mapConversations(cd?.payload || []);
    } catch { /* no conversations */ }

    return { contact: mapContact(contact), conversations };
  } catch {
    return null;
  }
}

/**
 * Fetches all messages from a conversation.
 * Returns array of { content, message_type, sender_type }.
 */
export async function getConversationMessages(conversation_id) {
  const client = makeClient();
  if (!client) return [];
  const { http, accountId } = client;
  try {
    const { data } = await http.get(
      `/api/v1/accounts/${accountId}/conversations/${conversation_id}/messages`
    );
    // Chatwoot v3+ returns { payload: [...] } but some builds nest it as
    // { payload: { meta: {}, payload: [...] } } — handle both.
    const raw = data?.payload;
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.payload) ? raw.payload : []);
    return list.map(m => ({
      content: m.content || '',
      message_type: m.message_type,
      sender_type: m.sender_type,
      private: m.private ?? false,
    }));
  } catch {
    return [];
  }
}

/**
 * Search a contact in Chatwoot by email, phone or name (text search).
 * Used when no conversation_id is available (manual search).
 */
export async function searchContactInChatwoot({ email, phone, name }) {
  const client = makeClient();
  if (!client) return null;
  const { http, accountId } = client;

  const q = email || phone || name;
  if (!q) return null;

  try {
    const { data } = await http.get(`/api/v1/accounts/${accountId}/contacts/search`, {
      params: { q, include_contacts: true, page: 1 },
    });

    const contacts = data?.payload || [];
    if (!contacts.length) return null;

    // Fetch full contact for the best match
    let fullContact = contacts[0];
    try {
      const { data: fc } = await http.get(
        `/api/v1/accounts/${accountId}/contacts/${contacts[0].id}`
      );
      fullContact = fc;
    } catch { /* use partial data */ }

    let conversations = [];
    try {
      const { data: cd } = await http.get(
        `/api/v1/accounts/${accountId}/contacts/${fullContact.id}/conversations`
      );
      conversations = mapConversations(cd?.payload || []);
    } catch { /* no conversations */ }

    return { contact: mapContact(fullContact), conversations };
  } catch {
    return null;
  }
}
