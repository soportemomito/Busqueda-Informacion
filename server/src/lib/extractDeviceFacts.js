import { extractEntities } from '../services/extractor.js';

const PAIRS = [
  [/modelo(?:\s*(?:de|del)?\s*(?:reloj|dispositivo|producto))?\s*:\s*([^\n]+)/gi, 'Modelo'],
  [/producto\s*:\s*([^\n]+)/gi, 'Producto'],
  [/tablet\s*:\s*([^\n]+)/gi, 'Tablet'],
  [/color\s*:\s*([^\n]+)/gi, 'Color'],
  [/(?:id\s*\/\s*imei|imei|id\s*(?:del)?\s*dispositivo)\s*:\s*([A-Za-z0-9]+)/gi, 'ID / IMEI'],
  [/serial\s*(?:n[ºo°.]?)?\s*:\s*([A-Za-z0-9-]+)/gi, 'Serial'],
  [/sku\s*:\s*([^\n]+)/gi, 'SKU'],
  [/suscripci[oó]n\s*:\s*(\d{14,22})/gi, 'ICCID / SIM'],
  [/(?:n[uú]mero\s*(?:de\s*)?(?:sim|tarjeta\s*sim|suscripci[oó]n)|iccid)\s*:\s*(\d{14,22})/gi, 'ICCID / SIM'],
  // Chilean RUT with explicit label (12.345.678-9 or 12345678-9)
  [/\brut\s*[:\s.]+\s*([\d]{1,2}\.?[\d]{3}\.?[\d]{3,4}-?[0-9kK])/gi, 'RUT'],
];

function clean(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/^["']|["']$/g, '')
    .trim()
    .slice(0, 200);
}

/**
 * @param {string} text
 * @returns {{ label: string, value: string }[]}
 */
export function extractDeviceFactsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  
  // 1. Explicit key-value pairs (Color, Serial, SKU, etc.)
  for (const [re, label] of PAIRS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = clean(m[1]);
      if (!value) continue;
      const key = `${label}:${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label, value });
    }
  }

  // 2. Centralized extractor engine entities (IMEI, SIM, Model, RUT, Comuna, Failure tags)
  const entities = extractEntities(text);
  for (const e of entities) {
    let label = '';
    let val = e.normalized_value;
    
    if (e.entity_type === 'imei') {
      label = 'ID / IMEI';
    } else if (e.entity_type === 'sim_id') {
      label = 'ICCID / SIM';
    } else if (e.entity_type === 'device_model') {
      label = 'Modelo';
    } else if (e.entity_type === 'rut') {
      label = 'RUT';
    } else if (e.entity_type === 'comuna') {
      label = 'Comuna';
    } else if (e.entity_type === 'direccion') {
      label = 'Dirección';
    } else if (e.entity_type === 'failure_keyword') {
      label = 'Falla';
    }

    if (label) {
      const key = `${label}:${val.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ label, value: val });

        // IMEI sub-derivations (10-digit ID)
        if (label === 'ID / IMEI' && val.length === 15 && val.startsWith('8')) {
          const derived = val.slice(4, -1);
          const derivedKey = `ID / IMEI:${derived}`;
          if (!seen.has(derivedKey)) {
            seen.add(derivedKey);
            out.push({ label: 'ID / IMEI', value: derived });
          }
        }
      }
    }
  }

  return out;
}

/**
 * @param {Map<number, { label: string, value: string }[]> | Record<string, unknown>} byConv
 * @returns {{ label: string, value: string, conversationId?: number }[]}
 */
export function flattenDeviceFactsForMeta(byConv) {
  const list = [];
  const seen = new Set();
  const entries = byConv instanceof Map ? [...byConv.entries()] : Object.entries(byConv || {});
  for (const [cid, rows] of entries) {
    const convId = Number(cid);
    for (const r of rows || []) {
      if (!r?.label || !r?.value) continue;
      const key = `${r.label}:${String(r.value).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        label: r.label,
        value: r.value,
        ...(Number.isFinite(convId) ? { conversationId: convId } : {}),
      });
    }
  }
  return list;
}
