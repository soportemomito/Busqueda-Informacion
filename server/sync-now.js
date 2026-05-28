import 'dotenv/config';
import { getSupabase } from './src/lib/supabase.js';
import { syncServiceOrdersFromSheet } from './src/services/sheets_sync.js';

async function main() {
  console.log('Sincronizando planilla de ST para actualizar entry_report_url...');
  try {
    const supabase = getSupabase();
    const res = await syncServiceOrdersFromSheet(supabase);
    console.log('Sincronización completa:', res);
  } catch (err) {
    console.error('Error:', err);
  }
}
main();
