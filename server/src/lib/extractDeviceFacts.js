/**
 * Extrae pares tipo "Modelo: X" / IMEI desde texto de tickets ST (español).
 * No es IA: regex sobre mensajes para mostrar tablita rápida en la UI.
 */

// SoyMomo product catalogue for inline detection (without a "Modelo:" label)
const SOYMOMO_MODEL_RE = /\b(?:SoyMomo\s+)?(?:Space\s+[1-9](?:\.\d+)?(?:\s+Lite)?|Baby\s+Monitor(?:\s+(?:Lite|Pro(?:\s+2)?))?|Tablet(?:\s+(?:Lite(?:\s+[23])?|Pro(?:\s+2)?))?|Momophone(?:\s+Pro)?)\b/gi;

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

      // Si es un IMEI de 15 dígitos que empieza con 8, derivar e indexar también el ID de 10 dígitos
      if (label === 'ID / IMEI' && value.length === 15 && value.startsWith('8')) {
        const derived = value.slice(4, -1);
        const derivedKey = `ID / IMEI:${derived}`;
        if (!seen.has(derivedKey)) {
          seen.add(derivedKey);
          out.push({ label: 'ID / IMEI', value: derived });
        }
      }
    }
  }

  // Loose IMEI: any 15-digit number starting with 8 (with or without "IMEI:" prefix)
  for (const m of (text.match(/\b(8\d{14})\b/g) || [])) {
    const key = `ID / IMEI:${m}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ label: 'ID / IMEI', value: m });
      // Derived 10-digit device ID: remove first 4 and last digit
      const derived = m.slice(4, -1);
      const derivedKey = `ID / IMEI:${derived}`;
      if (!seen.has(derivedKey)) {
        seen.add(derivedKey);
        out.push({ label: 'ID / IMEI', value: derived });
      }
    }
  }

  // ICCID suelto: número de 19-20 dígitos que empieza con 89 (prefijo estándar SIM)
  for (const m of (text.match(/\b(89\d{17,18})\b/g) || [])) {
    const key = `ICCID / SIM:${m}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ label: 'ICCID / SIM', value: m });
    }
  }

  // Inline SoyMomo product model (no "Modelo:" prefix required)
  const modelRe = new RegExp(SOYMOMO_MODEL_RE.source, SOYMOMO_MODEL_RE.flags);
  let mm;
  while ((mm = modelRe.exec(text)) !== null) {
    const value = mm[0].replace(/\s+/g, ' ').trim();
    const key = `Modelo:${value.toLowerCase()}`;
    // Skip if already captured via the "Modelo: X" label pattern
    const alreadyCaptured = out.some(
      r => r.label === 'Modelo' && r.value.toLowerCase().includes(value.toLowerCase())
    );
    if (!seen.has(key) && !alreadyCaptured) {
      seen.add(key);
      out.push({ label: 'Modelo', value });
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
