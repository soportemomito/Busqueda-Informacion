import axios from 'axios';
import { nameMatchesStrictTokens, strictNameQueryTokens } from '../lib/nameMatch.js';

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

/** https://shop.myshopify.com/admin/api/VERSION → https://shop.myshopify.com */
export function shopifyStoreOriginFromApiBase(apiBase) {
  try {
    return new URL(apiBase).origin;
  } catch {
    return '';
  }
}

function formatAxiosError(prefix, err) {
  const status = err.response?.status;
  const body = err.response?.data;
  let msg = err.message;
  if (body?.errors) {
    msg =
      typeof body.errors === 'string'
        ? body.errors
        : Array.isArray(body.errors)
          ? body.errors.map((e) => e.message || e).join('; ')
          : JSON.stringify(body.errors).slice(0, 320);
  }
  return new Error(`${prefix}: HTTP ${status || '—'} — ${msg}`);
}

function shopify401Hint(apiBase) {
  const origin = shopifyStoreOriginFromApiBase(apiBase || '');
  return (
    ` HTTP 401 en Shopify casi siempre es token inválido o tienda distinta al token. ` +
    `Esta petición va a ${origin || '(URL admin no válida)'}. ` +
    `El token Admin (shpat_…) solo funciona en la tienda donde lo creaste: en server/.env usa SHOPIFY_API_URL=https://TU-TIENDA.myshopify.com/admin/api/2024-10 ` +
    `o SHOPIFY_SHOP_HOST=TU-TIENDA.myshopify.com (debe ser la misma tienda del token). ` +
    `Revisa copiar/pegar sin espacios, que no esté revocado y que sea de una app personalizada con acceso Admin API (no otro tipo de clave).`
  );
}

function shopify404Hint(apiBase) {
  const base = normalizeBaseUrl(apiBase || '');
  return (
    ` HTTP 404 en shop.json suele ser versión de API inexistente o URL mal armada. ` +
    `SHOPIFY_API_URL debe ser solo la base: https://TU-TIENDA.myshopify.com/admin/api/VERSION (sin /shop.json ni /graphql). ` +
    `Usa el host *.myshopify.com (no el dominio público de la tienda). Prueba VERSION=2024-10 o 2025-10. Base usada: ${base || '—'}.`
  );
}

