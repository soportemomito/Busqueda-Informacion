import * as dotenv from 'dotenv';
dotenv.config();

import { searchBsale } from './src/services/bsale.js';
import { searchShopify } from './src/services/shopify.js';
import { buildSearchPlan } from './src/lib/searchPlan.js';
import { getSupabase } from './src/lib/supabase.js';
import { resolveCredentials } from './src/lib/resolveCredentials.js';

async function testFullCrossSearch() {
  const supabase = getSupabase();
  const creds = await resolveCredentials(supabase);

  // Datos extraídos por la IA del ticket 11325
  const email = "malfloluz@gmail.com";
  const rut = "16.399.092-k";
  const phone = "975394012";

  console.log(`[Cross Search] Iniciando búsqueda para email=${email}, rut=${rut}, phone=${phone}`);

  // 1. Buscar en Bsale (priorizamos RUT, y luego email)
  console.log('\n--- Buscando en Bsale ---');
  let bsalePlan = buildSearchPlan(rut);
  let bsR = await searchBsale(bsalePlan, creds);
  
  // Si no encuentra por RUT, buscamos por email
  if (!bsR || !bsR.clients || bsR.clients.length === 0) {
    console.log('No encontrado por RUT en Bsale. Buscando por email...');
    bsalePlan = buildSearchPlan(email);
    bsR = await searchBsale(bsalePlan, creds);
  }
  
  if (bsR && bsR.clients && bsR.clients.length > 0) {
    console.log(`[Bsale] ¡Cliente Encontrado!`);
    console.log(`Nombre: ${bsR.clients[0].firstName} ${bsR.clients[0].lastName}`);
    console.log(`Documentos: ${bsR.items ? bsR.items.length : 0} encontrados`);
    if (bsR.items && bsR.items.length > 0) {
        console.log(`Último Doc: ${bsR.items[0].documentType} #${bsR.items[0].documentNumber} - Total: $${bsR.items[0].totalAmount}`);
    }
  } else {
    console.log(`[Bsale] No se encontraron coincidencias.`);
  }

  // 2. Buscar en Shopify (priorizamos email y teléfono)
  console.log('\n--- Buscando en Shopify ---');
  let shPlan = buildSearchPlan(email);
  let shR = await searchShopify(shPlan, creds);

  if (shR && shR.customers && shR.customers.length > 0) {
    console.log(`[Shopify] ¡Cliente Encontrado por Email!`);
    console.log(`Nombre: ${shR.customers[0].firstName} ${shR.customers[0].lastName}`);
    console.log(`Total Gastado: $${shR.customers[0].totalSpent}`);
    console.log(`Pedidos: ${shR.orders ? shR.orders.length : 0} encontrados`);
    if (shR.orders && shR.orders.length > 0) {
        console.log(`Último Pedido: ${shR.orders[0].name} - Total: $${shR.orders[0].totalPrice}`);
    }
  } else {
    console.log(`[Shopify] No encontrado por Email. Buscando por Teléfono...`);
    shPlan = buildSearchPlan(phone);
    shR = await searchShopify(shPlan, creds);
    if (shR && shR.customers && shR.customers.length > 0) {
        console.log(`[Shopify] ¡Cliente Encontrado por Teléfono!`);
        console.log(`Nombre: ${shR.customers[0].firstName} ${shR.customers[0].lastName}`);
        console.log(`Pedidos: ${shR.orders ? shR.orders.length : 0} encontrados`);
    } else {
        console.log(`[Shopify] No se encontraron coincidencias.`);
    }
  }
}

testFullCrossSearch().catch(console.error);
