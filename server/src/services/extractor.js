const PATTERNS = [
  {
    type: 'imei',
    re: /\b(86\d{13})\b/g,
    normalize: (_, g1) => g1.replace(/\s/g, ''),
  },
  {
    type: 'sim_id',
    re: /\b(89\d{17,18})\b/g,
    normalize: (_, g1) => g1.replace(/\s/g, ''),
  },
  {
    type: 'boleta',
    re: /\b(?:boleta|factura)\s*(?:n[°º]?\.?\s*|n[uú]mero\s*)?(\d{4,8})\b/gi,
    normalize: (_, g1) => g1.replace(/\D/g, ''),
  },
  {
    type: 'shopify_order',
    re: /\bSM(\d{4,8})\b/gi,
    normalize: (_, g1) => 'SM' + g1,
  },
  {
    type: 'service_order',
    re: /\bOS[-\s]?(\d{3,6})\b/gi,
    normalize: (_, g1) => 'OS-' + g1,
  },
];

/**
 * Extracts structured entities from a text string.
 * Pure function — no side effects, fully testable.
 * @param {string} text
 * @returns {{ entity_type: string, raw_value: string, normalized_value: string }[]}
 */
export function extractEntities(text) {
  if (!text || typeof text !== 'string') return [];

  const results = [];
  const seen = new Set();

  for (const { type, re, normalize } of PATTERNS) {
    const regex = new RegExp(re.source, re.flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      const raw_value = match[0];
      const normalized_value = normalize(match[0], match[1] ?? match[0]);
      const key = `${type}:${normalized_value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ entity_type: type, raw_value, normalized_value });
    }
  }

  return results;
}
