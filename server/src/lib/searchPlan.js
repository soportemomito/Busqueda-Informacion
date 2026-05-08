/**
 * Normaliza entrada y define estrategia fuzzy para Chatwoot / Bsale.
 */

const EMAIL_RE = /\S+@\S+\.\S+/;
/** ej. cw:12345, conv#999, conversación: 8 */
const CHATWOOT_CONV_RE =
  /^(?:cw|conv|conversaci[oó]n|conversation|chatwoot)\s*[#:]?\s*(\d+)\s*$/i;
/** ej. #SM38293, SM#38293, SM38293, #1001, SMA-2345 */
const ORDER_NUMBER_RE = /^#[A-Za-z0-9][A-Za-z0-9-]*$|^[A-Za-z]{1,4}[#-]?\d{3,8}$/;

export function normalizePhoneInput(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^\+/, '');
  s = s.replace(/[\s().-]/g, '');
  if (s.startsWith('56') && s.length > 9) s = s.slice(2);
  if (s.startsWith('569') && s.length >= 10) s = s.slice(3);
  return s;
}

/**
 * @param {string} raw
 * @returns {{ type: 'empty' } | { type: 'email', email: string, chatwootQueries: string[], bsaleHints: object }}
 */
export function buildSearchPlan(raw) {
  const trimmed = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return { type: 'empty' };

  const cwMatch = trimmed.match(CHATWOOT_CONV_RE);
  if (cwMatch) {
    const conversationId = Number(cwMatch[1]);
    if (Number.isFinite(conversationId) && conversationId > 0) {
      return {
        type: 'conversationId',
        conversationId,
        chatwootQueries: [],
        bsaleHints: {},
      };
    }
  }

  if (EMAIL_RE.test(trimmed)) {
    const email = trimmed.toLowerCase();
    return {
      type: 'email',
      email,
      chatwootQueries: [trimmed, email],
      bsaleHints: { email },
    };
  }

  if (ORDER_NUMBER_RE.test(trimmed)) {
    const withoutLeadingHash = trimmed.replace(/^#+/, '');
    const letterPart = withoutLeadingHash.replace(/[^A-Za-z]/g, '').toUpperCase(); // 'SM'
    const digits = withoutLeadingHash.replace(/\D/g, '');                           // '38293'

    // Todos los formatos que puede tener este pedido en mensajes/plataformas
    const shopifyNamesToTry = [...new Set([
      letterPart ? `${letterPart}#${digits}` : null, // SM#38293 ← formato nativo Shopify
      `#${letterPart}${digits}`,                      // #SM38293
      `#${digits}`,                                   // #38293
      letterPart ? `${letterPart}${digits}` : null,   // SM38293
    ].filter(Boolean))];

    return {
      type: 'orderNumber',
      orderNumber: `#${letterPart}${digits}`,
      orderRaw: withoutLeadingHash.toUpperCase(),
      shopifyNamesToTry,
      digits,
      letterPart,
      chatwootQueries: shopifyNamesToTry, // buscar cualquier variante en mensajes
      bsaleHints: {},
    };
  }

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

  return {
    type: 'name',
    name: trimmed,
    chatwootQueries: [trimmed],
    bsaleHints: { name: trimmed },
  };
}
