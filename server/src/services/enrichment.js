/**
 * Progressive enrichment engine.
 *
 * Starting from any single identifier (email, phone, name, IMEI, order number,
 * boleta number, service order number) it queries all available sources and
 * extracts new identifiers from each result. Each round unlocks more searches.
 * Runs up to MAX_ROUNDS times or until no new identifiers are discovered.
 */

import { fetchBsaleForContact, fetchBsaleByDocumentNumber } from './bsale_panel.js';
import { fetchShopifyForContact, fetchShopifyByOrderName } from './shopify_panel.js';
import { searchContactInChatwoot } from './chatwoot_panel.js';
import { extractEntities } from './extractor.js';

const MAX_ROUNDS = 3;
const INTERNAL_DOMAINS = new Set(['soymomo.com', 'soymomo.io', 'helpdesk.soymomo.io']);
const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /(?:\+?56\s?)?9\d{8}/g;

// ─── Context ──────────────────────────────────────────────────────────────────

class EnrichmentContext {
  constructor() {
    // Primary identifiers — from the contact itself (Chatwoot or explicit seed)
    // Used first for Shopify/Bsale searches to avoid contamination from message text
    this.contactName  = null;
    this.contactEmail = null;
    this.contactPhone = null;

    // Trusted emails: from Chatwoot contact record OR typed literally by the customer
    // in an incoming message. API-discovered emails do NOT go here.
    // Shopify and Bsale contact searches only fire when this set has new values.
    this.directEmails = new Set();

    // Identifier pools
    this.emails   = new Set();
    this.phones   = new Set();
    this.names    = new Set();
    this.imeis    = new Set();
    this.simIds   = new Set();
    this.shopifyOrderNames  = new Set();
    this.boletaNumbers      = new Set();
    this.serviceOrderNumbers = new Set();

    // Accumulated results (keyed maps to deduplicate)
    this.chatwootContact     = null;
    this.chatwootConversations = [];
    this.shopifyOrders = new Map();   // shopify_order_id → row
    this.bsaleDocs     = new Map();   // document_number   → row
    this.devices       = new Map();   // imei              → row
    this.serviceOrders = new Map();   // order_number      → row

    // Track which specific values have been consumed per source
    this._usedBsale   = new Set();
    this._usedShopify = new Set();
    this._usedChatwoot = new Set();
    this._usedDbShopify      = new Set();
    this._usedDbBsale        = new Set();
    this._usedDbDevices      = new Set();
    this._usedDbService      = new Set();
    this._usedApiShopifyOrders  = new Set(); // SM numbers searched via API
    this._usedApiBsaleDocs      = new Set(); // boleta numbers searched via API
    this._usedDbServiceByEmail  = new Set(); // emails searched in service_orders
  }

  // ── Adders (return true when the value is new) ──────────────────────────────

  _normalizeEmail(e) {
    if (!e) return null;
    let n = String(e).trim().toLowerCase();
    if (!n.includes('@')) return null;
    const [local, domain] = n.split('@');
    const cleanLocal = local.split('+')[0];
    n = `${cleanLocal}@${domain}`;
    if (INTERNAL_DOMAINS.has(domain)) return null;
    return n;
  }

  addEmail(e) {
    const n = this._normalizeEmail(e);
    if (!n) return false;
    return _add(this.emails, n);
  }

  /** Like addEmail but also marks the email as "trusted" (from contact or message text). */
  addDirectEmail(e) {
    const n = this._normalizeEmail(e);
    if (!n) return false;
    _add(this.emails, n);
    return _add(this.directEmails, n);
  }
  addPhone(p) {
    if (!p) return false;
    const n = String(p).replace(/[\s\-()]/g, '');
    if (n.length < 7) return false;
    return _add(this.phones, n);
  }
  addName(n) {
    if (!n) return false;
    const v = String(n).trim();
    if (v.split(/\s+/).length < 2) return false; // require at least 2 words
    return _add(this.names, v);
  }
  addImei(v)         { return v ? _add(this.imeis, String(v)) : false; }
  addSimId(v)        { return v ? _add(this.simIds, String(v)) : false; }
  addShopifyOrder(v) { return v ? _add(this.shopifyOrderNames, String(v)) : false; }
  addBoleta(v)       { return v ? _add(this.boletaNumbers, String(v)) : false; }
  addServiceOrder(v) { return v ? _add(this.serviceOrderNumbers, String(v)) : false; }

