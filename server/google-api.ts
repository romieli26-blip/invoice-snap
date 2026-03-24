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

export async function createSheetTab(spreadsheetId: string, title: string): Promise<number | null> {
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

    // Add header row
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId,
      range: `'${title}'!A1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [["Date", "Description", "What For / Use", "Amount ($)", "Bought By", "Payment Method", "Last 4 Digits", "Submitted By", "Submitted At"]],
      },
    });

    console.log(`[google-api] Created sheet tab "${title}" (id: ${sheetId})`);
    return sheetId;
  } catch (err: any) {
    console.error(`[google-api] Failed to create sheet tab:`, err.message?.slice(0, 200));
    return null;
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
