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
    channel_type: c.channel || c.meta?.channel || c.inbox_id || null,
    status: c.status || null,
    chatwoot_created_at: c.created_at
      ? new Date(typeof c.created_at === 'number' ? c.created_at * 1000 : c.created_at).toISOString()
      : null,
    assignee_name: c.meta?.assignee?.name || c.assignee?.name || null,
    labels: Array.isArray(c.labels) ? c.labels : [],
  }));
}

/**
 * Search a contact in Chatwoot by email, phone, name or conversation_id.
 * Returns { contact, conversations } or null.
 */
export async function searchContactInChatwoot({ email, phone, name, conversation_id }) {
  const client = makeClient();
  if (!client) return null;
  const { http, accountId } = client;

  try {
    // Via conversation_id: fetch the conversation and extract sender
    if (conversation_id) {
      const { data: conv } = await http.get(
        `/api/v1/accounts/${accountId}/conversations/${conversation_id}`
      );
      const sender = conv?.meta?.sender || conv?.sender || {};
      if (sender.id) {
        let conversations = [];
        try {
          const { data: cd } = await http.get(
            `/api/v1/accounts/${accountId}/contacts/${sender.id}/conversations`
          );
          conversations = mapConversations(cd?.payload || []);
        } catch { /* no conversations */ }

        return {
          contact: {
            chatwoot_contact_id: sender.id,
            name: sender.name || null,
            email: sender.email || null,
            phone_whatsapp: sender.phone_number || null,
          },
          conversations,
        };
      }
    }

    // Search by text query
    const q = email || phone || name;
    if (!q) return null;

    const { data } = await http.get(`/api/v1/accounts/${accountId}/contacts/search`, {
      params: { q, include_contacts: true, page: 1 },
    });

    const contacts = data?.payload || [];
    if (!contacts.length) return null;

    const contact = contacts[0];
    let conversations = [];
    try {
      const { data: cd } = await http.get(
        `/api/v1/accounts/${accountId}/contacts/${contact.id}/conversations`
      );
      conversations = mapConversations(cd?.payload || []);
    } catch { /* no conversations */ }

    return {
      contact: {
        chatwoot_contact_id: contact.id,
        name: contact.name || null,
        email: contact.email || null,
        phone_whatsapp: contact.phone_number || null,
      },
      conversations,
    };
  } catch {
    return null;
  }
}
