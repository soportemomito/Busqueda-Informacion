import { getDb } from './supabase.js';

export async function linkDocument({ conversation_id, document_type, document_id, linked_method }) {
  if (!conversation_id || !document_id) return;
  const db = getDb();
  await db.from('conversation_documents').upsert(
    { conversation_id, document_type, document_id, linked_method },
    { onConflict: 'conversation_id,document_type,document_id', ignoreDuplicates: true }
  );
}

export async function getBsaleDocuments(contactInternalId, contactEmail, convInternalIds) {
  const db = getDb();

  // 1. Via conversation_documents
  if (convInternalIds.length) {
    const { data: links } = await db.from('conversation_documents')
      .select('document_id')
      .eq('document_type', 'bsale')
      .in('conversation_id', convInternalIds);
    const ids = (links || []).map(l => l.document_id);
    if (ids.length) {
      const { data } = await db.from('bsale_documents').select('*').in('id', ids);
      if (data?.length) return data;
    }
  }

  // 2. Fallback by contact email
  if (contactEmail) {
    const { data } = await db.from('bsale_documents').select('*').ilike('contact_email', contactEmail);
    return data || [];
  }

  return [];
}

export async function getShopifyOrders(contactInternalId, contactEmail, contactPhone, convInternalIds) {
  const db = getDb();

  // 1. Via conversation_documents
  if (convInternalIds.length) {
    const { data: links } = await db.from('conversation_documents')
      .select('document_id')
      .eq('document_type', 'shopify')
      .in('conversation_id', convInternalIds);
    const ids = (links || []).map(l => l.document_id);
    if (ids.length) {
      const { data } = await db.from('shopify_orders').select('*').in('id', ids);
      if (data?.length) return data;
    }
  }

  // 2. Fallback by email + phone
  const results = [];
  const seen = new Set();

  if (contactEmail) {
    const { data } = await db.from('shopify_orders').select('*').ilike('contact_email', contactEmail);
    for (const r of data || []) {
      if (!seen.has(r.id)) { seen.add(r.id); results.push(r); }
    }
  }
  if (contactPhone) {
    const { data } = await db.from('shopify_orders').select('*').eq('contact_phone', contactPhone);
    for (const r of data || []) {
      if (!seen.has(r.id)) { seen.add(r.id); results.push(r); }
    }
  }

  return results;
}

export async function getServiceOrders(contactInternalId, deviceIds, convInternalIds) {
  const db = getDb();

  const queries = [];

  if (convInternalIds.length) {
    queries.push(
      db.from('conversation_documents')
        .select('document_id')
        .eq('document_type', 'service_order')
        .in('conversation_id', convInternalIds)
        .then(async ({ data: links }) => {
          const ids = (links || []).map(l => l.document_id);
          if (!ids.length) return [];
          const { data } = await db.from('service_orders').select('*').in('id', ids);
          return data || [];
        })
    );
  }

  if (contactInternalId) {
    queries.push(
      db.from('service_orders').select('*').eq('contact_id', contactInternalId)
        .then(({ data }) => data || [])
    );
  }

  if (deviceIds.length) {
    queries.push(
      db.from('service_orders').select('*').in('device_id', deviceIds)
        .then(({ data }) => data || [])
    );
  }

  if (!queries.length) return [];

  const allResults = await Promise.all(queries);
  const seen = new Set();
  const results = [];
  for (const rows of allResults) {
    for (const r of rows) {
      if (!seen.has(r.id)) { seen.add(r.id); results.push(r); }
    }
  }
  return results;
}
