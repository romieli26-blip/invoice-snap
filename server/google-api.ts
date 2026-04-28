/**
 * Google Sheets & Drive API integration using OAuth2 credentials.
 * 
 * Requires these env vars on Railway:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 * 
 * Falls back to callExternalTool (Perplexity sandbox) if not configured.
 */
import { google } from "googleapis";
import fs from "fs";

let sheetsApi: ReturnType<typeof google.sheets> | null = null;
let driveApi: ReturnType<typeof google.drive> | null = null;

function getAuth() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) return null;

  try {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return oauth2Client;
  } catch (err: any) {
    console.error("[google-api] Failed to create OAuth2 client:", err.message);
    return null;
  }
}

export function initGoogleApis(): boolean {
  const auth = getAuth();
  if (!auth) {
    console.log("[google-api] No OAuth2 credentials configured, Google sync disabled");
    console.log("[google-api] GOOGLE_CLIENT_ID:", process.env.GOOGLE_CLIENT_ID ? "SET" : "MISSING");
    console.log("[google-api] GOOGLE_CLIENT_SECRET:", process.env.GOOGLE_CLIENT_SECRET ? "SET" : "MISSING");
    console.log("[google-api] GOOGLE_REFRESH_TOKEN:", process.env.GOOGLE_REFRESH_TOKEN ? "SET" : "MISSING");
    return false;
  }

  sheetsApi = google.sheets({ version: "v4", auth });
  driveApi = google.drive({ version: "v3", auth });
  console.log("[google-api] OAuth2 initialized — Sheets & Drive enabled");
  return true;
}

export function isGoogleEnabled(): boolean {
  return sheetsApi !== null && driveApi !== null;
}

// ---- SHEETS ----

