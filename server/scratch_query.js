import { extractEntities } from './src/services/extractor.js';

console.log('--- TEST 1: Maipú (Accented, NFC) ---');
console.log(extractEntities('comuna de maipú'));

console.log('--- TEST 2: Providencia ---');
console.log(extractEntities('despacho a providencia'));

console.log('--- TEST 3: False Positive (Nuestro Soporte Técnico) ---');
console.log(extractEntities('servicio técnico a nuestro soporte técnico'));

console.log('--- TEST 4: Accents strip check ---');
console.log(extractEntities('enviar a peñalolén'));
