import { google } from 'googleapis';

function escapeQueryLiteral(name) {
  return String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function getAuthFromJson(jsonStr) {
  if (!jsonStr || !String(jsonStr).trim()) return null;
  let key;
  try {
    key = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
  } catch {
    return null;
  }
  if (!key.client_email || !key.private_key) return null;
  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
}

/**
 * Busca evidencias ST bajo la carpeta padre:
 * 1) Subcarpeta cuyo nombre coincide exactamente con el código de orden.
 * 2) Si no hay carpeta: archivos sueltos en la carpeta padre cuyo nombre contiene el código
 *    (p. ej. informes tipo "Informe salida P10002" en la misma carpeta padre).
 *
 * @param {string[]} orderCodes ej. ["P-1024", "S99"]
 */
export async function searchDriveForStOrders(orderCodes, creds) {
  const parentId = creds.driveParentFolderId;
  const jsonKey = creds.driveServiceAccountJson;

  if (!parentId || !jsonKey) {
    return {
      skipped: true,
      reason: 'Drive no configurado (DRIVE_PARENT_FOLDER_ID / DRIVE_SERVICE_ACCOUNT_KEY)',
      folders: [],
    };
  }

  const auth = getAuthFromJson(jsonKey);
  if (!auth) {
    return { skipped: true, reason: 'DRIVE_SERVICE_ACCOUNT_KEY JSON inválido', folders: [] };
  }

  const drive = google.drive({ version: 'v3', auth });
  const uniqueOrders = [...new Set(orderCodes.map((o) => String(o).trim()).filter(Boolean))];
  const folders = [];

  function orderNameVariants(order) {
    const raw = String(order).trim();
    const noHyphen = raw.replace(/-/g, '');
    return [...new Set([raw, noHyphen, raw.toUpperCase(), noHyphen.toUpperCase()].filter(Boolean))];
  }

  async function listMatchingFilesInParent(order) {
    const variants = orderNameVariants(order);
    const clauses = variants
      .map((v) => {
        const safe = escapeQueryLiteral(v);
        return safe ? `name contains '${safe}'` : null;
      })
      .filter(Boolean);
    if (!clauses.length) return [];
    const q = `'${parentId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder' and (${clauses.join(' or ')})`;
    const res = await drive.files.list({
      q,
      fields: 'files(id, name, mimeType, webViewLink, modifiedTime, size)',
      pageSize: 50,
    });
    return res.data.files || [];
  }

  for (const order of uniqueOrders) {
    const safe = escapeQueryLiteral(order);
    const q = `'${parentId}' in parents and name = '${safe}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    try {
      const list = await drive.files.list({
        q,
        fields: 'files(id, name, modifiedTime)',
        pageSize: 5,
      });
      const hit = list.data.files?.[0];
      if (hit) {
        const fq = `'${hit.id}' in parents and trashed = false`;
        const filesRes = await drive.files.list({
          q: fq,
          fields: 'files(id, name, mimeType, webViewLink, modifiedTime, size)',
          pageSize: 100,
        });
        folders.push({
          order,
          folderId: hit.id,
          name: hit.name,
          modifiedTime: hit.modifiedTime,
          found: true,
          matchKind: 'subfolder',
          files: filesRes.data.files || [],
        });
        continue;
      }

      const looseFiles = await listMatchingFilesInParent(order);
      if (looseFiles.length) {
        const times = looseFiles.map((f) => f.modifiedTime).filter(Boolean).sort();
        const latest = times.length ? times[times.length - 1] : null;
        folders.push({
          order,
          folderId: null,
          name: looseFiles.length === 1 ? looseFiles[0].name : `${looseFiles.length} informes`,
          modifiedTime: latest,
          found: true,
          matchKind: 'files_in_parent',
          files: looseFiles,
        });
      } else {
        folders.push({ order, folderId: null, name: null, files: [], found: false });
      }
    } catch (e) {
      folders.push({
        order,
        folderId: null,
        error: e.message,
        files: [],
        found: false,
      });
    }
  }

  return { folders, skipped: false };
}
