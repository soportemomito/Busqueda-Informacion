import axios from 'axios';
import { nameMatchesStrictTokens, strictNameQueryTokens } from '../lib/nameMatch.js';

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());
}

function mostlyPhone(s) {
  const d = String(s).replace(/\D/g, '');
  return d.length >= 8;
}

function looksLikeRutOrCode(s) {
  const t = String(s).trim();
  if (t.length < 2) return false;
  return /^[\d.\-]+[0-9kK]?$/.test(t) && /\d/.test(t);
}

function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

async function loadDocumentDetailsIfNeeded(http, doc) {
  const detailsRaw = doc.details;
  const hasInline =
    Array.isArray(detailsRaw) ||
    (detailsRaw && typeof detailsRaw === 'object' && Array.isArray(detailsRaw.items) && detailsRaw.items.length > 0);
  if (hasInline) return doc;
  const href = detailsRaw && typeof detailsRaw === 'object' && detailsRaw.href ? detailsRaw.href : null;
  if (!href) return doc;
  try {
    const path = href.startsWith('http') ? new URL(href).pathname : href;
    const { data } = await http.get(path);
    return { ...doc, details: data };
  } catch {
    return doc;
  }
}

/**
 * Emails en ficha principal o en contactos del cliente (misma cuenta Bsale).
 */
function collectEmailsFromClientRecord(c) {
  const out = new Set();
  const main = normalizeEmail(c.email);
  if (main) out.add(main);
  const contacts = c.contacts;
  const list = Array.isArray(contacts) ? contacts : contacts?.items;
  if (Array.isArray(list)) {
    for (const co of list) {
      const e = normalizeEmail(co?.email);
      if (e) out.add(e);
    }
  }
  return out;
}

async function resolveAllEmailsForClient(http, c) {
  const out = collectEmailsFromClientRecord(c);
  const contacts = c.contacts;
  if (Array.isArray(contacts)) {
    for (const co of contacts) {
      const e = normalizeEmail(co?.email);
      if (e) out.add(e);
    }
    return out;
  }
  if (Array.isArray(contacts?.items)) {
    for (const co of contacts.items) {
      const e = normalizeEmail(co?.email);
      if (e) out.add(e);
    }
    return out;
  }
  const href = contacts?.href;
  if (!href) return out;
  try {
    const path = href.startsWith('http') ? new URL(href).pathname : href;
    const { data } = await http.get(path);
    for (const co of data?.items || []) {
      const e = normalizeEmail(co?.email);
      if (e) out.add(e);
    }
  } catch {
    /* sin contactos */
  }
  return out;
}

/**
 * Si GET clients?email= no devuelve nada, el correo puede estar solo en contactos.
 * Recorre páginas de clientes con expand=contacts (tope de páginas para no saturar la API).
 */
async function findClientIdsByEmailIncludingContacts(http, emailNorm, { maxPages = 12 } = {}) {
  const ids = new Set();
  const limit = 50;
  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;
    let data;
    try {
      const res = await http.get('/v1/clients.json', {
        params: {
          limit,
          offset,
          expand: '[contacts]',
        },
      });
      data = res.data;
    } catch {
      break;
    }
    const items = data?.items || [];
    if (!items.length) break;
    for (const c of items) {
      const emails = await resolveAllEmailsForClient(http, c);
      if (emails.has(emailNorm)) ids.add(c.id);
    }
    if (items.length < limit) break;
  }
  return [...ids];
}

async function fetchDocumentsForClient(http, clientId) {
  const baseParams = {
    clientid: clientId,
    limit: 50,
    expand: '[office,document_type,details,payments]',
  };

  const attempts = [
    baseParams,
    { clientid: clientId, limit: 50, expand: 'office,document_type,details,payments' },
  ];

  let lastErr = null;
  for (const params of attempts) {
    try {
      const { data } = await http.get('/v1/documents.json', { params });
      const items = data?.items || [];
      if (items.length) return { items, paramsUsed: params };
    } catch (e) {
      lastErr = e;
    }
  }

  // último intento: sin expand (al menos folios); el detalle se enriquece después
  try {
    const { data } = await http.get('/v1/documents.json', {
      params: { clientid: clientId, limit: 50 },
    });
    return { items: data?.items || [], paramsUsed: { clientid: clientId, limit: 50 } };
  } catch (e) {
    lastErr = e;
  }

  return { items: [], error: lastErr };
}

function clientSummary(c) {
  return {
    id: c.id,
    email: c.email || null,
    name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.company || null,
    company: c.company || null,
  };
}

/**
 * Busca clientes y documentos en Bsale según el plan de búsqueda (email / teléfono / nombre).
 */