  /** Parse raw text from messages and extract all possible identifiers. */
  addFromText(text) {
    if (!text) return;
    for (const e of extractEntities(text)) {
      if (e.entity_type === 'imei')          this.addImei(e.normalized_value);
      if (e.entity_type === 'sim_id')        this.addSimId(e.normalized_value);
      if (e.entity_type === 'shopify_order') this.addShopifyOrder(e.normalized_value);
      if (e.entity_type === 'boleta')        this.addBoleta(e.normalized_value);
      if (e.entity_type === 'service_order') this.addServiceOrder(e.normalized_value);
    }
    // Emails from message text are exact and trusted — use addDirectEmail.
    // Phones from messages are NOT used for Shopify/Bsale (too unreliable).
    for (const m of (text.match(EMAIL_RE) || [])) this.addDirectEmail(m);
    for (const m of (text.match(PHONE_RE) || [])) this.addPhone(m);
  }

  // ── "Has new identifiers for X" checks ──────────────────────────────────────

  _hasNew(pool, prefix, used) {
    for (const v of pool) { if (!used.has(prefix + v)) return true; }
    return false;
  }

  // Shopify and Bsale only trigger on exact trusted emails (directEmails).
  // Chatwoot text-search still uses the full pools.
  hasNewForShopify()  { return this._hasNew(this.directEmails, 'e:', this._usedShopify); }
  hasNewForBsale()    { return this._hasNew(this.directEmails, 'e:', this._usedBsale); }
  hasNewForChatwoot() { return this._hasNew(this.emails, 'e:', this._usedChatwoot) || this._hasNew(this.phones, 'p:', this._usedChatwoot) || this._hasNew(this.names, 'n:', this._usedChatwoot); }

  _markUsed(pool, prefix, used) { for (const v of pool) used.add(prefix + v); }

  markUsedShopify()  { this._markUsed(this.directEmails, 'e:', this._usedShopify); }
  markUsedBsale()    { this._markUsed(this.directEmails, 'e:', this._usedBsale); }
  markUsedChatwoot() { this._markUsed(this.emails, 'e:', this._usedChatwoot); this._markUsed(this.phones, 'p:', this._usedChatwoot); this._markUsed(this.names, 'n:', this._usedChatwoot); }

  newDbItems(pool, used) { return [...pool].filter(v => !used.has(v)); }

  /** Snapshot of total identifier count — used to detect if a round added anything new. */
  snapshot() {
    return this.emails.size + this.phones.size + this.names.size +
           this.imeis.size + this.simIds.size +
           this.shopifyOrderNames.size + this.boletaNumbers.size + this.serviceOrderNumbers.size;
  }

  toResult() {
    // Normalize contact fields: prefer Chatwoot data, fall back to identifier pools
    let contact = null;
    // Best email: Chatwoot contact record → contactEmail (explicit seed) → email from message text
    const bestEmail = () =>
      this.contactEmail || [...this.directEmails][0] ||
      [...this.shopifyOrders.values()][0]?.contact_email ||
      [...this.bsaleDocs.values()][0]?.contact_email ||
      [...this.serviceOrders.values()][0]?.contact_email || null;

    if (this.chatwootContact) {
      contact = {
        chatwoot_contact_id: this.chatwootContact.chatwoot_contact_id,
        name:  this.chatwootContact.name  || this.contactName || null,
        email: this.chatwootContact.email || bestEmail(),
        phone: this.chatwootContact.phone_whatsapp || this.contactPhone || null,
      };
    } else {
      // No Chatwoot contact (e.g. manual search) — build from discovered data
      const firstOrder = [...this.shopifyOrders.values()][0];
      const firstDoc   = [...this.bsaleDocs.values()][0];
      const firstST    = [...this.serviceOrders.values()][0];
      const name  = this.contactName || firstOrder?.contact_name || firstDoc?.contact_name || firstST?.contact_name || null;
      const email = bestEmail();
      const phone = this.contactPhone || firstOrder?.contact_phone || null;
      if (name || email || phone) {
        contact = { chatwoot_contact_id: null, name, email, phone };
      }
    }
    return {
      contact,
      conversations:   this.chatwootConversations,
      devices:         [...this.devices.values()],
      shopify_orders:  [...this.shopifyOrders.values()],
      bsale_documents: [...this.bsaleDocs.values()],
      service_orders:  [...this.serviceOrders.values()],
      identifiers: {
        emails:                [...this.emails],
        phones:                [...this.phones],
        imeis:                 [...this.imeis],
        sim_ids:               [...this.simIds],
        shopify_order_names:   [...this.shopifyOrderNames],
        boleta_numbers:        [...this.boletaNumbers],
        service_order_numbers: [...this.serviceOrderNumbers],
      },
    };
  }
}

