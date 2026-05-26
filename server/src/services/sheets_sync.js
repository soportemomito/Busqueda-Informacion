import { google } from 'googleapis';
import { resolveCredentials } from '../lib/resolveCredentials.js';

const SPREADSHEET_ID = '1nYvYZ65w7ZMXQd0eJZIF4qUh_T92qelJUY1GeIY7fiQ';

function makeAuth(creds) {
  const raw = creds.driveServiceAccountJson || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const credentials = JSON.parse(raw);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  } catch (err) {
    console.error('[sheets_sync] Error parsing JSON credentials:', err.message);
    return null;
  }
}

function parseDate(val) {
  if (!val) return null;
  // Handle DD/MM/YYYY or DD-MM-YYYY
  const dmy = String(val).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y.length === 2 ? '20' + y : y;
    const date = new Date(`${year}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
    return isNaN(date.getTime()) ? null : date.toISOString();
  }
  try {
    const date = new Date(val);
    return isNaN(date.getTime()) ? null : date.toISOString();
  } catch { return null; }
}

/**
 * Reads BOTH "Entradas" and "Salida" sheets, merges them by order_number, 
 * and upserts the consolidated records into service_orders in Supabase.
 * Returns { success: true, synced, skipped }.
 */
export async function syncServiceOrdersFromSheet(db) {
  const creds = await resolveCredentials(db);
  const auth = makeAuth(creds);
  if (!auth) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON / DRIVE_SERVICE_ACCOUNT_KEY no configurado');

  const sheets = google.sheets({ version: 'v4', auth });
  
  console.log('[sheets_sync] Iniciando consulta paralela de Entradas y Salidas...');
  
  const [entradasRes, salidasRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Entradas!B2:AF',
      valueRenderOption: 'UNFORMATTED_VALUE',
    }).catch(err => {
      console.error('[sheets_sync] Error consultando Entradas:', err.message);
      return { data: { values: [] } };
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Salida!B2:AF',
      valueRenderOption: 'UNFORMATTED_VALUE',
    }).catch(err => {
      console.error('[sheets_sync] Error consultando Salidas:', err.message);
      return { data: { values: [] } };
    })
  ]);

  const rawEntradas = entradasRes.data.values || [];
  const rawSalidas = salidasRes.data.values || [];
  
  console.log(`[sheets_sync] Filas obtenidas - Entradas: ${rawEntradas.length}, Salidas: ${rawSalidas.length}`);

  const ordersMap = new Map();
  let skipped = 0;

  // 1. Procesar Entradas (Check-in)
  // Rango B2:AF -> relativo a B (B=0):
  // Col B (0): Orden
  // Col C (1): Fecha (Check-in)
  // Col E (3): ID (IMEI/SIM)
  // Col F (4): Nombre
  // Col G (5): Correo
  // Col P (14): Observaciones (Check-in Notes)
  for (const row of rawEntradas) {
    const orderNumber = String(row[0] ?? '').trim();
    if (!orderNumber) { skipped++; continue; }

    ordersMap.set(orderNumber, {
      order_number: orderNumber,
      entry_date: parseDate(row[1]),
      imei_sim: String(row[3] ?? '').trim() || null,
      contact_name: String(row[4] ?? '').trim() || null,
      contact_email: String(row[5] ?? '').trim().toLowerCase() || null,
      check_in_notes: String(row[14] ?? '').trim() || null,
      status: 'received',
      sheet_row_url: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=1508216390`, // GID estimativo de Entradas o url del sheet
    });
  }

  // 2. Procesar Salidas (Check-out) y Consolidar
  // Rango B2:AF -> relativo a B (B=0):
  // Col B (0): Orden
  // Col C (1): Fecha Salida (Check-out)
  // Col D (2): ID (IMEI/SIM)
  // Col E (3): Nombre de Cliente
  // Col F (4): Correo
  // Col G (5): Observación (Resultado de la prueba)
  // Col R (16): Técnico
  // Col X (22): Solución
  // Col AF (30): Report URL
  for (const row of rawSalidas) {
    const orderNumber = String(row[0] ?? '').trim();
    if (!orderNumber) { skipped++; continue; }

    const reportUrl = String(row[30] ?? '').trim() || null;
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=0`;

    if (ordersMap.has(orderNumber)) {
      const existing = ordersMap.get(orderNumber);
      ordersMap.set(orderNumber, {
        ...existing,
        exit_date: parseDate(row[1]),
        check_out_notes: String(row[5] ?? '').trim() || null,
        technician: String(row[16] ?? '').trim() || null,
        solution: String(row[22] ?? '').trim() || null,
        report_url: reportUrl,
        status: 'completed',
      });
    } else {
      ordersMap.set(orderNumber, {
        order_number: orderNumber,
        exit_date: parseDate(row[1]),
        imei_sim: String(row[2] ?? '').trim() || null,
        contact_name: String(row[3] ?? '').trim() || null,
        contact_email: String(row[4] ?? '').trim().toLowerCase() || null,
        check_out_notes: String(row[5] ?? '').trim() || null,
        technician: String(row[16] ?? '').trim() || null,
        solution: String(row[22] ?? '').trim() || null,
        report_url: reportUrl,
        status: 'completed',
        sheet_row_url: sheetUrl,
      });
    }
  }

  const consolidatedOrders = [...ordersMap.values()];
  
  if (!consolidatedOrders.length) {
    return { success: true, synced: 0, skipped };
  }

  console.log(`[sheets_sync] Guardando ${consolidatedOrders.length} órdenes ST consolidadas en Supabase...`);

  const { error } = await db
    .from('service_orders')
    .upsert(consolidatedOrders, { onConflict: 'order_number', ignoreDuplicates: false });

  if (error) {
    console.error('[sheets_sync] Error upserting to Supabase:', error.message);
    throw error;
  }

  return { success: true, synced: consolidatedOrders.length, skipped };
}
