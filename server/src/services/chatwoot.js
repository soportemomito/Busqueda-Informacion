import axios from 'axios';
import { extractDeviceFactsFromText } from '../lib/extractDeviceFacts.js';
import { nameMatchesStrictTokens, strictNameQueryTokens } from '../lib/nameMatch.js';

function chatwootHttpError(prefix, err) {
  if (err.response) {
    const d = err.response.data;
    const body =
      typeof d === 'string'
        ? d
        : d?.error || d?.message || (typeof d === 'object' ? JSON.stringify(d).slice(0, 280) : String(d));
    return new Error(`${prefix}: HTTP ${err.response.status} — ${body}`);
  }
  if (err.code === 'ECONNABORTED') return new Error(`${prefix}: tiempo de espera agotado`);
  return new Error(`${prefix}: ${err.message}`);
}

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function hasStLabel(labels) {
  if (!Array.isArray(labels)) return false;
  return labels.some((l) => {
    const t = String(l?.title || l?.name || '')
      .toLowerCase()
      .trim();
    return t === 'st';
  });
}

function extractGeminiSummary(customAttributes) {
  if (!customAttributes || typeof customAttributes !== 'object') return null;
  const keys = [
    'gemini_summary',
    'geminiSummary',
    'ai_summary',
    'summary',
    'resumen_gemini',
    'conversation_summary',
    'ai_conversation_summary',
    'copilot_summary',
  ];
  for (const k of keys) {
    const v = customAttributes[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

const ST_CONTEXT_RE = /ST|servicio\s*t[eé]cnico/i;
const ORDER_TOKEN_RE = /[PES]-?\d+/gi;
const EMAIL_IN_MSG_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const SHOPIFY_ORDER_IN_MSG_RE = /\b[A-Za-z]{1,4}#\d{3,8}\b/g;

function extractStOrdersFromText(text) {
  if (!text || typeof text !== 'string') return [];
  if (!ST_CONTEXT_RE.test(text)) return [];
  const raw = text.match(new RegExp(ORDER_TOKEN_RE.source, 'gi')) || [];
  return [...new Set(raw.map((x) => x.toUpperCase().replace(/\s/g, '')))];
}

function messagePlainText(m) {
  if (!m) return '';
  if (typeof m.content === 'string' && m.content.trim()) return m.content;
  if (typeof m.processed_message_content === 'string') return m.processed_message_content;
  if (Array.isArray(m.content_attributes?.items)) {
    return m.content_attributes.items.map((i) => i.title || i.description || '').join(' ');
  }
  return '';
}

function dedupeFactRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    if (!r?.label || !r?.value) continue;
    const k = `${r.label}:${String(r.value).toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ label: r.label, value: r.value });
  }
  return out;
}

function mapConversation(c) {
  const labels = c.labels || [];
  const assignee = c.meta?.assignee || c.assignee;
  const agentName = assignee
    ? [assignee.name, assignee.available_name].filter(Boolean).join(' ') || assignee.email
    : null;
  const inboxName = c.meta?.channel || c.inbox?.name || c.channel || null;

  return {
    ticketId: c.display_id ?? c.id,
    conversationId: c.id,
    channel: inboxName,
    agent: agentName,
    date: c.updated_at || c.created_at || null,
    status: c.status,
    isOpen: c.status === 'open' || c.status === 'pending',
    geminiSummary: extractGeminiSummary(c.custom_attributes),
    labels: labels.map((l) => l.title || l.name).filter(Boolean),
    stTagged: hasStLabel(labels),
    raw: c,
  };
}

async function fetchConversationDetail(client, accountId, id) {
  const { data } = await client.get(`/api/v1/accounts/${accountId}/conversations/${id}`);
  return data?.payload || data;
}

async function fetchContactSearch(client, accountId, q) {
  const searchUrl = `/api/v1/accounts/${accountId}/contacts/search`;
  const res = await client.get(searchUrl, { params: { q } });
  const searchData = res.data;
  const payload = searchData?.payload;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.contacts)) return payload.contacts;
  if (Array.isArray(searchData?.data)) return searchData.data;
  return [];
}

async function fetchConversationMessages(client, accountId, conversationId, limit = 80) {
  try {
    const { data } = await client.get(`/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
      params: { limit },
    });
    const payload = data?.payload;
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(data?.data?.payload)) return data.data.payload;
    if (Array.isArray(data?.data)) return data.data;
    return [];
  } catch {
    return [];
  }
}