function _add(set, value) {
  if (set.has(value)) return false;
  set.add(value);
  return true;
}

// ─── Source enrichers ─────────────────────────────────────────────────────────

async function fromShopify(ctx) {
  // Only search by exact trusted email — never by phone or discovered emails.
  // SM order numbers trigger fromShopifyByOrderNames separately (also exact).
  const email = ctx.contactEmail || [...ctx.directEmails][0] || null;
  if (!email) return;
  ctx.markUsedShopify();
  const orders = await fetchShopifyForContact(email, null);
  for (const o of orders) {
    if (ctx.shopifyOrders.has(o.shopify_order_id)) continue;
    ctx.shopifyOrders.set(o.shopify_order_id, o);
    ctx.addEmail(o.contact_email);   // discovered — goes to emails, not directEmails
    ctx.addPhone(o.contact_phone);
    ctx.addName(o.contact_name);
  }
}

async function fromBsale(ctx) {
  // Only search by exact trusted email — never by phone or name fallback.
  // Boleta numbers trigger fromBsaleByDocNumbers separately (also exact).
  const email = ctx.contactEmail || [...ctx.directEmails][0] || null;
  if (!email) return;
  ctx.markUsedBsale();
  const docs = await fetchBsaleForContact(email, null, null);
  for (const d of docs) {
    if (ctx.bsaleDocs.has(d.document_number)) continue;
    ctx.bsaleDocs.set(d.document_number, d);
    ctx.addEmail(d.contact_email);   // discovered — goes to emails, not directEmails
    ctx.addName(d.contact_name);
  }
}

async function fromChatwoot(ctx) {
  if (ctx.chatwootContact) return; // already resolved
  ctx.markUsedChatwoot();
  const email = [...ctx.emails][0] || null;
  const phone = [...ctx.phones][0] || null;
  const name  = [...ctx.names][0]  || null;
  const result = await searchContactInChatwoot({ email, phone, name });
  if (!result) return;
  ctx.chatwootContact       = result.contact;
  ctx.chatwootConversations = result.conversations;
  // Contact email found via Chatwoot is trusted for Shopify/Bsale search
  if (!ctx.contactEmail && result.contact.email) ctx.contactEmail = result.contact.email;
  ctx.addDirectEmail(result.contact.email);
  ctx.addPhone(result.contact.phone_whatsapp);
  ctx.addName(result.contact.name);
}

async function fromDbShopify(ctx, db, orderNames) {
  const { data } = await db.from('shopify_orders').select('*').in('order_name', orderNames);
  for (const o of data || []) {
    if (ctx.shopifyOrders.has(o.shopify_order_id)) continue;
    ctx.shopifyOrders.set(o.shopify_order_id, o);
    ctx.addEmail(o.contact_email);
    ctx.addPhone(o.contact_phone);
    ctx.addName(o.contact_name);
  }
}

async function fromDbBsale(ctx, db, numbers) {
  const { data } = await db.from('bsale_documents').select('*').in('document_number', numbers);
  for (const d of data || []) {
    if (ctx.bsaleDocs.has(d.document_number)) continue;
    ctx.bsaleDocs.set(d.document_number, d);
    ctx.addEmail(d.contact_email);
    ctx.addName(d.contact_name);
  }
}

