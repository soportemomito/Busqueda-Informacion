// SoyMomo product catalogue for inline model detection
const SOYMOMO_MODEL_RE = /\b(?:SoyMomo\s+)?(?:Space\s+[1-9](?:\.\d+)?(?:\s+Lite)?|Baby\s+Monitor(?:\s+(?:Lite|Pro(?:\s+2)?))?|Tablet(?:\s+(?:Lite(?:\s+[23])?|Pro(?:\s+2)?))?|Momophone(?:\s+Pro)?)\b/gi;

// Chilean Comunas dictionary for semantic mapping
const COMUNAS_CHILE = [
  'santiago', 'las condes', 'providencia', 'maipu', 'maipú', 'puente alto', 'la florida', 'viña del mar',
  'viña', 'ñuñoa', 'nunoa', 'peñalolén', 'peñalolen', 'colina', 'lampa', 'lo barnechea', 'vitacura',
  'la reina', 'san miguel', 'macul', 'estación central', 'estacion central', 'independencia', 'recoleta',
  'conchalí', 'conchali', 'quilicura', 'pudahuel', 'cerro navia', 'quinta normal', 'renca', 'lo prado',
  'cerrillos', 'pedro aguirre cerda', 'san joaquín', 'san joaquin', 'la granja', 'san ramón', 'san ramon',
  'la pintana', 'el bosque', 'lo espejo', 'san bernardo', 'pirque', 'san josé de maipo', 'buin', 'paine',
  'talagante', 'peñaflor', 'isla de maipo', 'melipilla', 'curacaví', 'curacavi', 'maria pinto', 'rancagua',
  'concepcion', 'concepción', 'antofagasta', 'valparaiso', 'valparaíso', 'temuco', 'laserena', 'la serena',
  'coquimbo', 'iquique', 'antofagasta', 'talca', 'chillan', 'chillán', 'osorno', 'valdivia', 'puerto montt'
];

const FAILURE_PATTERNS = [
  { type: 'Batería/Carga', re: /\b(?:bater[ií]a|cargador|carga|no\s+carga|se\s+descarga|descarg[oó]|bateria)\b/i },
  { type: 'Pantalla', re: /\b(?:pantalla|vidrio|t[aá]ctil|quebrad[oa]|rot[oa]|táctil|tactil)\b/i },
  { type: 'Señal/SIM', re: /\b(?:se[nñ]al|cobertura|chip|sim|no\s+conecta|red|antena|datos|cobertura)\b/i },
  { type: 'GPS/Ubicación', re: /\b(?:gps|ubica|ubicaci[oó]n|mapa|no\s+ubica|desfasad[oa]|ubicacion)\b/i },
  { type: 'Encendido/Boot', re: /\b(?:no\s+prende|no\s+enciende|bot[oó]n|se\s+apaga|boton|prendido|prendo)\b/i },
  { type: 'Audio/Micrófono', re: /\b(?:parlante|micr[oó]fono|audio|no\s+escucha|ruido|sonido|microfono|habla)\b/i },
  { type: 'Aplicación/App', re: /\b(?:app|aplicaci[oó]n|configurar|enlazar|qr|emparejar|vincular|vincula|aplicacion)\b/i }
];

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
  {
    // Chilean RUT (con o sin puntos/guiones)
    type: 'rut',
    re: /\b(\d{1,2}(?:\.?\d{3}){2}\-?[\dkK]|\d{7,8}\-?[\dkK])\b/g,
    normalize: (_, g1) => {
      const clean = g1.replace(/[\s.-]/g, '').toUpperCase();
      const num = clean.slice(0, -1);
      const dv = clean.slice(-1);
      return `${num}-${dv}`;
    }
  },
  {
    // Comuna / Localidad
    type: 'comuna',
    re: /\b(?:comuna|despacho|direcci[oó]n|env[ií]o|envia|enviar|casa|st|servicio\s+t[eé]cnico)\s+(?:a|de|en)?\s*:?\s*([a-záéíóúñ\s]{3,30})\b/gi,
    normalize: (_, g1) => {
      const val = g1.replace(/\s+/g, ' ').trim().toLowerCase();
      // Si la palabra capturada está en la lista de comunas, capitalizarla bonito
      const found = COMUNAS_CHILE.find(c => c === val || c.replace(/[áéíóú]/g, 'a') === val);
      if (found) {
        return found.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }
      return g1.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
  }
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

  // Failure Keyword Detection
  for (const f of FAILURE_PATTERNS) {
    if (f.re.test(text)) {
      const key = `failure_keyword:${f.type}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ entity_type: 'failure_keyword', raw_value: f.type, normalized_value: f.type });
      }
    }
  }

  return results;
}

export { SOYMOMO_MODEL_RE };
