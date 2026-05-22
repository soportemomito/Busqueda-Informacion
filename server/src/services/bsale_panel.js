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
  return {
    document_number: String(doc.number || doc.serialNumber || doc.id || ''),
    document_type: typeName,
    contact_name: null,
    contact_email: contactEmail || null,
    total_amount: doc.totalAmount ?? null,
    issued_at: doc.emissionDate ? new Date(doc.emissionDate * 1000).toISOString() : null,
    raw_data: doc,
    fetched_at: new Date().toISOString(),
  };
}

/**
 * Fetches Bsale documents for a contact. Returns [] on any error.
 */
export async function fetchBsaleForContact(email, name) {
  const http = makeHttp();
  if (!http) return [];

  try {
    if (email) {
      const { data } = await http.get('/documents.json', { params: { clientEmail: email, limit: 10 } });
      const docs = (data?.items || []).map(d => mapDoc(d, email));
      if (docs.length) return docs;
    }

    if (name) {
      const { data: clientData } = await http.get('/clients.json', { params: { name, limit: 10 } });
      const clients = clientData?.items || [];
      const allDocs = [];
      for (const client of clients.slice(0, 3)) {
        try {
          const { data } = await http.get('/documents.json', { params: { clientId: client.id, limit: 10 } });
          allDocs.push(...(data?.items || []).map(d => mapDoc(d, client.email || email || null)));
        } catch { /* silent */ }
      }
      return allDocs;
    }
  } catch { /* silent */ }

  return [];
}
