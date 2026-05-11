/**
 * Normaliza entrada y define estrategia de búsqueda.
 * Tipos: conversationId, email, orderNumber, rut, imei, phone, name
 */

const EMAIL_RE = /\S+@\S+\.\S+/;

/** cw 1234 / conv:999 / conversación 8 */
const CHATWOOT_CONV_RE =
  /^(?:cw|conv|conversaci[oó]n|conversation|chatwoot)\s*[#:]?\s*(\d+)\s*$/i;

/** #SM38293, SM#38293, SM38293, SMA-2345 */
const ORDER_NUMBER_RE = /^#[A-Za-z0-9][A-Za-z0-9-]*$|^[A-Za-z]{1,4}[#-]?\d{3,8}$/;

/**
 * RUT chileno — acepta todos los formatos comunes:
 *   Con puntos + guión:  12.345.678-9  /  1.234.567-K
 *   Con puntos sin guión: 12.345.6789  /  1.234.567K
 *   Sin puntos con guión: 12345678-9   /  12345678-K
 *   Sin puntos sin guión + K: 12345678K / 12345678k
 */
const RUT_RE =
  /^(\d{1,2}(\.\d{3}){2})[\s\-]?[\dkK]$|^\d{7,8}[\s\-][\dkK]$|^\d{7,8}[kK]$/i;

/** IMEI: exactamente 15 dígitos */
const IMEI_RE = /^\d{15}$/;

/** Número corto puro (3–6 dígitos) = ID de conversación Chatwoot */
const SHORT_NUM_RE = /^\d{3,6}$/;

export function normalizePhoneInput(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^\+/, '');
  s = s.replace(/[\s().-]/g, '');
  if (s.startsWith('56') && s.length > 9) s = s.slice(2);
  if (s.startsWith('569') && s.length >= 10) s = s.slice(3);
  return s;
}

export function buildSearchPlan(raw) {
  const trimmed = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return { type: 'empty' };

  // 1. Prefijo explícito: "cw 1234"
  const cwMatch = trimmed.match(CHATWOOT_CONV_RE);
  if (cwMatch) {
    const conversationId = Number(cwMatch[1]);
    if (Number.isFinite(conversationId) && conversationId > 0) {
      return { type: 'conversationId', conversationId, chatwootQueries: [], bsaleHints: {} };
    }
  }

  // 2. Número corto puro (3–6 dígitos) → ID de conversación
  if (SHORT_NUM_RE.test(trimmed)) {
    const conversationId = Number(trimmed);
    if (conversationId > 0) {
      return { type: 'conversationId', conversationId, chatwootQueries: [], bsaleHints: {} };
    }
  }

  // 3. Email
  if (EMAIL_RE.test(trimmed)) {
    const email = trimmed.toLowerCase();
    return { type: 'email', email, chatwootQueries: [trimmed, email], bsaleHints: { email } };
  }

  // 4. Número de pedido Shopify (#SM38293, etc.)
  if (ORDER_NUMBER_RE.test(trimmed)) {
    const withoutLeadingHash = trimmed.replace(/^#+/, '');
    const letterPart = withoutLeadingHash.replace(/[^A-Za-z]/g, '').toUpperCase();
    const digits = withoutLeadingHash.replace(/\D/g, '');
    const shopifyNamesToTry = [...new Set([
      letterPart ? `${letterPart}#${digits}` : null,
      `#${letterPart}${digits}`,
      `#${digits}`,
      letterPart ? `${letterPart}${digits}` : null,
    ].filter(Boolean))];
    return {
      type: 'orderNumber',
      orderNumber: `#${letterPart}${digits}`,
      orderRaw: withoutLeadingHash.toUpperCase(),
      shopifyNamesToTry,
      digits,
      letterPart,
      chatwootQueries: shopifyNamesToTry,
      bsaleHints: {},
    };
  }

  // 5. RUT chileno (antes de IMEI/teléfono)
  if (RUT_RE.test(trimmed)) {
    const clean = trimmed.replace(/\./g, ''); // sin puntos para buscar variantes en mensajes
    return {
      type: 'rut',
      rut: trimmed,
      chatwootQueries: [trimmed, clean],
      bsaleHints: { code: trimmed },
    };
  }

  // 6. IMEI (exactamente 15 dígitos)
  //    Si empieza con 8 → derivar el ID del equipo quitando los 4 primeros y el último dígito
  const digitsOnly = trimmed.replace(/\s/g, '');
  if (IMEI_RE.test(digitsOnly)) {
    const deviceId = digitsOnly.startsWith('8') ? digitsOnly.slice(4, -1) : null;
    return {
      type: 'imei',
      imei: digitsOnly,
      deviceId,
      // Buscar por IMEI completo Y por el ID del equipo derivado
      chatwootQueries: deviceId ? [digitsOnly, deviceId] : [digitsOnly],
      bsaleHints: {},
    };
  }

  // 7. Teléfono (8+ dígitos mayoritariamente numéricos)
  const mostlyNumeric = /^[\d\s+().-]+$/.test(trimmed);
  const digits = trimmed.replace(/\D/g, '');
  if (mostlyNumeric && digits.length >= 8) {
    const normalizedDigits = normalizePhoneInput(trimmed);
    const queries = [...new Set([normalizedDigits, digits, trimmed].filter(Boolean))];
    return {
      type: 'phone',
      phoneDigits: normalizedDigits,
      chatwootQueries: queries,
      bsaleHints: { phone: trimmed, digits: normalizedDigits },
    };
  }

  // 9. Nombre (por defecto)
  return {
    type: 'name',
    name: trimmed,
    chatwootQueries: [trimmed],
    bsaleHints: { name: trimmed },
  };
}