export async function createSheetTab(spreadsheetId: string, title: string, headers?: string[]): Promise<number | null> {
  if (!sheetsApi) return null;
  try {
    const res = await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }],
      },
    });
    const sheetId = res.data.replies?.[0]?.addSheet?.properties?.sheetId;
    if (sheetId == null) return null;

    // Add header row (use custom headers or default receipt headers)
    const headerRow = headers || ["Date", "Description", "What For / Use", "Amount ($)", "Bought By", "Payment Method", "Last 4 Digits", "Submitted By", "Submitted At", "Receipt Identification", "RM Service Issue #", "Receipt Type", "Edit History"];
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId,
      range: `'${title}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [headerRow] },
    });

    console.log(`[google-api] Created sheet tab "${title}" (id: ${sheetId})`);
    return sheetId;
  } catch (err: any) {
    // Tab already exists - not an error
    if (err.message?.includes("already exists")) return -1;
    console.error(`[google-api] Failed to create sheet tab:`, err.message?.slice(0, 200));
    return null;
  }
}

export async function renameSheetTab(spreadsheetId: string, oldTitle: string, newTitle: string): Promise<boolean> {
  if (!sheetsApi) return false;
  try {
    // First find the sheet ID by title
    const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets?.find(s => s.properties?.title === oldTitle);
    if (!sheet?.properties?.sheetId) {
      console.log(`[google-api] Sheet tab "${oldTitle}" not found, skipping rename`);
      return false;
    }
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: sheet.properties.sheetId, title: newTitle },
            fields: "title",
          },
        }],
      },
    });
    console.log(`[google-api] Renamed sheet tab "${oldTitle}" to "${newTitle}"`);
    return true;
  } catch (err: any) {
    console.error(`[google-api] Failed to rename sheet tab:`, err.message?.slice(0, 200));
    return false;
  }
}

export async function prependNoteToTab(spreadsheetId: string, tabTitle: string, note: string): Promise<boolean> {
  if (!sheetsApi) return false;
  try {
    // Insert a row at the top with the note
    const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets?.find(s => s.properties?.title === tabTitle);
    if (!sheet?.properties?.sheetId) return false;
    // Insert row at position 0
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          insertDimension: {
            range: { sheetId: sheet.properties.sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
          },
        }],
      },
    });
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabTitle}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [[note]] },
    });
    return true;
  } catch (err: any) {
    console.error(`[google-api] Failed to prepend note:`, err.message?.slice(0, 200));
    return false;
  }
}

export async function createSpreadsheetInFolder(title: string, folderId: string): Promise<string | null> {
  if (!sheetsApi || !driveApi) return null;
  try {
    const res = await sheetsApi.spreadsheets.create({
      requestBody: { properties: { title } },
    });
    const spreadsheetId = res.data.spreadsheetId!;
    // Move to the specified folder
    const file = await driveApi.files.get({ fileId: spreadsheetId, fields: "parents" });
    const prevParents = (file.data.parents || []).join(",");
    await driveApi.files.update({
      fileId: spreadsheetId,
      addParents: folderId,
      removeParents: prevParents,
      fields: "id, parents",
    });
    console.log(`[google-api] Created spreadsheet "${title}" in folder ${folderId}`);
    return spreadsheetId;
  } catch (err: any) {
    console.error(`[google-api] Failed to create spreadsheet:`, err.message?.slice(0, 200));
    return null;
  }
}

export async function updateSheetRange(spreadsheetId: string, range: string, values: string[][]): Promise<boolean> {
  if (!sheetsApi) return false;
  try {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values },
    });
    return true;
  } catch (err: any) {
    console.error(`[google-api] Failed to update range:`, err.message?.slice(0, 200));
    return false;
  }
}

export async function clearSheet(spreadsheetId: string, range: string): Promise<boolean> {
  if (!sheetsApi) return false;
  try {
    await sheetsApi.spreadsheets.values.clear({
      spreadsheetId,
      range,
      requestBody: {},
    });
    return true;
  } catch (err: any) {
    console.error(`[google-api] Failed to clear range:`, err.message?.slice(0, 200));
    return false;
  }
}

export async function shareFolderWithEmail(folderId: string, email: string): Promise<boolean> {
  if (!driveApi) return false;
  try {
    await driveApi.permissions.create({
      fileId: folderId,
      requestBody: { type: "user", role: "reader", emailAddress: email },
      sendNotificationEmail: false,
    });
    console.log(`[google-api] Shared folder ${folderId} with ${email}`);
    return true;
  } catch (err: any) {
    // Already shared or other error
    if (err.message?.includes("already has access")) return true;
    console.error(`[google-api] Failed to share folder:`, err.message?.slice(0, 200));
    return false;
  }
}

export async function appendSheetRow(
  spreadsheetId: string,
  tabName: string,
  row: string[]
): Promise<boolean> {
  if (!sheetsApi) return false;
  try {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId,
      range: `'${tabName}'!A1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [row],
      },
    });
    console.log(`[google-api] Row appended to "${tabName}"`);
    return true;
  } catch (err: any) {
    console.error(`[google-api] Failed to append row:`, err.message?.slice(0, 200));
    return false;
  }
}

/**
 * Delete a row from a sheet by searching for a matching value in the first column (date)
 * combined with other identifying fields.
 */
export async function deleteSheetRow(
  spreadsheetId: string,
  tabName: string,
  purchaseDate: string,
  description: string,
  amount: string
): Promise<boolean> {
  if (!sheetsApi) return false;
  try {
    const range = `'${tabName}'!A:I`;
    const res = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range });
    const rows = res.data.values;
    if (!rows) return false;

    // Find the row index (1-based in Sheets) matching date + description + amount
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row[0] === purchaseDate && row[1] === description && row[3] === amount) {
        // Delete this row using batchUpdate
        // First we need the sheet ID
        const sheetMeta = await sheetsApi.spreadsheets.get({
          spreadsheetId,
          fields: "sheets.properties",
        });
        const sheet = sheetMeta.data.sheets?.find(s => s.properties?.title === tabName);
        if (!sheet?.properties?.sheetId) return false;

        await sheetsApi.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{
              deleteDimension: {
                range: {
                  sheetId: sheet.properties.sheetId,
                  dimension: "ROWS",
                  startIndex: i,
                  endIndex: i + 1,
                },
              },
            }],
          },
        });
        console.log(`[google-api] Deleted row ${i + 1} from "${tabName}"`);
        return true;
      }
    }
    console.log(`[google-api] No matching row found in "${tabName}" to delete`);
    return false;
  } catch (err: any) {
    console.error(`[google-api] Failed to delete sheet row:`, err.message?.slice(0, 200));
    return false;
  }
}