export async function searchChatwoot(plan, creds) {
  const base = normalizeBaseUrl(creds.chatwootBaseUrl);
  const token = creds.chatwootApiToken;
  const accountId = creds.chatwootAccountId || '1';

  if (!base || !token) {
    throw new Error('Chatwoot: falta base URL o API token (configura en /settings o .env)');
  }

  if (plan.type === 'empty') {
    return {
      contacts: [],
      servicioTecnico: [],
      chatwoot: [],
      stOrdersFromMessages: [],
      emailsFromContacts: [],
      emailsFromMessages: [],
      shopifyOrdersFromMessages: [],
      contactCount: 0,
      conversationCount: 0,
      openConversationsCount: 0,
      messagesAnalyzed: 0,
    };
  }

  const client = axios.create({
    baseURL: base,
    headers: {
      api_access_token: token,
      'Content-Type': 'application/json',
    },
    timeout: 35000,
  });

  if (plan.type === 'orderNumber') {
    // Incluir SM#38293 (formato Shopify), #SM38293, SM38293 y solo los dígitos
    const terms = [...new Set([
      ...(plan.shopifyNamesToTry || [plan.orderNumber, plan.orderRaw]),
      plan.digits,
    ].filter(Boolean))];
    const convMap = new Map();
    const contactById = new Map();

    for (const term of terms) {
      try {
        const { data } = await client.get(`/api/v1/accounts/${accountId}/search`, {
          params: { q: term, page: 1 },
        });
        const payload = data?.payload || data?.data || {};

        // Los mensajes pueden tener conv como objeto (msg.conversation) o solo ID (msg.conversation_id)
        for (const msg of payload.messages || []) {
          const conv = msg.conversation;
          const convId = conv?.id ?? msg.conversation_id;
          if (convId && !convMap.has(convId)) convMap.set(convId, conv ?? { id: convId });
          // Capturar sender como contacto
          if (msg.sender?.id) contactById.set(msg.sender.id, msg.sender);
        }
        for (const conv of payload.conversations || []) {
          if (conv?.id && !convMap.has(conv.id)) convMap.set(conv.id, conv);
        }
        for (const c of payload.contacts || []) {
          if (c?.id) contactById.set(c.id, c);
        }
        if (convMap.size) break;
      } catch { /* search endpoint no disponible */ }
    }

    if (!convMap.size && !contactById.size) {
      return {
        contacts: [], servicioTecnico: [], chatwoot: [], allConversations: [],
        stOrdersFromMessages: [], contactCount: 0, conversationCount: 0,
        openConversationsCount: 0, messagesAnalyzed: 0, emailsFromContacts: [],
        strictNameNote: null,
      };
    }

    for (const conv of [...convMap.values()].slice(0, 15)) {
      try {
        const full = await fetchConversationDetail(client, accountId, conv.id);
        if (full?.id) convMap.set(full.id, { ...conv, ...full });
      } catch { /* usar parcial */ }
    }

    const openIds = new Set();
    const stOrdersFromMessages = new Set();
    const emailsFromMessages = new Set();
    const shopifyOrdersFromMessages = new Set();
    const convDeviceFacts = new Map();
    let messagesAnalyzed = 0;

    for (const conv of [...convMap.values()].slice(0, 10)) {
      if (conv.status === 'open' || conv.status === 'pending') openIds.add(conv.id);
      const msgs = await fetchConversationMessages(client, accountId, conv.id);
      messagesAnalyzed += msgs.length;
      const chunk = msgs.map(messagePlainText).join('\n');
      for (const ord of extractStOrdersFromText(chunk)) stOrdersFromMessages.add(ord);
      for (const em of (chunk.match(EMAIL_IN_MSG_RE) || [])) emailsFromMessages.add(em.toLowerCase());
      for (const ord of (chunk.match(SHOPIFY_ORDER_IN_MSG_RE) || [])) shopifyOrdersFromMessages.add(ord.toUpperCase());
      const facts = extractDeviceFactsFromText(chunk);
      if (facts.length) convDeviceFacts.set(conv.id, dedupeFactRows(facts));
    }

    for (const conv of convMap.values()) {
      const cid = conv.contact_id ?? conv.meta?.contact?.id;
      if (cid && !contactById.has(cid)) {
        try {
          const { data } = await client.get(`/api/v1/accounts/${accountId}/contacts/${cid}`);
          const p = data.payload || data;
          if (p?.id) contactById.set(p.id, p);
        } catch { /* skip */ }
      }
    }

    const all = [...convMap.values()].map((c) => {
      const row = mapConversation(c);
      row.deviceFacts = dedupeFactRows(convDeviceFacts.get(c.id) || []);
      return row;
    });
    all.sort((a, b) => {
      const ta = a.date ? Date.parse(String(a.date)) : 0;
      const tb = b.date ? Date.parse(String(b.date)) : 0;
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });

    const contactList = [...contactById.values()].map((c) => ({
      id: c.id,
      name: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || null,
      email: c.email || null,
      phone: c.phone_number || null,
    }));

    const emailsFromContacts = new Set();
    for (const c of contactList) {
      const em = (c.email || '').trim().toLowerCase();
      if (em && em.includes('@')) emailsFromContacts.add(em);
    }

    return {
      contacts: contactList,
      servicioTecnico: all.filter((x) => x.stTagged),
      chatwoot: all.filter((x) => !x.stTagged),
      allConversations: all,
      stOrdersFromMessages: [...stOrdersFromMessages],
      contactCount: contactList.length,
      conversationCount: all.length,
      openConversationsCount: openIds.size,
      messagesAnalyzed,
      emailsFromContacts: [...emailsFromContacts],
      emailsFromMessages: [...emailsFromMessages],
      shopifyOrdersFromMessages: [...shopifyOrdersFromMessages],
      strictNameNote: null,
    };
  }

  if (plan.type === 'conversationId') {
    const convId = plan.conversationId;
    let full;
    try {
      full = await fetchConversationDetail(client, accountId, convId);
    } catch (e) {
      throw chatwootHttpError('Chatwoot (conversación por ID)', e);
    }
    if (!full?.id) throw new Error('Chatwoot: conversación no encontrada');

    const convMap = new Map([[full.id, full]]);
    const merged = convMap.get(full.id);
    if (!Array.isArray(merged.labels) || merged.labels.length === 0) {
      try {
        const fuller = await fetchConversationDetail(client, accountId, full.id);
        if (fuller?.id) convMap.set(fuller.id, { ...merged, ...fuller });
      } catch {
        /* usar payload mínimo */
      }
    }

    const finalConv = convMap.get(full.id) || full;
    const contactList = [];
    const cid = finalConv.contact_id ?? finalConv.meta?.contact?.id;
    if (cid) {
      try {
        const { data } = await client.get(`/api/v1/accounts/${accountId}/contacts/${cid}`);
        const p = data.payload || data;
        if (p?.id) {
          contactList.push({
            id: p.id,
            name: p.name || [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || null,
            email: p.email || null,
            phone_number: p.phone_number || null,
          });
        }
      } catch {
        const s = finalConv.meta?.sender;
        if (s?.id) {
          contactList.push({
            id: s.id,
            name: s.name || [s?.first_name, s?.last_name].filter(Boolean).join(' ').trim() || null,
            email: s.email || null,
            phone_number: s.phone_number || null,
          });
        }
      }
    } else {
      const s = finalConv.meta?.sender;
      if (s?.id) {
        contactList.push({
          id: s.id,
          name: s.name || [s?.first_name, s?.last_name].filter(Boolean).join(' ').trim() || null,
          email: s.email || null,
          phone_number: s.phone_number || null,
        });
      }
    }

    const convDeviceFacts = new Map();
    const stOrdersFromMessages = new Set();
    const emailsFromMessages = new Set();
    const shopifyOrdersFromMessages = new Set();
    let messagesAnalyzed = 0;
    const msgs = await fetchConversationMessages(client, accountId, finalConv.id);
    messagesAnalyzed += msgs.length;
    const chunk = msgs.map(messagePlainText).join('\n');
    for (const ord of extractStOrdersFromText(chunk)) stOrdersFromMessages.add(ord);
    if (hasStLabel(finalConv.labels || [])) {
      const orderHits = chunk.match(new RegExp(ORDER_TOKEN_RE.source, 'gi')) || [];
      for (const ord of orderHits.map((x) => x.toUpperCase().replace(/\s/g, ''))) stOrdersFromMessages.add(ord);
    }
    for (const em of (chunk.match(EMAIL_IN_MSG_RE) || [])) emailsFromMessages.add(em.toLowerCase());
    for (const ord of (chunk.match(SHOPIFY_ORDER_IN_MSG_RE) || [])) shopifyOrdersFromMessages.add(ord.toUpperCase());
    const facts = extractDeviceFactsFromText(chunk);
    if (facts.length) convDeviceFacts.set(finalConv.id, dedupeFactRows(facts));

    const openIds = new Set();
    if (finalConv.status === 'open' || finalConv.status === 'pending') openIds.add(finalConv.id);

    const all = [...convMap.values()].map((c) => {
      const row = mapConversation(c);
      row.deviceFacts = dedupeFactRows(convDeviceFacts.get(c.id) || []);
      return row;
    });
    all.sort((a, b) => {
      const ta = a.date ? Date.parse(String(a.date)) : 0;
      const tb = b.date ? Date.parse(String(b.date)) : 0;
      const na = Number.isFinite(ta) ? ta : 0;
      const nb = Number.isFinite(tb) ? tb : 0;
      return nb - na;
    });

    const servicioTecnico = all.filter((x) => x.stTagged);
    const chatwootGeneral = all.filter((x) => !x.stTagged);

    const emailsFromContacts = new Set();
    for (const c of contactList) {
      const em = (c.email || '').trim().toLowerCase();
      if (em && em.includes('@')) emailsFromContacts.add(em);
    }

    const phonesFromContacts = new Set();
    for (const c of contactList) {
      const ph = (c.phone_number || c.phone || '').trim();
      if (ph) phonesFromContacts.add(ph);
    }
    const allFacts = [...(convDeviceFacts.get(finalConv.id) || [])];
    const rutsFromMessages = [...new Set(allFacts.filter((f) => f.label === 'RUT').map((f) => f.value))];

    return {
      contacts: contactList,
      servicioTecnico,
      chatwoot: chatwootGeneral,
      allConversations: all,
      stOrdersFromMessages: [...stOrdersFromMessages],
      emailsFromContacts: [...emailsFromContacts],
      emailsFromMessages: [...emailsFromMessages],
      shopifyOrdersFromMessages: [...shopifyOrdersFromMessages],
      phonesFromContacts: [...phonesFromContacts],
      rutsFromMessages,
      contactCount: contactList.length,
      conversationCount: all.length,
      openConversationsCount: openIds.size,
      messagesAnalyzed,
      strictNameNote: null,
    };
  }

  const queries = [...new Set((plan.chatwootQueries || []).filter(Boolean))];
  const contactById = new Map();

  for (const q of queries) {
    let list;
    try {
      list = await fetchContactSearch(client, accountId, q);
    } catch (e) {
      throw chatwootHttpError('Chatwoot (búsqueda contactos)', e);
    }
    for (const c of list) {
      if (c?.id) contactById.set(c.id, c);
    }
  }

  let contactList = [...contactById.values()];
  let strictNameNote = null;
  if (plan.type === 'name' && plan.name) {
    const tokens = strictNameQueryTokens(plan.name);
    if (tokens.length) {
      const before = contactList.length;
      contactList = contactList.filter((c) => {
        const dn =
          c.name ||
          [c.first_name, c.last_name].filter(Boolean).join(' ').trim() ||
          c.email ||
          String(c.identifier || '').trim() ||
          '';
        return nameMatchesStrictTokens(dn, tokens);
      });
      if (before > 0 && contactList.length === 0) {
        strictNameNote =
          'Chatwoot: sin contactos que cumplan el nombre palabra por palabra (p. ej. “Mora” no basta para “Morales”).';
      }
    }
  }

  const convMap = new Map();

  for (const contact of contactList.slice(0, 20)) {
    const contactId = contact.id;
    if (!contactId) continue;
    const convUrl = `/api/v1/accounts/${accountId}/contacts/${contactId}/conversations`;
    try {
      const { data: convData } = await client.get(convUrl);
      const list = convData?.payload || convData;
      const conversations = Array.isArray(list) ? list : list?.data || [];
      for (const conv of conversations) {
        if (conv?.id && !convMap.has(conv.id)) convMap.set(conv.id, conv);
      }
    } catch {
      /* sin conversaciones */
    }
  }

  const convValues = [...convMap.values()];
  for (let i = 0; i < Math.min(convValues.length, 45); i++) {
    const conv = convValues[i];
    const labels = conv.labels;
    if (Array.isArray(labels) && labels.length) continue;
    try {
      const full = await fetchConversationDetail(client, accountId, conv.id);
      if (full && full.id) convMap.set(full.id, { ...conv, ...full });
    } catch {
      /* parcial */
    }
  }

  const openConversations = [...convMap.values()].filter(
    (c) => c.status === 'open' || c.status === 'pending',
  );
  const openIds = new Set(openConversations.map((c) => c.id));

  /** Conversaciones abiertas para análisis de mensajes (prioridad) + cerradas recientes */
  const forMessages = [...convMap.values()].sort((a, b) => {
    const ao = a.status === 'open' ? 1 : 0;
    const bo = b.status === 'open' ? 1 : 0;
    if (bo !== ao) return bo - ao;
    const ta = a.updated_at ? Date.parse(String(a.updated_at)) : 0;
    const tb = b.updated_at ? Date.parse(String(b.updated_at)) : 0;
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });

  const maxConvForMessages = 14;
  const stOrdersFromMessages = new Set();
  const emailsFromMessages = new Set();
  const shopifyOrdersFromMessages = new Set();
  const convDeviceFacts = new Map();
  let messagesAnalyzed = 0;

  for (const conv of forMessages.slice(0, maxConvForMessages)) {
    const msgs = await fetchConversationMessages(client, accountId, conv.id);
    messagesAnalyzed += msgs.length;
    const chunk = msgs.map(messagePlainText).join('\n');
    for (const ord of extractStOrdersFromText(chunk)) stOrdersFromMessages.add(ord);
    if (hasStLabel(conv.labels || [])) {
      const orderHits = chunk.match(new RegExp(ORDER_TOKEN_RE.source, 'gi')) || [];
      for (const ord of orderHits.map((x) => x.toUpperCase().replace(/\s/g, ''))) stOrdersFromMessages.add(ord);
    }
    for (const em of (chunk.match(EMAIL_IN_MSG_RE) || [])) emailsFromMessages.add(em.toLowerCase());
    for (const ord of (chunk.match(SHOPIFY_ORDER_IN_MSG_RE) || [])) shopifyOrdersFromMessages.add(ord.toUpperCase());
    const facts = extractDeviceFactsFromText(chunk);
    if (facts.length) {
      const prev = convDeviceFacts.get(conv.id) || [];
      convDeviceFacts.set(conv.id, dedupeFactRows([...prev, ...facts]));
    }
  }

  const all = [...convMap.values()].map((c) => {
    const row = mapConversation(c);
    row.deviceFacts = dedupeFactRows(convDeviceFacts.get(c.id) || []);
    return row;
  });
  all.sort((a, b) => {
    const ta = a.date ? Date.parse(String(a.date)) : 0;
    const tb = b.date ? Date.parse(String(b.date)) : 0;
    const na = Number.isFinite(ta) ? ta : 0;
    const nb = Number.isFinite(tb) ? tb : 0;
    return nb - na;
  });

  const servicioTecnico = all.filter((x) => x.stTagged);
  const chatwootGeneral = all.filter((x) => !x.stTagged);

  const emailsFromContacts = new Set();
  for (const c of contactList) {
    const em = (c.email || c.identifier || '').trim().toLowerCase();
    if (em && em.includes('@')) emailsFromContacts.add(em);
  }

  const phonesFromContacts = new Set();
  for (const c of contactList) {
    const ph = (c.phone_number || '').trim();
    if (ph) phonesFromContacts.add(ph);
  }
  const allFlatFacts = [...convDeviceFacts.values()].flat();
  const rutsFromMessages = [...new Set(allFlatFacts.filter((f) => f.label === 'RUT').map((f) => f.value))];

  return {
    contacts: contactList.map((c) => ({
      id: c.id,
      name: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || null,
      email: c.email || null,
      phone: c.phone_number || null,
    })),
    servicioTecnico,
    chatwoot: chatwootGeneral,
    allConversations: all,
    stOrdersFromMessages: [...stOrdersFromMessages],
    emailsFromContacts: [...emailsFromContacts],
    emailsFromMessages: [...emailsFromMessages],
    shopifyOrdersFromMessages: [...shopifyOrdersFromMessages],
    phonesFromContacts: [...phonesFromContacts],
    rutsFromMessages,
    contactCount: contactList.length,
    conversationCount: all.length,
    openConversationsCount: openIds.size,
    messagesAnalyzed,
    strictNameNote,
  };
}