async function fromDbDevices(ctx, db, imeis) {
  const { data } = await db.from('devices').select('id, imei, sim_id, brand, model').in('imei', imeis);
  for (const d of data || []) {
    if (!ctx.devices.has(d.imei)) {
      ctx.devices.set(d.imei, d);
      ctx.addSimId(d.sim_id);
    }
  }
}

const SERVICE_ORDERS_SELECT = 'id, order_number, status, technician, received_at, device_id, contact_name, contact_email, report_url, entry_report_url';

async function fromDbServiceOrders(ctx, db, orderNumbers) {
  const { data } = await db.from('service_orders')
    .select(SERVICE_ORDERS_SELECT)
    .in('order_number', orderNumbers);
  const rows = data || [];
  for (const o of rows) {
    if (!ctx.serviceOrders.has(o.order_number)) ctx.serviceOrders.set(o.order_number, o);
  }
  // Batch-fetch device IMEIs in one query instead of N+1
  const deviceIds = [...new Set(rows.filter(o => o.device_id).map(o => o.device_id))];
  if (deviceIds.length) {
    const { data: devs } = await db.from('devices').select('id, imei').in('id', deviceIds);
    for (const dev of devs || []) if (dev.imei) ctx.addImei(dev.imei);
  }
}

async function fromDbServiceOrdersByEmail(ctx, db, emails) {
  const { data } = await db.from('service_orders')
    .select(SERVICE_ORDERS_SELECT)
    .in('contact_email', emails);
  for (const o of data || []) {
    if (ctx.serviceOrders.has(o.order_number)) continue;
    ctx.serviceOrders.set(o.order_number, o);
  }
}

async function fromShopifyByOrderNames(ctx, orderNames) {
  for (const name of orderNames.slice(0, 5)) {
    const orders = await fetchShopifyByOrderName(name).catch(() => []);
    for (const o of orders) {
      if (ctx.shopifyOrders.has(o.shopify_order_id)) continue;
      ctx.shopifyOrders.set(o.shopify_order_id, o);
      ctx.addEmail(o.contact_email);
      ctx.addPhone(o.contact_phone);
      ctx.addName(o.contact_name);
    }
  }
}

async function fromBsaleByDocNumbers(ctx, numbers) {
  for (const num of numbers.slice(0, 5)) {
    const docs = await fetchBsaleByDocumentNumber(num).catch(() => []);
    for (const d of docs) {
      if (ctx.bsaleDocs.has(d.document_number)) continue;
      ctx.bsaleDocs.set(d.document_number, d);
      ctx.addEmail(d.contact_email);
      ctx.addName(d.contact_name);
    }
  }
}

// ─── Round runner ─────────────────────────────────────────────────────────────

