import axios from 'axios';

function makeHttp() {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  // Use full URL if provided, otherwise construct from store URL
  const baseURL = process.env.SHOPIFY_API_URL
    || (process.env.SHOPIFY_STORE_URL ? `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01` : null);
  if (!token || !baseURL) return null;
  return axios.create({
    baseURL: baseURL.replace(/\/+$/, ''),
    headers: { 'X-Shopify-Access-Token': token },
    timeout: 10000,
  });
}

function mapOrder(order) {
  const customer = order.customer || {};
  return {
    shopify_order_id: String(order.id),
    order_name: order.name || null,
    contact_name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null,
    contact_email: order.email || customer.email || null,
    contact_phone: order.phone || customer.phone || null,
    status: order.fulfillment_status || null,
    financial_status: order.financial_status || null,
    total_price: order.total_price ? parseFloat(order.total_price) : null,
    raw_data: order,
    fetched_at: new Date().toISOString(),
  };
}

/**
 * Fetches Shopify orders for a contact. Returns [] on any error.
 */
export async function fetchShopifyForContact(email, phone) {
  const http = makeHttp();
  if (!http) return [];

  const seen = new Set();
  const results = [];

  const add = (orders) => {
    for (const o of orders) {
      if (!seen.has(o.shopify_order_id)) {
        seen.add(o.shopify_order_id);
        results.push(o);
      }
    }
  };

  if (email) {
    try {
      const { data } = await http.get('/orders.json', { params: { email, status: 'any', limit: 10 } });
      add((data?.orders || []).map(mapOrder));
    } catch { /* silent */ }
  }

  if (phone) {
    try {
      const { data } = await http.get('/orders.json', { params: { phone, status: 'any', limit: 10 } });
      add((data?.orders || []).map(mapOrder));
    } catch { /* silent */ }
  }

  return results;
}
