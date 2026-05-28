import * as dotenv from 'dotenv';
dotenv.config();

import { analyzeSearchQuery } from './src/services/gemini.js';
import { buildAiSearchPlan } from './src/lib/searchPlan.js';

async function testSearch() {
  const query = "El cliente Luz Maldonado Flores compro un reloj rut 16.399.092-k y su correo es malfloluz@gmail.com";
  console.log(`[Test Search] Query: "${query}"`);
  
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("No hay GEMINI_API_KEY");
    return;
  }

  console.log('-> Llamando a Gemini...');
  const start = Date.now();
  const aiData = await analyzeSearchQuery(query, apiKey);
  console.log(`-> Gemini tardó ${Date.now() - start}ms`);
  
  console.log('--- Datos Crudos de IA ---');
  console.log(JSON.stringify(aiData, null, 2));

  console.log('\n--- Plan Generado (Backend) ---');
  const plan = buildAiSearchPlan(query, aiData);
  console.log(JSON.stringify(plan, null, 2));
}

testSearch().catch(console.error);
