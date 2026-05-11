/**
 * Extrae pares tipo "Modelo: X" / IMEI desde texto de tickets ST (español).
 * No es IA: regex sobre mensajes para mostrar tablita rápida en la UI.
 */

const PAIRS = [
  [/modelo(?:\s*de\s*reloj)?\s*:\s*([^\n]+)/gi, 'Modelo'],
  [/producto\s*:\s*([^\n]+)/gi, 'Producto'],
  [/tablet\s*:\s*([^\n]+)/gi, 'Tablet'],
  [/color\s*:\s*([^\n]+)/gi, 'Color'],
  [/(?:id\s*\/\s*imei|imei|id\s*del\s*dispositivo)\s*:\s*([A-Za-z0-9]+)/gi, 'ID / IMEI'],
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
    }
  }
  const imeiLoose = text.match(/\b(?:IMEI|imei)\s*[:\s]?\s*(\d{15})\b/);
  if (imeiLoose) {
    const value = imeiLoose[1];
    const key = `ID / IMEI:${value}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ label: 'ID / IMEI', value });
    }
  }

  // ICCID suelto: número de 18-22 dígitos que empieza con 89 (prefijo estándar SIM)
  for (const m of (text.match(/\b(89\d{16,20})\b/g) || [])) {
    const key = `ICCID / SIM:${m}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ label: 'ICCID / SIM', value: m });
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