export async function searchBsale(plan, creds) {
  const base = normalizeBaseUrl(creds.bsaleApiBaseUrl || 'https://api.bsale.app');
  const token = creds.bsaleApiToken;

  if (!token) {
    throw new Error('Bsale: falta token (BSALE_ACCESS_TOKEN o BSALE_API_TOKEN en server/.env o Supabase)');
  }

  const http = axios.create({
    baseURL: base,
    headers: {
      access_token: token,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  if (plan.type === 'empty') return { items: [], clientIds: [], clients: [], note: null };

  // Solo buscar con identificadores confiables: email, nombre completo (2+ palabras) o RUT
  if (plan.type === 'phone' || plan.type === 'imei') {
    return { items: [], clientIds: [], clients: [], note: null };
  }
  if (plan.type === 'name') {
    const parts = String(plan.name || plan.bsaleHints?.name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return { items: [], clientIds: [], clients: [], note: null };
  }

  const hints = plan.bsaleHints || {};
  let q = '';
  let qEmailNorm = '';
  let emailMode = false;

  if (plan.type === 'email') {
    q = plan.email || hints.email || '';
    qEmailNorm = normalizeEmail(q);
    emailMode = true;
  } else if (plan.type === 'rut') {
    q = plan.rut || hints.code || '';
    qEmailNorm = '';
  } else if (plan.type === 'phone') {
    q = hints.phone || plan.phoneDigits || '';
    qEmailNorm = '';
  } else {
    q = plan.name || hints.name || '';
    qEmailNorm = '';
  }

  q = String(q || '').trim();
  if (!q) return { items: [], clientIds: [], clients: [], note: null };

  const clientIds = new Set();
  const clientRecords = new Map();
  const tryList = [];

  if (emailMode || isEmail(q)) {
    const em = qEmailNorm || normalizeEmail(q);
    tryList.push(() => http.get('/v1/clients.json', { params: { email: em, limit: 50 } }));
    tryList.push(() => http.get('/v1/clients.json', { params: { email: q, limit: 50 } }));
  }
  if (plan.type === 'phone' || mostlyPhone(q)) {
    tryList.push(() => http.get('/v1/clients.json', { params: { phone: q, limit: 50 } }));
    if (hints.digits && hints.digits !== q.replace(/\D/g, '')) {
      tryList.push(() => http.get('/v1/clients.json', { params: { phone: hints.digits, limit: 50 } }));
    }
  }
  if (looksLikeRutOrCode(q)) {
    tryList.push(() => http.get('/v1/clients.json', { params: { code: q, limit: 50 } }));
  }

  const parts = q.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && plan.type === 'name') {
    tryList.push(() =>
      http.get('/v1/clients.json', {
        params: { firstname: parts[0], lastname: parts.slice(1).join(' '), limit: 50 },
      }),
    );
  } else if (parts.length === 1 && plan.type === 'name' && !isEmail(q)) {
    tryList.push(() => http.get('/v1/clients.json', { params: { firstname: parts[0], limit: 50 } }));
    tryList.push(() => http.get('/v1/clients.json', { params: { lastname: parts[0], limit: 50 } }));
  }

  let firstClientError = null;
  const seenSig = new Set();
  for (const fn of tryList) {
    try {
      const { data } = await fn();
      const items = data?.items || [];
      for (const c of items) {
        const id = c.id;
        if (id == null) continue;
        const sig = `${id}`;
        if (seenSig.has(sig)) continue;
        seenSig.add(sig);
        clientIds.add(id);
        clientRecords.set(id, c);
      }
    } catch (e) {
      if (!firstClientError && e.response) {
        firstClientError = `clientes HTTP ${e.response.status}`;
      }
    }
  }

  let strictNameNote = null;
  if (plan.type === 'name' && plan.name) {
    const tokens = strictNameQueryTokens(plan.name);
    if (tokens.length && clientIds.size > 0) {
      const before = clientIds.size;
      for (const id of [...clientIds]) {
        const c = clientRecords.get(id);
        const dn = c
          ? [c.firstName, c.lastName, c.company].filter(Boolean).join(' ').trim()
          : '';
        if (!nameMatchesStrictTokens(dn, tokens)) {
          clientIds.delete(id);
          clientRecords.delete(id);
        }
      }
      if (before > 0 && clientIds.size === 0) {
        strictNameNote =
          'Bsale: clientes descartados por nombre estricto (cada palabra debe coincidir entera en nombre/apellido/razón social).';
      }
    }
  }

  let note = null;

  if ((emailMode || isEmail(q)) && clientIds.size === 0) {
    const em = qEmailNorm || normalizeEmail(q);
    const fromContacts = await findClientIdsByEmailIncludingContacts(http, em);
    for (const id of fromContacts) clientIds.add(id);
    if (clientIds.size === 0) {
      note =
        'Bsale: no hay cliente con ese correo en la ficha ni en contactos (revisados listados recientes). Prueba RUT (code), nombre completo o verifica la URL de la API (Chile suele usar https://api.bsale.cl).';
      if (firstClientError) note += ` Detalle API: ${firstClientError}.`;
    }
  }

  const documents = [];
  const docErrors = [];

  for (const clientId of [...clientIds].slice(0, 25)) {
    const { items, error } = await fetchDocumentsForClient(http, clientId);
    if (error && !items?.length) {
      const st = error.response?.status;
      docErrors.push(st ? `documentos ${clientId}: HTTP ${st}` : `documentos ${clientId}: ${error.message}`);
    }

    // Pre-filtrar boletas cuando ya tenemos el tipo en la respuesta del listado
    const candidates = (items || []).filter((doc) => {
      const dt = doc.document_type;
      if (!dt || typeof dt !== 'object' || !dt.name) return true; // tipo desconocido: mantener
      return dt.name.toLowerCase().includes('boleta');
    });

    // Ordenar por fecha desc y tomar las últimas 3 por cliente
    candidates.sort((a, b) => (b.emissionDate || 0) - (a.emissionDate || 0));
    const top3 = candidates.slice(0, 3);

    for (const doc of top3) {
      const enriched = await loadDocumentDetailsIfNeeded(http, doc);
      const mapped = mapDocument(enriched);
      if (mapped.isBoleta) documents.push({ ...mapped, clientId });
    }
  }

  documents.sort((a, b) => (b.emissionDate || 0) - (a.emissionDate || 0));

  if (clientIds.size > 0 && documents.length === 0 && !note) {
    note =
      'Bsale: se encontraron clientes pero sin documentos en la respuesta (revisa permisos del token, tipo de documentos o filtro de sucursal en Bsale).';
    if (docErrors.length) note += ` ${docErrors.slice(0, 2).join('; ')}`;
  }

  const clients = [...clientIds].map((id) => clientSummary(clientRecords.get(id) || { id })).filter((c) => c.id != null);

  // Búsqueda por nombre sin correo: avisar que pueden aparecer varios clientes homónimos
  const nameWithoutEmailNote =
    plan.type === 'name' && clients.length > 0
      ? 'Búsqueda por nombre — sin correo para validar, pueden aparecer clientes con el mismo nombre. Si tienes el correo, úsalo para afinar.'
      : null;

  return {
    items: documents,
    clientIds: [...clientIds],
    clients,
    note,
    strictNameNote: strictNameNote || null,
    nameWithoutEmailNote,
  };
}

function mapDocument(doc) {
  const office = doc.office && typeof doc.office === 'object' ? doc.office : null;
  const docType = doc.document_type && typeof doc.document_type === 'object' ? doc.document_type : null;
  const docTypeName = (docType?.name || '').toLowerCase();
  const isBoleta = docTypeName ? docTypeName.includes('boleta') : true;
  const detailsRaw = doc.details;
  const detailsItems = Array.isArray(detailsRaw)
    ? detailsRaw
    : Array.isArray(detailsRaw?.items)
      ? detailsRaw.items
      : [];

  const paymentsRaw = doc.payments;
  const paymentItems = Array.isArray(paymentsRaw) ? paymentsRaw : paymentsRaw?.items || [];

  const paymentMethods = paymentItems
    .map((p) => p.paymentType?.name || p.payment_type?.name || p.name || p.description)
    .filter(Boolean);

  const itemsDetail = detailsItems.map((d) => ({
    description: d.description || d.variant?.description || d.name || '',
    quantity: d.quantity,
    totalAmount: d.totalAmount,
    netAmount: d.netAmount,
    unitPrice: d.unitValue,
  }));

  return {
    id: doc.id,
    number: doc.number,
    serialNumber: doc.serialNumber || null,
    branch: office?.name || office?.description || String(office?.id || ''),
    documentType: docType?.name || docType?.code || '',
    items: itemsDetail,
    total: doc.totalAmount,
    net: doc.netAmount,
    tax: doc.taxAmount,
    paymentMethods: paymentMethods.length ? paymentMethods : ['—'],
    emissionDate: doc.emissionDate,
    generationDate: doc.generationDate,
    urlPublicView: doc.urlPublicView,
    isBoleta,
    raw: doc,
  };
}
