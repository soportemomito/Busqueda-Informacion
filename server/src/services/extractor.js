// SoyMomo product catalogue for inline model detection
const SOYMOMO_MODEL_RE = /\b(?:SoyMomo\s+)?(?:Space\s+[1-9](?:\.\d+)?(?:\s+Lite)?|Baby\s+Monitor(?:\s+(?:Lite|Pro(?:\s+2)?))?|Tablet(?:\s+(?:Lite(?:\s+[23])?|Pro(?:\s+2)?))?|Momophone(?:\s+Pro)?)\b/gi;

const PATTERNS = [
  {
    // Any 15-digit number starting with 8 is treated as IMEI
    type: 'imei',
    re: /\b(8\d{14})\b/g,
    normalize: (_, g1) => g1.replace(/\s/g, ''),
  },
  {
    // ICCID / SIM: 19-20 digit number starting with 89 (ITU-T standard)
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
  {
    // SoyMomo device model — with explicit "Modelo [de reloj]:" label OR inline product name
    type: 'device_model',
    re: /modelo(?:\s*(?:de|del)?\s*(?:reloj|dispositivo|producto))?\s*:\s*([^\n]{3,60})/gi,
    normalize: (_, g1) => g1.replace(/\s+/g, ' ').trim(),
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

  // Inline SoyMomo product name detection (no "Modelo:" prefix required)
  const modelRegex = new RegExp(SOYMOMO_MODEL_RE.source, SOYMOMO_MODEL_RE.flags);
  let m;
  while ((m = modelRegex.exec(text)) !== null) {
    const normalized_value = m[0].replace(/\s+/g, ' ').trim();
    const key = `device_model:${normalized_value.toLowerCase()}`;
    if (seen.has(key)) continue;
    // Skip if already captured by a "Modelo:" pattern (same value)
    const duplicate = results.some(
      r => r.entity_type === 'device_model' &&
        r.normalized_value.toLowerCase().includes(normalized_value.toLowerCase())
    );
    if (duplicate) continue;
    seen.add(key);
    results.push({ entity_type: 'device_model', raw_value: m[0], normalized_value });
  }

  return results;
}

export { SOYMOMO_MODEL_RE };
