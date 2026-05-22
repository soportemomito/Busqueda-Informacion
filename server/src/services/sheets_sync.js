import { google } from 'googleapis';

const SPREADSHEET_ID = '1nYvYZ65w7ZMXQd0eJZIF4qUh_T92qelJUY1GeIY7fiQ';
const SHEET_NAME     = 'Salida';

// Column offsets relative to column B (range starts at B)
const COL_ORDER_NUMBER  = 0;  // B
const COL_FECHA_SALIDA  = 1;  // C
const COL_NOMBRE        = 3;  // E
const COL_EMAIL         = 4;  // F
const COL_REPORT_URL    = 30; // AF

function makeAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const credentials = JSON.parse(raw);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  } catch {
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
 * Reads the "Salida" sheet and upserts rows into service_orders in Supabase.
 * Returns { synced, skipped }.
 */
export async function syncServiceOrdersFromSheet(db) {
  const auth = makeAuth();
  if (!auth) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON no configurado');

  const sheets = google.sheets({ version: 'v4', auth });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!B2:AF`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = data.values || [];
  const orders = [];
  let skipped = 0;

  for (const row of rows) {
    const orderNumber = String(row[COL_ORDER_NUMBER] ?? '').trim();
    if (!orderNumber) { skipped++; continue; }

    orders.push({
      order_number:  orderNumber,
      received_at:   parseDate(row[COL_FECHA_SALIDA]),
      contact_name:  String(row[COL_NOMBRE]     ?? '').trim() || null,
      contact_email: String(row[COL_EMAIL]       ?? '').trim().toLowerCase() || null,
      report_url:    String(row[COL_REPORT_URL]  ?? '').trim() || null,
      status:        'completed',
    });
  }

  if (!orders.length) return { synced: 0, skipped };

  const { error } = await db
    .from('service_orders')
    .upsert(orders, { onConflict: 'order_number', ignoreDuplicates: false });

  if (error) throw error;
  return { synced: orders.length, skipped };
}