function gidToNumericId(gid) {
  if (!gid || typeof gid !== 'string') return null;
  const m = gid.match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * Valida token + tienda + versión de API antes de buscar.
 */
async function pingShop(http) {
  const { data } = await http.get('shop.json', { params: { fields: 'name,myshopify_domain' } });
  return data?.shop;
}

const GQL_CUSTOMER_SEARCH = `
  query CustomerSearch($q: String!) {
    customers(first: 25, query: $q) {
      edges {
        node {
          id
          email
          firstName
          lastName
          phone
          createdAt
        }
      }
    }
  }
`;

async function searchCustomersGraphQL(http, searchQuery) {
  const { data: res } = await http.post(
    'graphql.json',
    { query: GQL_CUSTOMER_SEARCH, variables: { q: searchQuery } },
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (res.errors?.length) {
    throw new Error(res.errors.map((e) => e.message || String(e)).join('; '));
  }

  const edges = res.data?.customers?.edges || [];
  return edges.map((e) => {
    const n = e.node;
    const id = gidToNumericId(n.id);
    return {
      id,
      email: n.email || null,
      first_name: n.firstName || null,
      last_name: n.lastName || null,
      phone: n.phone || null,
      orders_count: null,
      total_spent: null,
      created_at: n.createdAt,
      raw: n,
    };
  }).filter((c) => c.id != null);
}

async function searchCustomersREST(http, plan, searchQuery) {
  const attempts =
    plan.type === 'phone' && searchQuery.startsWith('phone:')
      ? [
          searchQuery,
          `phone:+56${searchQuery.slice('phone:'.length)}`,
          `phone:+${searchQuery.slice('phone:'.length)}`,
        ]
      : [searchQuery];

  for (const q of attempts) {
    const { data } = await http.get('customers/search.json', {
      params: { query: q, limit: 25 },
    });
    const list = data?.customers || [];
    if (list.length) return list;
  }
  return [];
}

/**
 * Búsqueda de clientes y pedidos (Admin API).
 * Clientes: GraphQL primero (REST search a veces falla según versión/plan); pedidos: REST.
 * Scopes típicos: read_customers, read_orders.
 */
export async function searchShopify(plan, creds) {
  const base = normalizeBaseUrl(creds.shopifyAdminApiBaseUrl || '');
  const token = String(creds.shopifyAccessToken || '').trim().replace(/^\uFEFF/, '');

  if (!token || !base) {
    return { customers: [], orders: [], note: null, skipped: true };
  }

  const http = axios.create({
    baseURL: base,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    timeout: 35000,
  });

  if (plan.type === 'empty') {
    return { customers: [], orders: [], note: null, skipped: false };
  }

  try {
    await pingShop(http);
  } catch (e) {
    const baseErr = formatAxiosError('Shopify (shop.json)', e);
    if (e.response?.status === 401) {
      throw new Error(`${baseErr.message}.${shopify401Hint(base)}`);
    }
    if (e.response?.status === 404) {
      throw new Error(`${baseErr.message}.${shopify404Hint(base)}`);
    }
    throw baseErr;
  }

  const storeOrigin = shopifyStoreOriginFromApiBase(base);

  if (plan.type === 'orderNumber') {
    const namesToTry = plan.shopifyNamesToTry?.length
      ? plan.shopifyNamesToTry
      : [...new Set([plan.orderNumber, plan.orderRaw, `#${plan.digits}`].filter(Boolean))];

    let foundOrders = [];
    for (const name of namesToTry) {
      try {
        const { data } = await http.get('orders.json', {
          params: { name, status: 'any', limit: 10 },
        });
        const items = data?.orders || [];
        if (items.length) { foundOrders = items; break; }
      } catch { /* next variant */ }
    }

    if (!foundOrders.length) {
      return {
        customers: [],
        orders: [],
        note: `Shopify: sin pedido con nombre “${plan.orderNumber}”.`,
        skipped: false,
      };
    }

    const customerIds = [...new Set(
      foundOrders.map((o) => o.customer?.id ?? o.customer_id).filter(Boolean),
    )];

    const customers = [];
    for (const cid of customerIds.slice(0, 5)) {
      try {
        const { data } = await http.get(`customers/${cid}.json`);
        if (data?.customer) customers.push(mapCustomer(data.customer));
      } catch { /* skip */ }
    }

    const orders = foundOrders.map((o) => mapOrder(o, storeOrigin));
    orders.sort((a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0));

    return { customers, orders, note: null, skipped: false, strictNameNote: null };
  }

  let searchQuery = '';
  if (plan.type === 'email') {
    searchQuery = `email:${plan.email}`;
  } else if (plan.type === 'phone') {
    const d = plan.phoneDigits || plan.bsaleHints?.digits || '';
    searchQuery = d ? `phone:${d}` : '';
  } else {
    searchQuery = String(plan.name || '').trim();
  }

  if (!searchQuery) {
    return { customers: [], orders: [], note: null, skipped: false };
  }

  let customers = [];
  try {
    customers = await searchCustomersGraphQL(http, searchQuery);
  } catch {
    try {
      customers = await searchCustomersREST(http, plan, searchQuery);
    } catch (eRest) {
      throw formatAxiosError('Shopify (búsqueda clientes GraphQL y REST)', eRest);
    }
  }

  // Shopify usa índice fuzzy para teléfono — filtrar que los dígitos coincidan exactamente
  if (plan.type === 'phone' && plan.phoneDigits) {
    const sd = plan.phoneDigits.replace(/\D/g, '');
    if (sd) {
      customers = customers.filter((c) => {
        const cd = (c.phone || '').replace(/\D/g, '');
        if (!cd) return false;
        const shorter = sd.length <= cd.length ? sd : cd;
        const longer = sd.length <= cd.length ? cd : sd;
        return longer.endsWith(shorter);
      });
    }
  }

  let strictNameNote = null;
  if (plan.type === 'name' && plan.name) {
    const tokens = strictNameQueryTokens(plan.name);
    if (tokens.length && customers.length) {
      const before = customers.length;
      customers = customers.filter((c) => {
        const dn = [c.first_name, c.last_name, c.email].filter(Boolean).join(' ').trim();
        return nameMatchesStrictTokens(dn, tokens);
      });
      if (before > 0 && customers.length === 0) {
        strictNameNote =
          'Shopify: sin clientes que cumplan el nombre palabra por palabra (no se cuenta “Mora” dentro de “Morales”).';
      }
    }
  }

  if (!customers.length) {
    return {
      customers: [],
      orders: [],
      note:
        strictNameNote ||
        'Shopify: sin clientes para esta consulta (prueba correo, teléfono con código país o nombre como en la tienda).',
      skipped: false,
      strictNameNote: strictNameNote || null,
    };
  }

  const mappedCustomers = customers.slice(0, 15).map(mapCustomer);
  const orders = [];
  const seenOrder = new Set();

  for (const c of customers.slice(0, 8)) {
    const cid = c.id;
    if (cid == null) continue;
    try {
      const { data } = await http.get('orders.json', {
        params: { customer_id: cid, status: 'any', limit: 15 },
      });
      for (const o of data?.orders || []) {
        if (seenOrder.has(o.id)) continue;
        seenOrder.add(o.id);
        orders.push(mapOrder(o, storeOrigin));
      }
    } catch {
      /* sin pedidos */
    }
  }

  orders.sort((a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0));

  return {
    customers: mappedCustomers,
    orders: orders.slice(0, 40),
    note: null,
    skipped: false,
    strictNameNote: null,
  };
}

function mapCustomer(c) {
  return {
    id: c.id,
    email: c.email || null,
    firstName: c.first_name || null,
    lastName: c.last_name || null,
    phone: c.phone || null,
    ordersCount: c.orders_count,
    totalSpent: c.total_spent,
    createdAt: c.created_at,
    raw: c.raw ?? c,
  };
}

function mapOrder(o, storeOrigin) {
  const origin = storeOrigin ? storeOrigin.replace(/\/+$/, '') : '';
  const adminUrl = origin && o.id != null ? `${origin}/admin/orders/${o.id}` : null;
  const q = o.name || (o.id != null ? String(o.id) : '');
  const adminOrdersSearchUrl =
    origin && q ? `${origin}/admin/orders?query=${encodeURIComponent(q)}` : null;
  return {
    id: o.id,
    name: o.name,
    createdAt: o.created_at,
    financialStatus: o.financial_status,
    fulfillmentStatus: o.fulfillment_status,
    totalPrice: o.total_price,
    currency: o.currency,
    customerId: o.customer?.id ?? o.customer_id ?? null,
    adminUrl,
    adminOrdersSearchUrl,
    raw: o,
  };
}
