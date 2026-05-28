import * as dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { fetchConversationMessages } from './src/services/chatwoot.js';
import { generateGeminiSummaryAndFacts } from './src/services/gemini.js';
import { resolveCredentials } from './src/lib/resolveCredentials.js';
import { getSupabase } from './src/lib/supabase.js';

async function testTicket() {
  const conversationId = 11325;
  console.log(`[Test] Iniciando prueba con el ticket ${conversationId}...`);
  
  try {
    const supabase = getSupabase();
    const creds = await resolveCredentials(supabase);
    
    if (!creds.chatwootBaseUrl || !creds.chatwootApiToken) {
      console.error('Faltan credenciales de Chatwoot');
      return;
    }
    
    const client = axios.create({
      baseURL: creds.chatwootBaseUrl,
      headers: {
        api_access_token: creds.chatwootApiToken,
        'Content-Type': 'application/json',
      },
    });

    const accountId = creds.chatwootAccountId || '1';
    
    console.log(`[Test] Intentando obtener detalle directo de Chatwoot para ID 11325...`);
    try {
      const { data } = await client.get(`/api/v1/accounts/${accountId}/conversations/11325`);
      console.log('Conversación encontrada:', data.payload?.id || data?.id);
      const msgs = await fetchConversationMessages(client, accountId, data.payload?.id || data?.id || 11325);
      console.log(`Mensajes obtenidos: ${msgs?.length}`);
      if (msgs && msgs.length > 0) {
        const result = await generateGeminiSummaryAndFacts(msgs, 'Cliente Prueba', creds, null);
        console.dir(result, { depth: null, colors: true });
      }
    } catch(err) {
      console.error('[Test Error Directo]', err.response?.status, err.response?.data || err.message);
    }

    
  } catch (err) {
    console.error('[Test Error]:', err.message);
  }
}

testTicket();