async function runRound(ctx, db) {
  const before = ctx.snapshot();
  const tasks = [];

  if (ctx.hasNewForShopify())  { tasks.push(fromShopify(ctx).catch(() => {})); }
  if (ctx.hasNewForBsale())    { tasks.push(fromBsale(ctx).catch(() => {})); }
  if (ctx.hasNewForChatwoot()) { tasks.push(fromChatwoot(ctx).catch(() => {})); }

  const newShopifyOrders  = ctx.newDbItems(ctx.shopifyOrderNames, ctx._usedDbShopify);
  const newImeis          = ctx.newDbItems(ctx.imeis, ctx._usedDbDevices);
  const newServiceOrders  = ctx.newDbItems(ctx.serviceOrderNumbers, ctx._usedDbService);
  const newDbBoletas      = ctx.newDbItems(ctx.boletaNumbers, ctx._usedDbBsale);

  newShopifyOrders.forEach(v => ctx._usedDbShopify.add(v));
  newImeis.forEach(v => ctx._usedDbDevices.add(v));
  newServiceOrders.forEach(v => ctx._usedDbService.add(v));
  newDbBoletas.forEach(v => ctx._usedDbBsale.add(v));

  if (newShopifyOrders.length) tasks.push(fromDbShopify(ctx, db, newShopifyOrders).catch(() => {}));
  if (newImeis.length)         tasks.push(fromDbDevices(ctx, db, newImeis).catch(() => {}));
  if (newServiceOrders.length) tasks.push(fromDbServiceOrders(ctx, db, newServiceOrders).catch(() => {}));
  if (newDbBoletas.length)     tasks.push(fromDbBsale(ctx, db, newDbBoletas).catch(() => {}));

  // SM order numbers → direct Shopify API lookup (exact match)
  const newApiShopifyOrders = ctx.newDbItems(ctx.shopifyOrderNames, ctx._usedApiShopifyOrders);
  newApiShopifyOrders.forEach(v => ctx._usedApiShopifyOrders.add(v));
  if (newApiShopifyOrders.length) tasks.push(fromShopifyByOrderNames(ctx, newApiShopifyOrders).catch(() => {}));

  // Boleta/factura numbers → direct Bsale API lookup
  const newApiBoletas = ctx.newDbItems(ctx.boletaNumbers, ctx._usedApiBsaleDocs);
  newApiBoletas.forEach(v => ctx._usedApiBsaleDocs.add(v));
  if (newApiBoletas.length) tasks.push(fromBsaleByDocNumbers(ctx, newApiBoletas).catch(() => {}));

  // Service orders by contact email (Google Sheets sync data)
  const newEmailsForST = ctx.newDbItems(ctx.emails, ctx._usedDbServiceByEmail);
  newEmailsForST.forEach(v => ctx._usedDbServiceByEmail.add(v));
  if (newEmailsForST.length) tasks.push(fromDbServiceOrdersByEmail(ctx, db, newEmailsForST).catch(() => {}));

  if (!tasks.length) return false;
  await Promise.all(tasks);
  return ctx.snapshot() > before;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @param {object} seed - any combination of: email, phone, name, imei, sim_id,
 *   shopify_order, boleta, service_order, messages (array of {content}),
 *   cwContact (pre-fetched Chatwoot contact), cwConversations
 * @param {object} db - Supabase client
 */
export async function runEnrichment(seed, db) {
  const ctx = new EnrichmentContext();

  // Seed explicit identifiers (from manual search or query params)
  if (seed.name)          { ctx.contactName = seed.name; ctx.addName(seed.name); }
  if (seed.email)         { ctx.contactEmail = seed.email; ctx.addDirectEmail(seed.email); }
  if (seed.phone)         { ctx.contactPhone = seed.phone; ctx.addPhone(seed.phone); }
  if (seed.imei)          ctx.addImei(seed.imei);
  if (seed.sim_id)        ctx.addSimId(seed.sim_id);
  if (seed.shopify_order) ctx.addShopifyOrder(seed.shopify_order);
  if (seed.boleta)        ctx.addBoleta(seed.boleta);
  if (seed.service_order) ctx.addServiceOrder(seed.service_order);

  // Only extract identifiers from customer messages or our internal notes (exclude outgoing agent messages).
  // message_type 0 = incoming; sender_type 'contact' = customer
  // message_type 2 / 'activity' or private = internal notes (where agents write customer details)
  for (const m of seed.messages || []) {
    const isCustomer = m.message_type === 0 || m.message_type === 'incoming' || m.message_type === '0'
      || m.sender_type === 'contact';
    const isInternalNote = m.private === true || m.message_type === 2 || m.message_type === '2' || m.message_type === 'activity';
    if (isCustomer || isInternalNote) {
      ctx.addFromText(m.content);
    }
  }

  // Seed pre-fetched Chatwoot contact (skip Chatwoot text search for this)
  if (seed.cwContact) {
    ctx.chatwootContact      = seed.cwContact;
    ctx.chatwootConversations = seed.cwConversations || [];
    ctx.markUsedChatwoot(); // don't search Chatwoot again by text
    // These are the trusted primary identifiers for this contact
    if (seed.cwContact.name)           ctx.contactName  = seed.cwContact.name;
    if (seed.cwContact.email)          ctx.contactEmail = seed.cwContact.email;
    if (seed.cwContact.phone_whatsapp) ctx.contactPhone = seed.cwContact.phone_whatsapp;
    ctx.addDirectEmail(seed.cwContact.email);
    ctx.addPhone(seed.cwContact.phone_whatsapp);
    ctx.addName(seed.cwContact.name);
  }

  // Progressive rounds
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const grew = await runRound(ctx, db);
    if (!grew) break;
  }

  return ctx;
}