/**
 * Delete a file from Drive by searching for it by name.
 */
export async function deleteFromDrive(fileName: string): Promise<boolean> {
  if (!driveApi) return false;
  try {
    const safeName = fileName.replace(/'/g, "\\'");
    const search = await driveApi.files.list({
      q: `name='${safeName}' and trashed=false`,
      fields: "files(id, name)",
      spaces: "drive",
    });

    if (!search.data.files || search.data.files.length === 0) {
      console.log(`[google-api] File not found on Drive: ${fileName}`);
      return false;
    }

    await driveApi.files.delete({ fileId: search.data.files[0].id! });
    console.log(`[google-api] Deleted from Drive: ${fileName}`);
    return true;
  } catch (err: any) {
    console.error(`[google-api] Drive delete failed:`, err.message?.slice(0, 200));
    return false;
  }
}

/**
 * Highlight the last row in a sheet tab with a background color.
 * color: { red, green, blue } each 0-1
 */
export async function highlightLastRow(
  spreadsheetId: string,
  tabName: string,
  color: { red: number; green: number; blue: number }
): Promise<void> {
  if (!sheetsApi) return;
  try {
    // Get sheet ID and row count
    const meta = await sheetsApi.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
    const sheet = meta.data.sheets?.find(s => s.properties?.title === tabName);
    if (!sheet?.properties?.sheetId) return;
    const sheetId = sheet.properties.sheetId;

    // Get the number of rows with data
    const range = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!A:A` });
    const rowCount = range.data.values?.length || 1;

    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId, startRowIndex: rowCount - 1, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: 20 },
            cell: { userEnteredFormat: { backgroundColor: { red: color.red, green: color.green, blue: color.blue } } },
            fields: "userEnteredFormat.backgroundColor",
          },
        }],
      },
    });
  } catch (err: any) {
    console.error(`[google-api] Highlight failed:`, err.message?.slice(0, 100));
  }
}

// ---- DRIVE ----

export async function uploadToDrive(
  filePath: string,
  fileName: string,
  folderId?: string
): Promise<boolean> {
  if (!driveApi) return false;
  try {
    const mimeType = filePath.endsWith(".png") ? "image/png" : "image/jpeg";
    const media = {
      mimeType,
      body: fs.createReadStream(filePath),
    };
    const fileMetadata: any = { name: fileName };
    if (folderId) {
      fileMetadata.parents = [folderId];
    }

    const res = await driveApi.files.create({
      requestBody: fileMetadata,
      media,
      fields: "id, name",
    });

    console.log(`[google-api] Uploaded to Drive: ${res.data.name} (id: ${res.data.id})`);
    return true;
  } catch (err: any) {
    console.error(`[google-api] Drive upload failed:`, err.message?.slice(0, 200));
    return false;
  }
}

/**
 * Ensure a folder exists in Drive. Returns the folder ID.
 * If parentFolderId is provided, looks/creates inside that folder.
 */
export async function ensureDriveFolder(
  folderName: string,
  parentFolderId?: string
): Promise<string | null> {
  if (!driveApi) return null;
  try {
    // Search for existing folder
    let query = `name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    if (parentFolderId) {
      query += ` and '${parentFolderId}' in parents`;
    }

    const search = await driveApi.files.list({
      q: query,
      fields: "files(id, name)",
      spaces: "drive",
    });

    if (search.data.files && search.data.files.length > 0) {
      return search.data.files[0].id!;
    }

    // Create folder
    const fileMetadata: any = {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
    };
    if (parentFolderId) {
      fileMetadata.parents = [parentFolderId];
    }

    const folder = await driveApi.files.create({
      requestBody: fileMetadata,
      fields: "id",
    });

    console.log(`[google-api] Created Drive folder "${folderName}" (id: ${folder.data.id})`);
    return folder.data.id!;
  } catch (err: any) {
    console.error(`[google-api] Failed to ensure folder:`, err.message?.slice(0, 200));
    return null;
  }
}

/**
 * Rename a Drive folder. Returns the folder ID if found and renamed (or already named correctly), null otherwise.
 */
export async function renameDriveFolder(
  oldName: string,
  newName: string
): Promise<string | null> {
  if (!driveApi) return null;
  try {
    const search = await driveApi.files.list({
      q: `name='${oldName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id, name)",
      spaces: "drive",
    });
    if (!search.data.files || search.data.files.length === 0) {
      return null;
    }
    const folder = search.data.files[0];
    await driveApi.files.update({
      fileId: folder.id!,
      requestBody: { name: newName },
    });
    console.log(`[google-api] Renamed Drive folder "${oldName}" -> "${newName}" (id: ${folder.id})`);
    return folder.id!;
  } catch (err: any) {
    console.error(`[google-api] Failed to rename folder "${oldName}":`, err.message?.slice(0, 200));
    return null;
  }
}

/**
 * Get a public-ish web view link for a Drive folder by name. Returns null if not found.
 */
/**
 * Hide a sheet tab in a Google Sheet (sets properties.hidden = true).
 * Returns true if hidden, false if the tab wasn't found or call failed.
 */
export async function hideSheetTab(spreadsheetId: string, tabTitle: string): Promise<boolean> {
  if (!sheetsApi) return false;
  try {
    const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets?.find(s => s.properties?.title === tabTitle);
    if (!sheet?.properties?.sheetId) {
      console.log(`[google-api] Sheet tab "${tabTitle}" not found, cannot hide`);
      return false;
    }
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: sheet.properties.sheetId, hidden: true },
            fields: "hidden",
          },
        }],
      },
    });
    console.log(`[google-api] Hid sheet tab "${tabTitle}"`);
    return true;
  } catch (err: any) {
    console.error(`[google-api] Failed to hide tab "${tabTitle}":`, err.message?.slice(0, 200));
    return false;
  }
}

/**
 * Show a previously hidden sheet tab again (sets properties.hidden = false).
 */
export async function unhideSheetTab(spreadsheetId: string, tabTitle: string): Promise<boolean> {
  if (!sheetsApi) return false;
  try {
    const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets?.find(s => s.properties?.title === tabTitle);
    if (!sheet?.properties?.sheetId) return false;
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: sheet.properties.sheetId, hidden: false },
            fields: "hidden",
          },
        }],
      },
    });
    return true;
  } catch (err: any) {
    console.error(`[google-api] Failed to unhide tab "${tabTitle}":`, err.message?.slice(0, 200));
    return false;
  }
}

/**
 * Permanently delete a sheet tab. Returns true if deleted, false if not found.
 */
export async function deleteSheetTab(spreadsheetId: string, tabTitle: string): Promise<boolean> {
  if (!sheetsApi) return false;
  try {
    const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets?.find(s => s.properties?.title === tabTitle);
    if (!sheet?.properties?.sheetId) {
      console.log(`[google-api] Sheet tab "${tabTitle}" not found, nothing to delete`);
      return false;
    }
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          deleteSheet: { sheetId: sheet.properties.sheetId },
        }],
      },
    });
    console.log(`[google-api] Deleted sheet tab "${tabTitle}"`);
    return true;
  } catch (err: any) {
    console.error(`[google-api] Failed to delete tab "${tabTitle}":`, err.message?.slice(0, 200));
    return false;
  }
}

export async function getDriveFolderWebViewLink(folderName: string): Promise<string | null> {
  if (!driveApi) return null;
  try {
    const search = await driveApi.files.list({
      q: `name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id, name, webViewLink)",
      spaces: "drive",
    });
    if (!search.data.files || search.data.files.length === 0) return null;
    const f = search.data.files[0];
    return f.webViewLink || (f.id ? `https://drive.google.com/drive/folders/${f.id}` : null);
  } catch (err: any) {
    console.error(`[google-api] Failed to get folder link:`, err.message?.slice(0, 200));
    return null;
  }
}
