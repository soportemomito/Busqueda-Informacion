import axios from 'axios';

function makeHttp() {
  const token = process.env.BSALE_ACCESS_TOKEN || process.env.BSALE_API_TOKEN;
  const baseURL = (process.env.BSALE_API_URL || 'https://api.bsale.cl/v1').replace(/\/+$/, '');
  if (!token) return null;
  return axios.create({
    baseURL,
    headers: { access_token: token },
    timeout: 10000,
  });
}

function mapDoc(doc, contactEmail) {
  const docType = doc.document_type;
  const typeName = docType && typeof docType === 'object' ? (docType.name || null) : (docType || null);
  const client = doc.client || doc.contact || {};
  const contactName = client.name
    || [client.firstName, client.lastName].filter(Boolean).join(' ')
    || null;
  return {
    bsale_doc_id: String(doc.id || ''),
    document_number: String(doc.number || doc.serialNumber || doc.id || ''),
    document_type: typeName,
    contact_name: contactName || null,
    contact_email: contactEmail || client.email || null,
    total_amount: doc.totalAmount ?? null,
    issued_at: doc.emissionDate ? new Date(doc.emissionDate * 1000).toISOString() : null,
    bsale_public_url: doc.urlPublicView || null,
    raw_data: doc,
    fetched_at: new Date().toISOString(),
  };
}

async function fetchDocsByClientIds(http, clientIds, fallbackEmail) {
  const results = await Promise.all(
    clientIds.slice(0, 5).map(id =>
      http.get('/documents.json', { params: { clientId: id, limit: 10 } })
        .then(({ data }) => (data?.items || []).map(d => mapDoc(d, fallbackEmail || null)))
        .catch(() => [])
    )
  );
  return results.flat();
}

/**
 * Fetches Bsale documents for a contact using all available identifiers.
 * Tries email → phone → name in order. Returns [] on any error.
 */
export async function fetchBsaleForContact(email, phone, name) {
  const http = makeHttp();
  if (!http) return [];

  try {
    // 1. Search by email (most reliable)
    if (email) {
      const { data } = await http.get('/documents.json', { params: { clientEmail: email, limit: 10 } });
      const docs = (data?.items || []).map(d => mapDoc(d, email));
      if (docs.length) return docs;

      // Email search on clients (in case docs endpoint returns empty)
      const { data: cd } = await http.get('/clients.json', { params: { email, limit: 10 } });
      const ids = (cd?.items || []).map(c => c.id);
      if (ids.length) {
        const docs2 = await fetchDocsByClientIds(http, ids, email);
        if (docs2.length) return docs2;
      }
    }

    // 2. Search by phone number
    if (phone) {
      // Normalize: keep digits only for Bsale
      const digits = phone.replace(/\D/g, '');
      const { data: cd } = await http.get('/clients.json', { params: { phone: digits, limit: 10 } });
      const ids = (cd?.items || []).map(c => c.id);
      if (ids.length) {
        const docs = await fetchDocsByClientIds(http, ids, null);
        if (docs.length) return docs;
      }
    }

    // 3. Search by name (least reliable, needs at least 2 words)
    if (name && name.trim().split(/\s+/).length >= 2) {
      const { data: clientData } = await http.get('/clients.json', { params: { name, limit: 10 } });
      const ids = (clientData?.items || []).map(c => c.id);
      if (ids.length) {
        return fetchDocsByClientIds(http, ids, null);
      }
    }
  } catch { /* silent */ }

  return [];
}

/**
 * Fetch a Bsale document directly by its document number (boleta/factura number).
 */
export async function fetchBsaleByDocumentNumber(number) {
  const http = makeHttp();
  if (!http) return [];
  try {
    const { data } = await http.get('/documents.json', { params: { number, limit: 5 } });
    return (data?.items || []).map(d => mapDoc(d, null));
  } catch { return []; }
}
