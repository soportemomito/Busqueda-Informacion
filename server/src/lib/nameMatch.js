/**
 * Filtro estricto para búsqueda por nombre: evita que "Mora" matchee "Morales" o "Moraga".
 * Cada término significativo del texto buscado debe aparecer como palabra completa en el nombre.
 */

const NAME_STOPWORDS = new Set([
  'de',
  'del',
  'la',
  'las',
  'los',
  'y',
  'e',
  'san',
  'santa',
  'da',
  'do',
]);

export function normalizePersonName(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeDisplayName(s) {
  return normalizePersonName(s).split(/\s+/).filter(Boolean);
}

/**
 * Tokens que deben coincidir como palabra entera (sin prefijos sueltos).
 * Omite artículos/preposiciones comunes en apellidos compuestos.
 * @param {string} rawName
 * @returns {string[]}
 */
export function strictNameQueryTokens(rawName) {
  const tokens = tokenizeDisplayName(rawName);
  return tokens.filter((t) => t.length >= 2 && !NAME_STOPWORDS.has(t));
}

/**
 * @param {string} displayName nombre visible (nombre + apellidos, etc.)
 * @param {string[]} requiredTokens salida de strictNameQueryTokens
 */
export function nameMatchesStrictTokens(displayName, requiredTokens) {
  if (!requiredTokens?.length) return true;
  const nameTokens = new Set(tokenizeDisplayName(displayName));
  for (const t of requiredTokens) {
    if (!nameTokens.has(t)) return false;
  }
  return true;
}
