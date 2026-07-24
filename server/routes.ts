import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { loginSchema, invoiceFormSchema, DEFAULT_PROPERTIES } from "@shared/schema";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import pdfParse from "pdf-parse";
import { initGoogleApis, isGoogleEnabled, appendSheetRow, createSheetTab, uploadToDrive, ensureDriveFolder, driveFolderExists, deleteSheetRow, deleteFromDrive, highlightLastRow, renameSheetTab, prependNoteToTab, createSpreadsheetInFolder, updateSheetRange, clearSheet, shareFolderWithEmail, renameDriveFolder, getDriveFolderWebViewLink, hideSheetTab, unhideSheetTab, deleteSheetTab, listDriveFolderChildren, moveDriveFile, trashDriveFile } from "./google-api";
// nodemailer removed — using Gmail API instead (SMTP blocked on Railway)

// Ensure uploads directory exists
// Use DATA_DIR for persistent storage on Railway
const dataDir = process.env.DATA_DIR || ".";
const uploadsDir = path.resolve(dataDir, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ---- Google Sheets config ----
const SHEETS_CONFIG_PATH = path.resolve(process.cwd(), "sheets-config.json");
let sheetsConfig: { spreadsheetId: string; spreadsheetUrl?: string; tabs: Record<string, number> } | null = null;

// Cash transactions sheets config
const CASH_SHEETS_CONFIG_PATH = path.resolve(process.cwd(), "cash-sheets-config.json");
let cashSheetsConfig: { spreadsheetId: string; tabs: Record<string, number> } | null = null;
try {
  if (fs.existsSync(CASH_SHEETS_CONFIG_PATH)) {
    cashSheetsConfig = JSON.parse(fs.readFileSync(CASH_SHEETS_CONFIG_PATH, "utf-8"));
    console.log(`[cash-sheets] Config loaded: spreadsheet ${cashSheetsConfig!.spreadsheetId}`);
  }
} catch {}

// Check transactions sheets config (separate spreadsheet from cash). Same
// schema — one tab per property.
const CHECK_SHEETS_CONFIG_PATH = path.resolve(process.cwd(), "check-sheets-config.json");
let checkSheetsConfig: { spreadsheetId: string; tabs: Record<string, number> } | null = null;
try {
  if (fs.existsSync(CHECK_SHEETS_CONFIG_PATH)) {
    checkSheetsConfig = JSON.parse(fs.readFileSync(CHECK_SHEETS_CONFIG_PATH, "utf-8"));
    console.log(`[check-sheets] Config loaded: spreadsheet ${checkSheetsConfig!.spreadsheetId}`);
  }
} catch {}
try {
  if (fs.existsSync(SHEETS_CONFIG_PATH)) {
    sheetsConfig = JSON.parse(fs.readFileSync(SHEETS_CONFIG_PATH, "utf-8"));
    console.log(`[sheets] Config loaded: spreadsheet ${sheetsConfig!.spreadsheetId}`);
  }
} catch (e) {
  console.error("[sheets] Failed to load config:", e);
}

function saveSheetsConfig() {
  if (!sheetsConfig) return;
  fs.writeFileSync(SHEETS_CONFIG_PATH, JSON.stringify(sheetsConfig, null, 2));
}

// ---- Email notifications ----
// Email via Gmail API (SMTP is blocked on Railway)
import { google } from "googleapis";

// Send to all admins who have receiveTransactionEmails enabled
async function sendTransactionNotificationEmails(subject: string, htmlBody: string, attachments?: { filename: string; path: string }[]) {
  const allUsers = await storage.getAllUsers();
  const recipients = allUsers
    .filter((u: any) => isAdminRole(u.role) && u.receiveTransactionEmails && u.email)
    .map((u: any) => ({ name: u.displayName, email: u.email }));

  if (recipients.length === 0) {
    console.log("[email] No admins subscribed to transaction emails, skipping");
    return;
  }

  await sendEmailToRecipients(recipients, subject, htmlBody, attachments);
}

// Send to specific list of recipients
async function sendEmailToRecipients(recipients: { name: string; email: string }[], subject: string, htmlBody: string, attachments?: { filename: string; path: string }[]) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    console.log("[email] No Google OAuth credentials, skipping email");
    return;
  }

  try {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    for (const recipient of recipients) {
      try {
        // Build MIME message
        const boundary = "boundary_" + Date.now();
        // RFC 2047 encode the Subject so non-ASCII characters (em dashes, accents,
        // emoji) render correctly in every mail client. Without this, Gmail's web
        // UI shows the raw bytes as mojibake (e.g. "\u2014" → "\u00c3\u00a2\u00e2\u201a\u00ac\u00e2\u20ac\u017d").
        const encodedSubject = /[^\x20-\x7e]/.test(subject)
          ? `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`
          : subject;
        let mime = [
          `To: ${recipient.name} <${recipient.email}>`,
          `From: "Jetsetter Reporting" <jetsetterinvoices1@gmail.com>`,
          `Subject: ${encodedSubject}`,
          `MIME-Version: 1.0`,
        ];

        if (attachments && attachments.length > 0) {
          mime.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "");
          mime.push(`--${boundary}`);
          mime.push(`Content-Type: text/html; charset="UTF-8"`, "", htmlBody, "");
          for (const att of attachments) {
            if (fs.existsSync(att.path)) {
              const fileData = fs.readFileSync(att.path).toString("base64");
              const ext = path.extname(att.filename).slice(1).toLowerCase() || "jpg";
              let mimeType: string;
              if (ext === "pdf") mimeType = "application/pdf";
              else if (ext === "html" || ext === "htm") mimeType = "text/html";
              else if (ext === "mp4") mimeType = "video/mp4";
              else if (ext === "mov") mimeType = "video/quicktime";
              else if (ext === "webm") mimeType = "video/webm";
              else if (ext === "m4v") mimeType = "video/x-m4v";
              else mimeType = `image/${ext}`;
              mime.push(`--${boundary}`);
              mime.push(`Content-Type: ${mimeType}; name="${att.filename}"`);
              mime.push(`Content-Disposition: attachment; filename="${att.filename}"`);
              mime.push(`Content-Transfer-Encoding: base64`, "", fileData, "");
            }
          }
          mime.push(`--${boundary}--`);
        } else {
          mime.push(`Content-Type: text/html; charset="UTF-8"`, "", htmlBody);
        }

        const raw = Buffer.from(mime.join("\r\n")).toString("base64url");
        await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
        console.log(`[email] Sent to ${recipient.email}`);
      } catch (err: any) {
        console.error(`[email] Failed to send to ${recipient.email}:`, err.message?.slice(0, 200));
      }
    }
  } catch (err: any) {
    console.error("[email] Gmail API error:", err.message?.slice(0, 200));
  }
}

// Backward compat wrapper — old name still used by some callers
async function sendNotificationEmails(subject: string, htmlBody: string, attachments?: { filename: string; path: string }[]) {
  await sendTransactionNotificationEmails(subject, htmlBody, attachments);
}

// ---- Tutorial video helper ----
// Downloads the welcome-tutorial video from Google Drive once, caches it under /tmp,
// and returns { path, sizeBytes } so the welcome email can attach it.
// Returns null if download fails or the file is too large to attach (>20MB).
const TUTORIAL_VIDEO_DRIVE_ID = "1L2SFfyKK19vpJxuJs99VrIMtywF7ox76";
const TUTORIAL_VIDEO_CACHE_PATH = "/tmp/jetsetter-tutorial.mp4";
const MAX_EMAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB safe limit for Gmail (hard cap is 25 MB)

async function getTutorialVideoAttachment(): Promise<{ path: string; filename: string } | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    console.log("[tutorial-video] No Google OAuth credentials");
    return null;
  }

  // Use cached copy if present and reasonably sized
  if (fs.existsSync(TUTORIAL_VIDEO_CACHE_PATH)) {
    const stat = fs.statSync(TUTORIAL_VIDEO_CACHE_PATH);
    if (stat.size > 0 && stat.size <= MAX_EMAIL_ATTACHMENT_BYTES) {
      return { path: TUTORIAL_VIDEO_CACHE_PATH, filename: "jetsetter-tutorial.mp4" };
    }
    if (stat.size > MAX_EMAIL_ATTACHMENT_BYTES) {
      console.log(`[tutorial-video] Cached file is ${(stat.size/1024/1024).toFixed(1)}MB — too large to attach`);
      return null;
    }
  }

  try {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    // Check size first to avoid wasting bandwidth
    const meta = await drive.files.get({
      fileId: TUTORIAL_VIDEO_DRIVE_ID,
      fields: "id,name,size,mimeType",
    });
    const sizeBytes = parseInt((meta.data.size as string) || "0", 10);
    console.log(`[tutorial-video] Drive file: ${meta.data.name}, size ${(sizeBytes/1024/1024).toFixed(2)}MB`);
    if (sizeBytes === 0 || sizeBytes > MAX_EMAIL_ATTACHMENT_BYTES) {
      console.log("[tutorial-video] Too large to attach — falling back to link");
      return null;
    }

    // Download to cache
    const dest = fs.createWriteStream(TUTORIAL_VIDEO_CACHE_PATH);
    const r = await drive.files.get(
      { fileId: TUTORIAL_VIDEO_DRIVE_ID, alt: "media" },
      { responseType: "stream" }
    );
    await new Promise<void>((resolve, reject) => {
      (r.data as any).on("end", () => resolve()).on("error", reject).pipe(dest);
    });
    const finalStat = fs.statSync(TUTORIAL_VIDEO_CACHE_PATH);
    console.log(`[tutorial-video] Cached ${(finalStat.size/1024/1024).toFixed(2)}MB to ${TUTORIAL_VIDEO_CACHE_PATH}`);
    if (finalStat.size > MAX_EMAIL_ATTACHMENT_BYTES) return null;
    return { path: TUTORIAL_VIDEO_CACHE_PATH, filename: "jetsetter-tutorial.mp4" };
  } catch (err: any) {
    console.error("[tutorial-video] Download failed:", err.message?.slice(0, 200));
    return null;
  }
}

function callExternalTool(sourceId: string, toolName: string, args: Record<string, any>) {
  try {
    const params = JSON.stringify({ source_id: sourceId, tool_name: toolName, arguments: args });
    const result = execSync(
      `external-tool call '${params.replace(/'/g, "'\\''")}'`,
      { timeout: 30000 }
    ).toString();
    return JSON.parse(result);
  } catch (err: any) {
    // external-tool CLI only exists in Perplexity environment; gracefully skip on Railway/other hosts
    console.warn(`[external-tool] Not available or failed: ${err.message?.slice(0, 100)}`);
    return null;
  }
}

async function createSheetsTab(propertyName: string): Promise<number | null> {
  if (!sheetsConfig) return null;

  // Try Google API first (works on Railway)
  if (isGoogleEnabled()) {
    const tabId = await createSheetTab(sheetsConfig.spreadsheetId, propertyName);
    if (tabId != null) {
      sheetsConfig.tabs[propertyName] = tabId;
      saveSheetsConfig();
      return tabId;
    }
    return null;
  }

  // Fallback to external-tool CLI (Perplexity sandbox)
  try {
    const createResult = callExternalTool("google_sheets__pipedream", "google_sheets-create-worksheet", {
      sheetId: sheetsConfig.spreadsheetId,
      title: propertyName,
    });
    const tabId = createResult?.replies?.[0]?.addSheet?.properties?.sheetId;
    if (!tabId) {
      console.error("[sheets] Failed to get tab ID from create response");
      return null;
    }

    callExternalTool("google_sheets__pipedream", "google_sheets-add-multiple-rows", {
      sheetId: sheetsConfig.spreadsheetId,
      worksheetId: tabId,
      rows: JSON.stringify([["Date", "Description", "What For / Use", "Amount ($)", "Bought By", "Payment Method", "Last 4 Digits", "Submitted By", "Submitted At"]]),
    });

    sheetsConfig.tabs[propertyName] = tabId;
    saveSheetsConfig();
    console.log(`[sheets] Created tab "${propertyName}" (id: ${tabId})`);
    return tabId;
  } catch (err: any) {
    console.error(`[sheets] Failed to create tab:`, err.message?.slice(0, 200));
    return null;
  }
}

async function syncToSheets(invoice: any, submittedByName: string): Promise<boolean> {
  if (!sheetsConfig) return false;
  const tabName = invoice.property;
  if (!sheetsConfig.tabs[tabName]) {
    console.error(`[sheets] No tab for property: ${tabName}`);
    return false;
  }

  // Column J = "Receipt Identification". Prefer the new property-prefixed code
  // (e.g. "TE-7"); fall back to the legacy numeric record number for rows that
  // pre-date the property-code feature.
  const receiptId = invoice.propertyCode || String(invoice.recordNumber || "");
  const row = [
    invoice.purchaseDate, invoice.description, invoice.purpose, invoice.amount,
    invoice.boughtBy, invoice.paymentMethod === "cc" ? "Credit Card" : "Cash",
    invoice.lastFourDigits || "", submittedByName, invoice.createdAt,
    receiptId, invoice.rentManagerIssue || "",
    invoice.receiptType || "expense",
  ];

  // Try Google API first (works on Railway)
  if (isGoogleEnabled()) {
    return await appendSheetRow(sheetsConfig.spreadsheetId, tabName, row);
  }

  // Fallback to external-tool CLI (Perplexity sandbox)
  try {
    const result = callExternalTool("google_sheets__pipedream", "google_sheets-add-multiple-rows", {
      sheetId: sheetsConfig!.spreadsheetId,
      worksheetId: sheetsConfig.tabs[tabName],
      rows: `[${JSON.stringify(row)}]`,
    });
    if (result?.updatedRows) {
      console.log(`[sheets] Row added to ${tabName}`);
      return true;
    }
    return false;
  } catch (err: any) {
    console.error(`[sheets] Sync failed:`, err.message?.slice(0, 200));
    return false;
  }
}



const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `invoice-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "application/pdf", "image/heic", "image/heif", "image/webp"];
    // Also allow if mimetype starts with image/ (some phones send non-standard types)
    cb(null, allowed.includes(file.mimetype) || file.mimetype.startsWith("image/"));
  },
});

/**
 * Sniff the first bytes of a file to detect its real type, regardless of what
 * extension the client sent. Returns a normalized extension string (e.g. "pdf",
 * "jpg", "png", "heic", "webp") or null if unrecognized.
 *
 * Why this exists: iOS share-sheets and "Save as image" flows sometimes send
 * a PDF with a `.jpg` filename. The browser's <img> tag can't render PDFs,
 * so we'd display a broken-image icon. We rewrite the saved filename to use
 * the correct extension based on actual bytes.
 */
function sniffFileExt(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    // PDF: %PDF-
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "pdf";
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
    // WebP: "RIFF" .... "WEBP"
    if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "webp";
    // HEIC / HEIF: bytes 4..11 contain "ftyp" followed by major brand (heic, heix, mif1, msf1, hevc)
    if (buf.slice(4, 8).toString("ascii") === "ftyp") {
      const brand = buf.slice(8, 12).toString("ascii");
      if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
    }
    // GIF
    if (buf.slice(0, 6).toString("ascii") === "GIF87a" || buf.slice(0, 6).toString("ascii") === "GIF89a") return "gif";
    return null;
  } catch {
    return null;
  }
}

/**
 * After-upload middleware: if the saved filename's extension doesn't match the
 * actual file content, rename the file on disk and patch req.file so downstream
 * handlers see the corrected path/filename.
 */
function fixUploadedExtension(req: any, _res: any, next: any) {
  const file = req.file;
  if (!file) return next();
  const fullPath = path.resolve(uploadsDir, file.filename);
  if (!fs.existsSync(fullPath)) return next();
  const realExt = sniffFileExt(fullPath);
  if (!realExt) return next(); // unknown -> leave as-is
  const currentExt = path.extname(file.filename).slice(1).toLowerCase();
  // Treat jpg/jpeg as the same.
  const norm = (e: string) => (e === "jpeg" ? "jpg" : e);
  if (norm(currentExt) === norm(realExt)) return next();
  const base = path.basename(file.filename, path.extname(file.filename));
  const newName = `${base}.${realExt}`;
  const newPath = path.resolve(uploadsDir, newName);
  try {
    fs.renameSync(fullPath, newPath);
    file.filename = newName;
    file.path = newPath;
    file.mimetype =
      realExt === "pdf" ? "application/pdf" :
      realExt === "png" ? "image/png" :
      realExt === "webp" ? "image/webp" :
      realExt === "heic" ? "image/heic" :
      realExt === "gif" ? "image/gif" :
      "image/jpeg";
    console.log(`[upload] Fixed extension: "${currentExt}" -> "${realExt}" for ${newName}`);
  } catch (e: any) {
    console.error(`[upload] Failed to rename ${file.filename}:`, e.message?.slice(0, 100));
  }
  next();
}

// Session tracking via SQLite-backed storage (survives server restarts)
function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

async function getSession(req: Request) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  return (await storage.getSession(token)) || null;
}

async function requireAuth(req: Request, res: Response): Promise<{ userId: number; role: string } | null> {
  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  // Belt-and-suspenders archive enforcement: even if a stale Bearer token is
  // still floating around (e.g. archived user hadn't logged out), reject every
  // request. Client sees 403 and force-logs-out via the react-query default
  // handler. Also proactively purge their sessions so the token can't be reused.
  const u = await storage.getUser(session.userId);
  if (!u || (u as any).archived) {
    if (u) {
      try { await storage.deleteSessionsForUser(session.userId); } catch {}
    }
    res.status(403).json({ error: "Account archived", archived: true });
    return null;
  }
  return session;
}

function validatePassword(password: string): string | null {
  if (password.length < 6) return "Password must be at least 6 characters.";
  if (!/[A-Z]/.test(password)) return "Password must contain at least one uppercase letter.";
  if (!/[a-z]/.test(password)) return "Password must contain at least one lowercase letter.";
  if (!/[0-9]/.test(password)) return "Password must contain at least one number.";
  if (!/[!@#$%^&*]/.test(password)) return "Password must contain at least one special character (!@#$%^&*).";
  return null;
}

// Update the Document Tracking spreadsheet in User Documents folder
async function updateDocTrackingSheet() {
  if (!isGoogleEnabled()) return;
  try {
    const configPath = path.resolve(dataDir, "doc-tracking-config.json");
    let config: { spreadsheetId: string; folderId: string } | null = null;
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }

    // Ensure the User Documents folder exists
    const userDocsFolder = await ensureDriveFolder("User Documents");
    if (!userDocsFolder) return;

    // Create spreadsheet if it doesn't exist
    if (!config?.spreadsheetId) {
      const ssId = await createSpreadsheetInFolder("Document Tracking", userDocsFolder);
      if (!ssId) return;
      config = { spreadsheetId: ssId, folderId: userDocsFolder };
      fs.writeFileSync(configPath, JSON.stringify(config));
    }

    // Get all users and their documents
    const allUsers = await storage.getAllUsers();
    const rows: string[][] = [
      ["User", "Role", "Email", "Photo ID", "Photo ID Date", "Banking", "Banking Date", "W-9", "W-9 Date", "All Complete", "Admin Approved", "Reminder Enabled", "Reminder Frequency", "Last Updated"],
    ];

    for (const u of allUsers) {
      if (u.role === "admin" || u.role === "super_admin") continue; // Skip admins
      const docs = await storage.getUserDocuments(u.id);
      const photoId = docs.find((d: any) => d.docType === "photo_id");
      const banking = docs.find((d: any) => d.docType === "banking");
      const w9 = docs.find((d: any) => d.docType === "w9");
      const allUploaded = !!(photoId && banking && w9);

      rows.push([
        u.displayName,
        u.role,
        (u as any).email || "N/A",
        photoId ? "\u2705 Uploaded" : "\u274c Missing",
        photoId ? new Date(photoId.createdAt).toLocaleDateString() : "",
        banking ? "\u2705 Uploaded" : "\u274c Missing",
        banking ? new Date(banking.createdAt).toLocaleDateString() : "",
        w9 ? "\u2705 Uploaded" : "\u274c Missing",
        w9 ? new Date(w9.createdAt).toLocaleDateString() : "",
        allUploaded ? "\u2705 Yes" : "\u274c No",
        (u as any).docsComplete ? "\u2705 Approved" : "Pending",
        (u as any).docReminderEnabled ? `Every ${(u as any).docReminderDays || 3} days` : "Disabled",
        (u as any).docReminderDays ? `${(u as any).docReminderDays} days` : "3 days",
        new Date().toLocaleString(),
      ]);
    }

    // Standalone contractors (non-login) tracked in `contractor_documents`. They
    // don't have a user_id, so we group rows by full name + email.
    try {
      const allContractorDocs = await storage.getAllContractorDocuments();
      // group key: lowercased "firstname|lastname|email"
      const groups = new Map<string, {
        firstName: string;
        lastName: string;
        email: string;
        docs: any[];
      }>();
      for (const d of allContractorDocs as any[]) {
        const fn = (d.contractorFirstName || "").trim();
        const ln = (d.contractorLastName || "").trim();
        const em = (d.contractorEmail || "").trim();
        const key = `${fn.toLowerCase()}|${ln.toLowerCase()}|${em.toLowerCase()}`;
        const existing = groups.get(key);
        if (existing) {
          existing.docs.push(d);
        } else {
          groups.set(key, { firstName: fn, lastName: ln, email: em, docs: [d] });
        }
      }
      for (const g of groups.values()) {
        const photoId = g.docs.find((d: any) => d.docType === "photo_id");
        const banking = g.docs.find((d: any) => d.docType === "banking");
        const w9 = g.docs.find((d: any) => d.docType === "w9");
        const allUploaded = !!(photoId && banking && w9);
        const fullName = `${g.firstName} ${g.lastName}`.trim() || "(unnamed contractor)";
        rows.push([
          fullName,
          "contractor (no login)",
          g.email || "N/A",
          photoId ? "\u2705 Uploaded" : "\u274c Missing",
          photoId ? new Date(photoId.createdAt).toLocaleDateString() : "",
          banking ? "\u2705 Uploaded" : "\u274c Missing",
          banking ? new Date(banking.createdAt).toLocaleDateString() : "",
          w9 ? "\u2705 Uploaded" : "\u274c Missing",
          w9 ? new Date(w9.createdAt).toLocaleDateString() : "",
          allUploaded ? "\u2705 Yes" : "\u274c No",
          "N/A",            // Admin Approved — not applicable to non-login contractors
          "N/A",            // Reminder Enabled — no account to remind
          "N/A",            // Reminder Frequency
          new Date().toLocaleString(),
        ]);
      }
    } catch (e) {
      console.error("[doc-tracking] Failed to add standalone contractors:", e);
    }

    // Clear and rewrite the sheet
    await clearSheet(config.spreadsheetId, "Sheet1!A:Z");
    await updateSheetRange(config.spreadsheetId, "Sheet1!A1", rows);
    console.log(`[doc-tracking] Updated spreadsheet with ${rows.length - 1} entries (users + standalone contractors)`);
  } catch (e) {
    console.error("[doc-tracking] Failed to update:", e);
  }
}

function isAdminRole(role: string): boolean {
  return role === "admin" || role === "super_admin";
}

async function requireAdmin(req: Request, res: Response): Promise<{ userId: number; role: string } | null> {
  const session = await requireAuth(req, res);
  if (!session) return null;
  if (!isAdminRole(session.role)) {
    res.status(403).json({ error: "Admin access required" });
    return null;
  }
  return session;
}

// Main folder ID cache (set after first lookup/creation)
let mainFolderId: string | null = null;
const propertyFolderCache = new Map<string, string>();

// Persistent Drive folder map. Stored on disk so the receipt root folder is
// remembered across restarts — prevents the app from creating a duplicate
// "Credit Card and Cash Receipts" folder when the user renames the original
// one in Drive. Schema: { receiptsRootId: "<drive folder id>" }
const DRIVE_FOLDER_CONFIG_PATH = path.resolve(process.cwd(), "drive-folder-config.json");
let driveFolderConfig: { receiptsRootId?: string } = {};
try {
  if (fs.existsSync(DRIVE_FOLDER_CONFIG_PATH)) {
    driveFolderConfig = JSON.parse(fs.readFileSync(DRIVE_FOLDER_CONFIG_PATH, "utf-8"));
    console.log(`[drive-folders] Config loaded: receiptsRootId=${driveFolderConfig.receiptsRootId}`);
  }
} catch {}
function saveDriveFolderConfig() {
  try {
    fs.writeFileSync(DRIVE_FOLDER_CONFIG_PATH, JSON.stringify(driveFolderConfig, null, 2));
  } catch (e) { console.error("[drive-folders] Save failed:", e); }
}

// Resolve the single shared receipts root folder. If we already have its ID,
// verify it still exists in Drive (not trashed, not renamed elsewhere); if so
// we use it as-is regardless of its current display name. Otherwise we search
// by the canonical name, and if nothing is found we create it once.
async function getReceiptsRootFolderId(): Promise<string | null> {
  if (!isGoogleEnabled()) return null;
  // 1) Cached ID is still valid? Trust it even if the user renamed the folder.
  if (driveFolderConfig.receiptsRootId) {
    try {
      const ok = await driveFolderExists(driveFolderConfig.receiptsRootId);
      if (ok) return driveFolderConfig.receiptsRootId;
    } catch {}
    // ID stale (folder deleted/trashed) — fall through to discovery.
    driveFolderConfig.receiptsRootId = undefined;
  }
  // 2) Search by canonical name.
  let id = await ensureDriveFolder("Credit Card and Cash Receipts");
  if (id) {
    driveFolderConfig.receiptsRootId = id;
    saveDriveFolderConfig();
    return id;
  }
  return null;
}

async function syncToDrive(invoice: any): Promise<boolean> {
  const allPaths: string[] = invoice.photoPaths ? JSON.parse(invoice.photoPaths) : [invoice.photoPath];
  const safeDesc = (invoice.description || "receipt").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 40);

  // Try Google API first (works on Railway)
  if (isGoogleEnabled()) {
    try {
      // Folder structure: Credit Card and Cash Receipts > Credit Card Receipts > Property
      let ccReceiptsFolder = propertyFolderCache.get("__cc_receipts_root") || null;
      if (!ccReceiptsFolder) {
        const mainReceiptsFolder = await getReceiptsRootFolderId();
        if (mainReceiptsFolder) {
          ccReceiptsFolder = await ensureDriveFolder("Credit Card Receipts", mainReceiptsFolder);
          if (ccReceiptsFolder) propertyFolderCache.set("__cc_receipts_root", ccReceiptsFolder);
        }
      }
      let propertyFolderId = propertyFolderCache.get("cc_" + invoice.property) || null;
      if (!propertyFolderId && ccReceiptsFolder) {
        propertyFolderId = await ensureDriveFolder(invoice.property, ccReceiptsFolder);
        if (propertyFolderId) propertyFolderCache.set("cc_" + invoice.property, propertyFolderId);
      }
      // Append the per-property receipt code at the END of the filename so it's
      // searchable and visually grouped per property (e.g. "Trails End - 2026-03-24 ... TE-7.jpg").
      const codeSuffix = invoice.propertyCode ? ` ${invoice.propertyCode}` : "";
      for (let i = 0; i < allPaths.length; i++) {
        const p = allPaths[i];
        const filePath = path.resolve(dataDir, "uploads", p.replace(/^\/api\/uploads\//, ""));
        if (!fs.existsSync(filePath)) continue;
        const ext = path.extname(filePath).slice(1) || "jpg";
        const partSuffix = allPaths.length > 1 ? ` (${i + 1} of ${allPaths.length})` : "";
        const fileName = `${invoice.property} - ${invoice.purchaseDate} ${safeDesc}${partSuffix}${codeSuffix}.${ext}`;
        await uploadToDrive(filePath, fileName, propertyFolderId || ccReceiptsFolder || undefined);
      }
      return true;
    } catch (err: any) {
      console.error("[drive] Google API upload failed:", err.message?.slice(0, 200));
      return false;
    }
  }

  // Fallback to external-tool CLI (Perplexity sandbox)
  try {
    const filePath = path.resolve(dataDir, "uploads", invoice.photoPath.replace(/^\/api\/uploads\//, ""));
    if (!fs.existsSync(filePath)) return false;
    const ext = path.extname(filePath).slice(1) || "jpg";
    const codeSuffix = invoice.propertyCode ? ` ${invoice.propertyCode}` : "";
    const fileName = `${invoice.property} - ${invoice.purchaseDate} ${safeDesc}${codeSuffix}.${ext}`;
    const base64 = fs.readFileSync(filePath).toString("base64");
    callExternalTool("google_drive", "export_files", {
      file_urls: [`data:image/${ext};base64,${base64}`],
      file_names: [fileName],
    });
    console.log(`[drive] Uploaded: ${fileName}`);
    return true;
  } catch (err: any) {
    console.error("[drive] Upload failed:", err.message?.slice(0, 200));
    return false;
  }
}

// RFC 2047 encode a mail Subject header when it contains any non-ASCII byte.
// Without this, characters like em-dash (—), accented letters, or emoji render
// as mojibake in Gmail's web UI (e.g. "—" → "Ã¢€”"). Pure-ASCII subjects are
// returned unchanged so the raw text stays human-readable in server logs.
function encodeMailSubject(subject: string): string {
  if (!/[^\x20-\x7e]/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Initialize Google APIs (service account for Railway, or fallback to external-tool)
  initGoogleApis();

  // ---- One-time Drive folder migration ----
  // Renames the four legacy daily-report folders to make it clear they are
  // archived. Ensures the new "Daily Reporting" folder exists.
  // Idempotent: if a legacy folder is already renamed, this no-ops.
  async function runDriveFolderMigration() {
    if (!isGoogleEnabled()) return;
    const legacyMap: [string, string][] = [
      ["Jetsetter Daily Reports", "Daily Reporting"], // upgrade interim folder to the canonical name
      ["Daily Transaction Summary", "Old - Daily Transaction Summary (legacy, not in use)"],
      ["Daily Work Report", "Old - Daily Work Report (legacy, not in use)"],
      ["Daily Reports", "Old - Daily Reports (legacy, not in use)"],
    ];
    for (const [oldName, newName] of legacyMap) {
      try {
        const renamed = await renameDriveFolder(oldName, newName);
        if (renamed) console.log(`[drive-migration] Renamed "${oldName}" -> "${newName}"`);
      } catch (e: any) {
        console.error(`[drive-migration] Skipped "${oldName}":`, e.message?.slice(0, 100));
      }
    }
    // Ensure the canonical folder exists & is shared with the company inbox
    try {
      const dailyFolderId = await ensureDriveFolder("Daily Reporting");
      if (dailyFolderId) {
        await shareFolderWithEmail(dailyFolderId, "jetsettercapitalllc@gmail.com");
        console.log(`[drive-migration] Active folder "Daily Reporting" id=${dailyFolderId}`);
      }
    } catch (e: any) {
      console.error(`[drive-migration] Failed to ensure Daily Reporting:`, e.message?.slice(0, 100));
    }
  }
  // Fire-and-forget: don't block server startup
  runDriveFolderMigration().catch(e => console.error("[drive-migration] Top-level error:", e));

  // Admin endpoint: run the migration on demand and return the public folder link
  app.post("/api/admin/drive-migration", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    if (!isGoogleEnabled()) {
      return res.status(503).json({ error: "Google APIs not configured on this server" });
    }
    await runDriveFolderMigration();
    const link = await getDriveFolderWebViewLink("Daily Reporting");
    res.json({ ok: true, folderName: "Daily Reporting", link });
  });

  app.get("/api/admin/daily-reporting-folder", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    if (!isGoogleEnabled()) {
      return res.json({ link: null, note: "Google APIs not configured" });
    }
    const link = await getDriveFolderWebViewLink("Daily Reporting");
    res.json({ folderName: "Daily Reporting", link });
  });

  // ---- One-shot heal: scan all uploaded files and fix wrong extensions ----
  // Renames `invoice-XXX.jpg` to `invoice-XXX.pdf` (or .png/.heic/etc) when the
  // file's actual content doesn't match its extension, and updates any DB rows
  // (invoices.photo_path / photo_paths and user/contractor doc paths) that
  // reference the renamed files. Idempotent.
  // Admin: assign property_code values to existing rows that don't have one yet.
  // Walks every property's invoices + cash transactions in date order and labels
  // them 1..N (or PREFIX-1..PREFIX-N if the property has a code). Idempotent:
  // rows that already have a property_code are left untouched.
  app.post("/api/admin/backfill-property-codes", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const dryRun = req.body?.dryRun === true;
    try {
      const updates = await storage.backfillPropertyCodes(dryRun);
      res.json({ ok: true, dryRun, updates: updates.length, sample: updates.slice(0, 20) });
    } catch (e: any) {
      console.error("[backfill] failed:", e);
      res.status(500).json({ error: e.message?.slice(0, 200) || "backfill failed" });
    }
  });

  // Admin: rewrite every per-property tab of the CC and cash spreadsheets
  // from the database, in chronological order. Replaces the existing data rows
  // (keeps row 1 headers) with the canonical state including the new
  // "Receipt Identification" property-code values. Run this AFTER backfilling
  // property codes so historical rows show TE-1, TE-2, ... instead of 1, 2, ...
  //
  // Body: { dryRun?: boolean, propertyName?: string } — propertyName limits to
  // one tab so you can test on a single property first.
  app.post("/api/admin/resync-sheets", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    if (!isGoogleEnabled()) return res.status(503).json({ error: "Google APIs not configured" });

    const dryRun = req.body?.dryRun === true;
    const onlyProperty: string | undefined = req.body?.propertyName;
    const summary: any[] = [];

    try {
      const allProps = await storage.getAllProperties();
      const targetProps = onlyProperty ? allProps.filter(p => p.name === onlyProperty) : allProps;

      const allUsers = await storage.getAllUsers();
      const userById = new Map(allUsers.map(u => [u.id, u.displayName]));

      // ---- CC invoices spreadsheet ----
      if (sheetsConfig) {
        const allInvoices = await storage.getAllInvoices();
        for (const prop of targetProps) {
          if (!sheetsConfig.tabs[prop.name]) continue;
          const propInvoices = allInvoices
            .filter(inv => inv.property === prop.name)
            .sort((a, b) => {
              if (a.purchaseDate !== b.purchaseDate) return a.purchaseDate < b.purchaseDate ? -1 : 1;
              return a.createdAt < b.createdAt ? -1 : 1;
            });

          const rows: string[][] = propInvoices.map(inv => {
            const submittedBy = userById.get(inv.userId) || "Unknown";
            const receiptId = (inv as any).propertyCode || String(inv.recordNumber || "");
            return [
              inv.purchaseDate,
              inv.description,
              inv.purpose,
              inv.amount,
              inv.boughtBy,
              inv.paymentMethod === "cc" ? "Credit Card" : "Cash",
              inv.lastFourDigits || "",
              submittedBy,
              inv.createdAt,
              receiptId,
              inv.rentManagerIssue || "",
              inv.receiptType || "expense",
            ];
          });

          summary.push({ sheet: "CC", tab: prop.name, rowsWritten: rows.length });
          if (!dryRun && rows.length > 0) {
            // Clear the data rows (keep header in row 1), then write fresh.
            await clearSheet(sheetsConfig.spreadsheetId, `${prop.name}!A2:L`);
            await updateSheetRange(sheetsConfig.spreadsheetId, `${prop.name}!A2`, rows);
          }
        }
      }

      // ---- Cash transactions spreadsheet ----
      if (cashSheetsConfig) {
        const allCash = await storage.getAllCashTransactions();
        for (const prop of targetProps) {
          if (!cashSheetsConfig.tabs[prop.name]) continue;
          const propCash = allCash
            .filter(tx => tx.property === prop.name)
            .sort((a, b) => {
              if (a.date !== b.date) return a.date < b.date ? -1 : 1;
              return a.createdAt < b.createdAt ? -1 : 1;
            });

          // Cash sheet column layout (12 cols, A..L), matching the per-row
          // append used in /api/cash-transactions:
          //   A Date  B Type  C Category  D Amount  E Unit/Lot  F Tenant/From
          //   G Bank  H Description/Notes  I Submitted By  J Submitted At
          //   K Receipt Identification  L Balance
          // Running balance is recomputed by chronological order.
          let runningBalance = 0;
          const rows: string[][] = [];
          for (const tx of propCash) {
            const submittedBy = userById.get(tx.userId) || "Unknown";
            const receiptId = (tx as any).propertyCode || String(tx.recordNumber || "");
            const amt = parseFloat(tx.amount || "0");
            runningBalance += tx.type === "income" ? amt : -amt;
            rows.push([
              tx.date,
              tx.type,
              tx.category,
              tx.amount,
              tx.unitLotNumber || "",
              tx.tenantName || (tx as any).payerName || "",
              tx.bankName || "",
              tx.description || (tx as any).notes || "",
              submittedBy,
              tx.createdAt,
              receiptId,
              runningBalance.toFixed(2),
            ]);
          }

          summary.push({ sheet: "Cash", tab: prop.name, rowsWritten: rows.length });
          if (!dryRun && rows.length > 0) {
            await clearSheet(cashSheetsConfig.spreadsheetId, `${prop.name}!A2:L`);
            await updateSheetRange(cashSheetsConfig.spreadsheetId, `${prop.name}!A2`, rows);
          }
        }
      }

      // ---- Check transactions spreadsheet ----
      // Checks live in their own dedicated sheet (checkSheetsConfig). Rebuild
      // per-property via the existing helper so undeposited/deposited state
      // and column layout stay in lockstep with the live-write path.
      if (checkSheetsConfig?.spreadsheetId && !dryRun) {
        for (const prop of targetProps) {
          try {
            const outcome = await rebuildCheckSheetForProperty(prop.name);
            summary.push({ sheet: "Check", tab: prop.name, ...outcome });
          } catch (e: any) {
            summary.push({ sheet: "Check", tab: prop.name, error: e.message?.slice(0, 120) });
          }
        }
      } else if (dryRun && checkSheetsConfig?.spreadsheetId) {
        // For dry-run we just count DB rows that WOULD be written per property.
        const allChecks = await storage.getAllCheckTransactions();
        for (const prop of targetProps) {
          const n = allChecks.filter(c => c.property === prop.name).length;
          summary.push({ sheet: "Check", tab: prop.name, rowsWritten: n });
        }
      }

      // Also flag the previously-unsynced rows as synced so /sync-status
      // reports a clean bill of health after a successful rebuild.
      if (!dryRun) {
        try {
          const allCash = await storage.getAllCashTransactions();
          for (const tx of allCash) {
            if (!tx.syncedToSheets) await storage.updateCashTransactionSyncStatus(tx.id, "sheets", true);
          }
          const allInv = await storage.getAllInvoices();
          for (const inv of allInv) {
            if (!inv.syncedToSheets) await storage.updateInvoiceSyncStatus(inv.id, "sheets", true);
          }
        } catch (e) { console.error("[resync-sheets] flag-synced cleanup failed:", e); }
      }

      res.json({ ok: true, dryRun, summary });
    } catch (e: any) {
      console.error("[resync-sheets] failed:", e);
      res.status(500).json({ error: e.message?.slice(0, 200) || "resync failed" });
    }
  });

  // Admin: at-a-glance sync-status. Returns, per property, how many rows in the
  // local DB haven't yet been mirrored to Google Sheets, plus a small sample of
  // the missed rows so admins can spot patterns (e.g. a whole property missing).
  // Used by the Sync Status panel in the Admin UI. Runs read-only — pair with
  // POST /api/admin/resync-sheets to actually repair the sheets.
  app.get("/api/admin/sync-status", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;

    try {
      const allProps = await storage.getAllProperties();
      const propNames = new Set(allProps.map(p => p.name));

      const allInvoices = await storage.getAllInvoices();
      const allCash = await storage.getAllCashTransactions();
      const allChecks = await storage.getAllCheckTransactions();

      const perProperty: Record<string, {
        invoicesUnsynced: number;
        cashUnsynced: number;
        checksUnsynced: number;
        totalRows: number;
      }> = {};
      for (const name of propNames) {
        perProperty[name] = { invoicesUnsynced: 0, cashUnsynced: 0, checksUnsynced: 0, totalRows: 0 };
      }

      const missedSamples: Array<{ kind: string; property: string; id: number; recordNumber: number | null; amount: string; date: string }> = [];
      const push = (kind: string, tx: any) => {
        if (missedSamples.length < 30) {
          missedSamples.push({
            kind,
            property: tx.property,
            id: tx.id,
            recordNumber: tx.recordNumber ?? null,
            amount: String(tx.amount ?? ""),
            date: tx.date || tx.purchaseDate || "",
          });
        }
      };

      for (const inv of allInvoices) {
        if (perProperty[inv.property]) perProperty[inv.property].totalRows += 1;
        if (!inv.syncedToSheets) {
          if (perProperty[inv.property]) perProperty[inv.property].invoicesUnsynced += 1;
          push("invoice", inv);
        }
      }
      for (const tx of allCash) {
        if (perProperty[tx.property]) perProperty[tx.property].totalRows += 1;
        if (!tx.syncedToSheets) {
          if (perProperty[tx.property]) perProperty[tx.property].cashUnsynced += 1;
          push("cash", tx);
        }
      }
      for (const tx of allChecks) {
        if (perProperty[tx.property]) perProperty[tx.property].totalRows += 1;
        if (!tx.syncedToSheets) {
          if (perProperty[tx.property]) perProperty[tx.property].checksUnsynced += 1;
          push("check", tx);
        }
      }

      const totalUnsynced = Object.values(perProperty).reduce(
        (n, p) => n + p.invoicesUnsynced + p.cashUnsynced + p.checksUnsynced, 0
      );

      res.json({
        totalUnsynced,
        perProperty,
        missedSamples,
        counts: {
          invoices: allInvoices.length,
          cash: allCash.length,
          checks: allChecks.length,
        },
      });
    } catch (e: any) {
      console.error("[sync-status] failed:", e);
      res.status(500).json({ error: e.message?.slice(0, 200) || "sync-status failed" });
    }
  });

  // Admin: audit every invoice's photo references. Returns a list of rows whose
  // photoPath / photoPaths point to file(s) that don't exist on disk, plus rows
  // with no photoPath at all. Useful for spotting missing receipts.
  app.get("/api/admin/audit-invoice-photos", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;

    const propertyFilter = (req.query.property as string) || "";
    const allInvoices = await storage.getAllInvoices();
    const issues: any[] = [];

    for (const inv of allInvoices) {
      if (propertyFilter && inv.property !== propertyFilter) continue;
      const paths: string[] = [];
      try {
        if (inv.photoPaths) {
          const arr = JSON.parse(inv.photoPaths);
          if (Array.isArray(arr)) for (const p of arr) if (typeof p === "string") paths.push(p);
        } else if (inv.photoPath) {
          paths.push(inv.photoPath);
        }
      } catch { /* ignore */ }

      const missing: string[] = [];
      for (const p of paths) {
        if (!p.startsWith("/api/uploads/")) continue;
        const fp = path.resolve(uploadsDir, p.slice("/api/uploads/".length));
        if (!fs.existsSync(fp)) missing.push(p);
      }

      if (paths.length === 0 || missing.length > 0) {
        issues.push({
          id: inv.id,
          property: inv.property,
          propertyCode: (inv as any).propertyCode || null,
          recordNumber: inv.recordNumber,
          purchaseDate: inv.purchaseDate,
          description: inv.description,
          amount: inv.amount,
          paymentMethod: inv.paymentMethod,
          submittedBy: inv.userId,
          allPaths: paths,
          missingPaths: missing,
          reason: paths.length === 0 ? "no_photo_path" : "file_not_on_disk",
        });
      }
    }

    res.json({ totalInvoices: allInvoices.length, issuesFound: issues.length, issues });
  });

  app.post("/api/admin/heal-photo-extensions", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const renames: { from: string; to: string }[] = [];
    const dbReconciled: { from: string; to: string; rows: number }[] = [];
    try {
      // ---- Pass 1: scan disk, rename files whose extension doesn't match content
      const files = fs.readdirSync(uploadsDir);
      for (const f of files) {
        const full = path.resolve(uploadsDir, f);
        if (!fs.statSync(full).isFile()) continue;
        const realExt = sniffFileExt(full);
        if (!realExt) continue;
        const currentExt = path.extname(f).slice(1).toLowerCase();
        const norm = (e: string) => (e === "jpeg" ? "jpg" : e);
        if (norm(currentExt) === norm(realExt)) continue;
        const base = path.basename(f, path.extname(f));
        const newName = `${base}.${realExt}`;
        const newPath = path.resolve(uploadsDir, newName);
        try {
          fs.renameSync(full, newPath);
          renames.push({ from: f, to: newName });
          console.log(`[heal] Renamed ${f} -> ${newName}`);
        } catch (e: any) {
          console.error(`[heal] Failed to rename ${f}:`, e.message?.slice(0, 100));
        }
      }
      let updatedRows = 0;
      for (const r of renames) {
        const oldPath = `/api/uploads/${r.from}`;
        const newPath = `/api/uploads/${r.to}`;
        const n = await (storage as any).rewriteUploadPath?.(oldPath, newPath);
        updatedRows += n || 0;
      }

      // ---- Pass 2: reconcile DB rows whose photoPath references a file that
      // no longer exists at that exact name, but a same-base file with a different
      // extension does exist on disk. Catches the case where the disk was already
      // renamed by an earlier run but the DB rewrite failed.
      const filesNow = new Set(fs.readdirSync(uploadsDir));
      const findRealName = (filename: string): string | null => {
        if (filesNow.has(filename)) return null; // exists -> nothing to do
        const base = path.basename(filename, path.extname(filename));
        for (const candidate of filesNow) {
          if (path.basename(candidate, path.extname(candidate)) === base) {
            return candidate;
          }
        }
        return null;
      };

      // Walk every photo-bearing DB row and try to repoint missing files
      const allInvoices = await storage.getAllInvoices();
      for (const inv of allInvoices) {
        if (inv.photoPath?.startsWith("/api/uploads/")) {
          const fname = inv.photoPath.slice("/api/uploads/".length);
          const real = findRealName(fname);
          if (real) {
            const oldPath = `/api/uploads/${fname}`;
            const newPath = `/api/uploads/${real}`;
            const n = await (storage as any).rewriteUploadPath?.(oldPath, newPath);
            if (n) dbReconciled.push({ from: fname, to: real, rows: n });
          }
        }
        // Same for photoPaths array
        if (inv.photoPaths) {
          try {
            const arr = JSON.parse(inv.photoPaths);
            if (Array.isArray(arr)) {
              for (const p of arr) {
                if (typeof p === "string" && p.startsWith("/api/uploads/")) {
                  const fname = p.slice("/api/uploads/".length);
                  const real = findRealName(fname);
                  if (real) {
                    const oldPath = `/api/uploads/${fname}`;
                    const newPath = `/api/uploads/${real}`;
                    const n = await (storage as any).rewriteUploadPath?.(oldPath, newPath);
                    if (n && !dbReconciled.find(d => d.from === fname)) {
                      dbReconciled.push({ from: fname, to: real, rows: n });
                    }
                  }
                }
              }
            }
          } catch { /* ignore malformed */ }
        }
      }
      const allCash = await storage.getAllCashTransactions();
      for (const tx of allCash) {
        if (tx.photoPath?.startsWith("/api/uploads/")) {
          const fname = tx.photoPath.slice("/api/uploads/".length);
          const real = findRealName(fname);
          if (real) {
            const oldPath = `/api/uploads/${fname}`;
            const newPath = `/api/uploads/${real}`;
            const n = await (storage as any).rewriteUploadPath?.(oldPath, newPath);
            if (n && !dbReconciled.find(d => d.from === fname)) {
              dbReconciled.push({ from: fname, to: real, rows: n });
            }
          }
        }
      }

      const reconciledRows = dbReconciled.reduce((s, d) => s + d.rows, 0);
      res.json({
        ok: true,
        renamed: renames.length,
        dbRowsUpdated: updatedRows,
        renames,
        dbReconciled: dbReconciled.length,
        dbReconciledRows: reconciledRows,
        reconciliations: dbReconciled.slice(0, 20),
      });
    } catch (e: any) {
      console.error("[heal] Failed:", e);
      res.status(500).json({ error: e.message?.slice(0, 200) || "heal failed" });
    }
  });

  // ---- One-time merge: move everything from "Contractor Documents" into "User Documents" ----
  // Idempotent: if the source folder is empty or already trashed, returns ok:true with 0 moves.
  // Skips any child whose name already exists at the destination, so re-running won't duplicate.
  app.post("/api/admin/merge-contractor-folder", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    if (!isGoogleEnabled()) return res.status(503).json({ error: "Google APIs not configured" });
    try {
      const sourceId = (req.body?.sourceFolderId as string) || "1H8GRnQ_DmH_lELtfNIGYC3D_dc3tX35_";
      const destFolderId = await ensureDriveFolder("User Documents");
      if (!destFolderId) return res.status(500).json({ error: "Could not resolve User Documents folder" });

      const [sourceChildren, destChildren] = await Promise.all([
        listDriveFolderChildren(sourceId),
        listDriveFolderChildren(destFolderId),
      ]);
      const destNames = new Set(destChildren.map(c => c.name.toLowerCase()));

      const moved: { id: string; name: string }[] = [];
      const skipped: { id: string; name: string; reason: string }[] = [];
      for (const child of sourceChildren) {
        if (destNames.has(child.name.toLowerCase())) {
          // A folder/file with that exact name already exists at the destination.
          // Skip to avoid silently merging unrelated content; the admin can resolve manually.
          skipped.push({ id: child.id, name: child.name, reason: "name already exists at destination" });
          continue;
        }
        const ok = await moveDriveFile(child.id, destFolderId);
        if (ok) moved.push({ id: child.id, name: child.name });
        else skipped.push({ id: child.id, name: child.name, reason: "move failed" });
      }

      // If the source folder is now empty, trash it (saves a click for the user).
      let sourceTrashed = false;
      if (skipped.length === 0) {
        const remaining = await listDriveFolderChildren(sourceId);
        if (remaining.length === 0) {
          sourceTrashed = await trashDriveFile(sourceId);
        }
      }

      // Refresh the doc-tracking spreadsheet so the new "contractor (no login)" rows appear.
      try { await updateDocTrackingSheet(); } catch (e) { console.error("[merge] Failed to refresh tracking sheet:", e); }

      const destLink = `https://drive.google.com/drive/folders/${destFolderId}`;
      res.json({
        ok: true,
        movedCount: moved.length,
        skippedCount: skipped.length,
        sourceTrashed,
        destFolder: { id: destFolderId, link: destLink, name: "User Documents" },
        moved,
        skipped,
      });
    } catch (e: any) {
      console.error("[merge-contractor-folder] failed:", e);
      res.status(500).json({ error: e.message?.slice(0, 200) || "merge failed" });
    }
  });

  // ---- Property Manager Playbook ----
  // Stable, admin-replaceable PDF served from the persistent data volume.
  // Path layout:
  //   {dataDir}/playbook.pdf          → the active file (always served as `playbook.pdf`)
  //   {dataDir}/playbook-versions/    → snapshots of every version we've ever served,
  //                                     so old welcome-email attachments are never broken
  const playbookActivePath = () => path.resolve(dataDir, "playbook.pdf");
  const playbookVersionsDir = () => path.resolve(dataDir, "playbook-versions");

  // Generic helpers for the other two role manuals (admin / contractor).
  // Each manual has an active path and a versioned snapshots dir, just like the playbook.
  const adminManualActivePath = () => path.resolve(dataDir, "admin-manual.pdf");
  const adminManualVersionsDir = () => path.resolve(dataDir, "admin-manual-versions");
  const contractorManualActivePath = () => path.resolve(dataDir, "contractor-manual.pdf");
  const contractorManualVersionsDir = () => path.resolve(dataDir, "contractor-manual-versions");

  // Pick the manual filename + path that matches a given role. Returns null if no
  // manual is available on disk yet for that role.
  function manualForRole(role: string): { filename: string; path: string } | null {
    let active: string, friendly: string;
    if (role === "manager") {
      active = playbookActivePath();
      friendly = "Property-Manager-Manual.pdf";
    } else if (role === "admin" || role === "super_admin") {
      active = adminManualActivePath();
      friendly = "Admin-Manual.pdf";
    } else if (role === "contractor") {
      active = contractorManualActivePath();
      friendly = "Contractor-Manual.pdf";
    } else {
      return null;
    }
    if (!fs.existsSync(active)) return null;
    return { filename: friendly, path: active };
  }

  function ensurePlaybookDirs() {
    const verDir = playbookVersionsDir();
    if (!fs.existsSync(verDir)) fs.mkdirSync(verDir, { recursive: true });
  }

  // Returns metadata about the currently-active playbook (or null if none uploaded yet).
  function getPlaybookInfo() {
    const p = playbookActivePath();
    if (!fs.existsSync(p)) return null;
    const stat = fs.statSync(p);
    return {
      filename: "Property-Manager-Playbook.pdf",
      sizeBytes: stat.size,
      sizeMB: +(stat.size / 1024 / 1024).toFixed(2),
      updatedAt: stat.mtime.toISOString(),
    };
  }

  // Anyone signed in (any role) can fetch metadata so the dashboard button knows
  // whether to render and what to show.
  app.get("/api/playbook/info", async (req, res) => {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: "Unauthorized" });
    res.json(getPlaybookInfo());
  });

  // Stream the active PDF. Supports Bearer header OR ?token= query param so the
  // browser's native PDF viewer / direct download can use a regular <a href>.
  app.get("/api/playbook/file", async (req, res) => {
    const tokenFromQuery = (req.query.token as string) || "";
    const headerAuth = req.headers.authorization || "";
    const tokenFromHeader = headerAuth.startsWith("Bearer ") ? headerAuth.slice(7) : "";
    const token = tokenFromQuery || tokenFromHeader;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const session = await storage.getSession(token);
    if (!session) return res.status(401).json({ error: "Unauthorized" });

    const p = playbookActivePath();
    if (!fs.existsSync(p)) return res.status(404).json({ error: "Playbook not uploaded yet" });

    const isDownload = req.query.download === "1" || req.query.download === "true";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${isDownload ? "attachment" : "inline"}; filename="Property-Manager-Playbook.pdf"`
    );
    res.sendFile(p);
  });

  // Admin: replace the playbook with a new PDF. Saves a snapshot under
  // {dataDir}/playbook-versions/playbook-{ISO}.pdf for audit & rollback.
  app.post("/api/admin/playbook", upload.single("playbook"), fixUploadedExtension, async (req: any, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // Verify it's actually a PDF (multer may have allowed image/* through)
    const realExt = sniffFileExt(req.file.path);
    if (realExt !== "pdf") {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: "File must be a PDF" });
    }

    ensurePlaybookDirs();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const versionPath = path.resolve(playbookVersionsDir(), `playbook-${stamp}.pdf`);

    try {
      // Copy the upload to BOTH the active path and a versioned snapshot.
      fs.copyFileSync(req.file.path, playbookActivePath());
      fs.copyFileSync(req.file.path, versionPath);
      try { fs.unlinkSync(req.file.path); } catch {}
      console.log(`[playbook] Replaced active. Snapshot: ${versionPath}`);
      res.json({ ok: true, info: getPlaybookInfo() });
    } catch (e: any) {
      console.error("[playbook] Failed to save:", e);
      res.status(500).json({ error: e.message?.slice(0, 200) || "failed to save" });
    }
  });

  // Admin: list version snapshots
  app.get("/api/admin/playbook/versions", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    ensurePlaybookDirs();
    const verDir = playbookVersionsDir();
    const files = fs.readdirSync(verDir)
      .filter(f => f.endsWith(".pdf"))
      .map(f => {
        const fp = path.resolve(verDir, f);
        const st = fs.statSync(fp);
        return { filename: f, sizeBytes: st.size, savedAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    res.json({ versions: files });
  });

  // ---- Generic manual upload (Admin Manual / Contractor Manual) ----
  // The PM Playbook keeps its existing endpoint above (used by the dashboard button).
  // These two endpoints power the welcome-email attachments for admin / contractor roles.
  async function handleManualUpload(
    req: any,
    res: any,
    activePathFn: () => string,
    versionsDirFn: () => string,
    logTag: string,
  ) {
    const session = await requireAdmin(req, res);
    if (!session) return;
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const realExt = sniffFileExt(req.file.path);
    if (realExt !== "pdf") {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: "File must be a PDF" });
    }
    const verDir = versionsDirFn();
    if (!fs.existsSync(verDir)) fs.mkdirSync(verDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const versionPath = path.resolve(verDir, `${logTag}-${stamp}.pdf`);
    try {
      fs.copyFileSync(req.file.path, activePathFn());
      fs.copyFileSync(req.file.path, versionPath);
      try { fs.unlinkSync(req.file.path); } catch {}
      const st = fs.statSync(activePathFn());
      console.log(`[${logTag}] Replaced active. Snapshot: ${versionPath}`);
      res.json({
        ok: true,
        info: {
          sizeBytes: st.size,
          sizeMB: +(st.size / 1024 / 1024).toFixed(2),
          updatedAt: st.mtime.toISOString(),
        },
      });
    } catch (e: any) {
      console.error(`[${logTag}] Failed to save:`, e);
      res.status(500).json({ error: e.message?.slice(0, 200) || "failed to save" });
    }
  }

  app.post("/api/admin/admin-manual", upload.single("manual"), fixUploadedExtension, async (req: any, res) =>
    handleManualUpload(req, res, adminManualActivePath, adminManualVersionsDir, "admin-manual"));

  app.post("/api/admin/contractor-manual", upload.single("manual"), fixUploadedExtension, async (req: any, res) =>
    handleManualUpload(req, res, contractorManualActivePath, contractorManualVersionsDir, "contractor-manual"));

  // Metadata endpoint so the admin panel can show which manuals are loaded.
  app.get("/api/admin/manuals-info", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    function infoFor(p: string) {
      if (!fs.existsSync(p)) return null;
      const st = fs.statSync(p);
      return {
        sizeBytes: st.size,
        sizeMB: +(st.size / 1024 / 1024).toFixed(2),
        updatedAt: st.mtime.toISOString(),
      };
    }
    res.json({
      playbook: infoFor(playbookActivePath()),       // PM
      adminManual: infoFor(adminManualActivePath()),
      contractorManual: infoFor(contractorManualActivePath()),
    });
  });

  // Serve uploaded files (supports both Bearer token and ?token= query param for <img> tags)
  app.use("/api/uploads", async (req, res, next) => {
    // Check Bearer header first
    let session = await getSession(req);
    // Fallback to query param token (needed for <img src="..."> which can't send headers)
    if (!session && req.query.token) {
      session = await storage.getSession(req.query.token as string) || null;
    }
    if (!session) return res.status(401).json({ error: "Unauthorized" });
    next();
  });
  app.use("/api/uploads", (await import("express")).default.static(uploadsDir));

  // ---- Seed default properties ----
  for (const propName of DEFAULT_PROPERTIES) {
    const existing = await storage.getPropertyByName(propName);
    if (!existing) {
      const tabId = sheetsConfig?.tabs[propName] || null;
      await storage.createProperty({ name: propName, sheetsTabId: tabId ?? undefined });
      console.log(`[seed] Property "${propName}" created (tab: ${tabId})`);
    }
  }

  // Seed admin user if none exists
  const existingAdmin = await storage.getUserByUsername("admin");
  if (!existingAdmin) {
    await storage.createUser({
      username: "admin",
      password: "admin123",
      displayName: "Admin",
      role: "admin",
    });
  }

  // Seed ben@jetsettercapital.com admin if none exists
  const existingBen = await storage.getUserByUsername("ben");
  if (!existingBen) {
    await storage.createUser({
      username: "ben",
      password: "ben2026",
      displayName: "Ben (Admin)",
      role: "admin",
    });
  }

  // Seed romieli26 test user if none exists
  const existingRomi = await storage.getUserByUsername("romi");
  if (!existingRomi) {
    await storage.createUser({
      username: "romi",
      password: "romi2026",
      displayName: "Romi (Testing)",
      role: "manager",
    });
  }

  // ---- FORGOT PASSWORD (public, no auth) ----
  // Shared helper: reset a user's password to a fresh random string and email
  // both the username and the temp password. Used by /api/forgot-password and
  // by /api/users/:id/unarchive so both flows behave identically — the admin
  // never sees the password and the user is expected to log in and change it
  // themselves via /api/me/password.
  //
  // Returns the temp password (only for logging) but callers should NOT expose
  // it to non-admin API responses.
  async function resetUserPasswordAndEmail(
    user: any,
    subject: string,
    intro: string,
    logPrefix: string,
  ): Promise<string> {
    const tempPassword = crypto.randomBytes(4).toString("hex");
    await storage.updateUser(user.id, { password: tempPassword });
    // Invalidate any active sessions — the user's next action must be a fresh
    // login with the temp password.
    try { await storage.deleteSessionsForUser(user.id); } catch {}

    if (!user.email) {
      console.log(`[${logPrefix}] User ${user.username} has no email on file — temp password NOT sent.`);
      return tempPassword;
    }

    try {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
      if (clientId && clientSecret && refreshToken) {
        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        const gmail = google.gmail({ version: "v1", auth: oauth2Client });

        const mime = [
          `To: ${user.displayName} <${user.email}>`,
          `From: "Jetsetter Reporting" <jetsetterinvoices1@gmail.com>`,
          `Subject: ${encodeMailSubject(subject)}`,
          `MIME-Version: 1.0`,
          `Content-Type: text/html; charset="UTF-8"`,
          ``,
          `<h3>Jetsetter Reporting — Login Details</h3>
           <p>Hi ${user.displayName},</p>
           <p>${intro}</p>
           <p><strong>Username:</strong> ${user.username}</p>
           <p><strong>Temporary Password:</strong> ${tempPassword}</p>
           <p>Sign in, then open the <strong>Change Password</strong> screen (key icon in the header) to set a password you'll remember. The temporary password will remain valid until you change it.</p>
           <p style="color:#888;font-size:12px;margin-top:16px;">— Jetsetter Reporting</p>`,
        ].join("\r\n");

        const raw = Buffer.from(mime).toString("base64url");
        await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
        console.log(`[${logPrefix}] Sent login details to ${user.email}`);
      }
    } catch (err: any) {
      console.error(`[${logPrefix}] Email failed:`, err.message?.slice(0, 200));
    }
    return tempPassword;
  }

  app.post("/api/forgot-password", async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const allUsers = await storage.getAllUsers();
    const user = allUsers.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());

    if (!user) {
      return res.json({ ok: true, message: "If an account with that email exists, login details have been sent." });
    }

    // Refuse to reset archived users — they can't log in anyway, and we don't
    // want to email them credentials that would immediately fail.
    if ((user as any).archived) {
      return res.json({ ok: true, message: "If an account with that email exists, login details have been sent." });
    }

    await resetUserPasswordAndEmail(
      user,
      "Jetsetter Reporting — Your Login Details",
      "You (or an admin on your behalf) asked us to recover your login. Here are your credentials:",
      "forgot-password",
    );

    res.json({ ok: true, message: "If an account with that email exists, login details have been sent." });
  });

  // Self-service password change. User must be signed in and provide their
  // current password. On success we do NOT invalidate the current session so
  // the user stays signed in on the device they used to change it.
  app.post("/api/me/password", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new passwords are required" });
    }
    // Same rules as the create-user validator (6+, upper, lower, number, special).
    const pwOk =
      typeof newPassword === "string" &&
      newPassword.length >= 6 &&
      /[A-Z]/.test(newPassword) &&
      /[a-z]/.test(newPassword) &&
      /[0-9]/.test(newPassword) &&
      /[^A-Za-z0-9]/.test(newPassword);
    if (!pwOk) {
      return res.status(400).json({
        error: "New password must be at least 6 characters and include an uppercase letter, a lowercase letter, a number, and a special character.",
      });
    }
    const user = await storage.getUser(session.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.password !== currentPassword) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: "New password must be different from your current password" });
    }
    await storage.updateUser(session.userId, { password: newPassword });
    // Kill every OTHER session belonging to this user (defensive — e.g. old
    // phone that still had a token). Current request's token stays valid.
    const currentToken = (req.headers.authorization || "").slice(7);
    try {
      await storage.deleteSessionsForUser(session.userId);
      await storage.createSession(currentToken, session.userId, session.role);
    } catch (e) { console.error("[change-password] session refresh failed:", e); }
    res.json({ ok: true });
  });

  // ---- AUTH ----
  app.post("/api/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid credentials" });

    const user = await storage.getUserByUsername(parsed.data.username);
    if (!user || user.password !== parsed.data.password) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    if ((user as any).archived) {
      return res.status(403).json({ error: "This account has been archived. Please contact your administrator." });
    }

    const token = generateToken();
    await storage.createSession(token, user.id, user.role);

    res.json({ token, user: {
      id: user.id, username: user.username, displayName: user.displayName, role: user.role,
      firstName: (user as any).firstName, lastName: (user as any).lastName,
      mileageRate: (user as any).mileageRate, allowOffSite: (user as any).allowOffSite,
      allowSpecialTerms: (user as any).allowSpecialTerms, specialTermsAmount: (user as any).specialTermsAmount,
      homeProperty: (user as any).homeProperty, baseRate: (user as any).baseRate, offSiteRate: (user as any).offSiteRate,
      positions: (user as any).positions || null,
      mustChangePassword: (user as any).mustChangePassword || 0,
    } });
  });

  // Super admin: impersonate any user
  app.post("/api/admin/impersonate/:id", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session || session.role !== "super_admin") {
      return res.status(403).json({ error: "Super admin access required" });
    }
    const targetId = parseInt(req.params.id);
    const targetUser = await storage.getUser(targetId);
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    const token = generateToken();
    await storage.createSession(token, targetUser.id, targetUser.role);
    res.json({ token, user: {
      id: targetUser.id, username: targetUser.username, displayName: targetUser.displayName, role: targetUser.role,
      firstName: (targetUser as any).firstName, lastName: (targetUser as any).lastName,
      mileageRate: (targetUser as any).mileageRate, allowOffSite: (targetUser as any).allowOffSite,
      allowSpecialTerms: (targetUser as any).allowSpecialTerms, specialTermsAmount: (targetUser as any).specialTermsAmount,
      homeProperty: (targetUser as any).homeProperty, baseRate: (targetUser as any).baseRate, offSiteRate: (targetUser as any).offSiteRate,
      positions: (targetUser as any).positions || null,
      mustChangePassword: (targetUser as any).mustChangePassword || 0,
    } });
  });

  app.post("/api/logout", async (req, res) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      await storage.deleteSession(auth.slice(7));
    }
    res.json({ ok: true });
  });

  app.get("/api/me", async (req, res) => {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: "Unauthorized" });
    const user = await storage.getUser(session.userId);
    if (!user) return res.status(401).json({ error: "User not found" });
    const myPropIds = await storage.getUserPropertyIds(session.userId);
    const allProps = await storage.getAllProperties();
    const myProps = allProps.filter(p => myPropIds.includes(p.id)).map(p => p.name);
    res.json({
      id: user.id, username: user.username, displayName: user.displayName, role: user.role,
      firstName: (user as any).firstName, lastName: (user as any).lastName,
      mileageRate: (user as any).mileageRate, allowOffSite: (user as any).allowOffSite,
      allowSpecialTerms: (user as any).allowSpecialTerms, specialTermsAmount: (user as any).specialTermsAmount,
      homeProperty: (user as any).homeProperty, baseRate: (user as any).baseRate, offSiteRate: (user as any).offSiteRate,
      positions: (user as any).positions || null,
      mustChangePassword: (user as any).mustChangePassword || 0,
      requireFinancialConfirm: (user as any).requireFinancialConfirm || 0,
      allowPastDates: (user as any).allowPastDates || 0,
      docsComplete: (user as any).docsComplete || 0,
      allowWorkCredits: (user as any).allowWorkCredits || 0,
      workCreditReport: (user as any).workCreditReport || 0,
      documentUploadReport: (user as any).documentUploadReport || 0,
      docReminderEnabled: (user as any).docReminderEnabled || 0,
      docReminderDays: (user as any).docReminderDays || 3,
      allowContractorDocs: (user as any).allowContractorDocs || 0,
      allowCreatingContractors: (user as any).allowCreatingContractors || 0,
      // allowMiles defaults to 1 — treat any non-zero (or null for legacy rows) as true.
      allowMiles: (user as any).allowMiles === 0 ? 0 : 1,
      dailyReminderEnabled: (user as any).dailyReminderEnabled || 0,
      allowFlatRate: (user as any).allowFlatRate || 0,
      showWorkReport: (user as any).showWorkReport || 0,
      showMyDocuments: (user as any).showMyDocuments || 0,
      showWorkCredit: (user as any).showWorkCredit || 0,
      showMyContractors: (user as any).showMyContractors || 0,
      assignedProperties: myProps,
    });
  });

  // ---- Change Password ----
  app.post("/api/change-password", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;

    const { currentPassword, newPassword } = req.body;
    const user = await storage.getUser(session.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.password !== currentPassword) {
      return res.status(400).json({ error: "Current password is incorrect." });
    }

    const pwError = validatePassword(newPassword);
    if (pwError) return res.status(400).json({ error: pwError });

    await storage.updateUser(session.userId, { password: newPassword, mustChangePassword: 0 } as any);
    res.json({ ok: true });
  });

  // ---- Update Profile ----
  app.post("/api/update-profile", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const { firstName, lastName } = req.body;
    const displayName = `${firstName} ${lastName}`;
    await storage.updateUser(session.userId, { firstName, lastName, displayName } as any);
    res.json({ ok: true });
  });

  // ---- USERS (admin only) ----
  app.get("/api/users", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const includeArchived = req.query.includeArchived === "1" || req.query.includeArchived === "true";
    const allUsersRaw = await storage.getAllUsers();
    const allUsers = includeArchived ? allUsersRaw : allUsersRaw.filter(u => !(u as any).archived);
    const allProps = await storage.getAllProperties();
    const propMap = new Map(allProps.map(p => [p.id, p.name]));
    const allUsersForNames = new Map(allUsers.map(u => [u.id, u.displayName]));

    const enriched = await Promise.all(allUsers.map(async u => {
      const propIds = await storage.getUserPropertyIds(u.id);
      return {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        email: u.email || "",
        dailyReport: u.dailyReport || 0,
        statementReports: (u as any).statementReports || 0,
        dailyTimeReport: (u as any).dailyTimeReport || 0,
        dailyTransactionReport: (u as any).dailyTransactionReport || 0,
        reconciliationReport: (u as any).reconciliationReport || 0,
        firstName: (u as any).firstName || "",
        lastName: (u as any).lastName || "",
        baseRate: (u as any).baseRate || "",
        offSiteRate: (u as any).offSiteRate || "",
        positions: (u as any).positions || "",
        homeProperty: (u as any).homeProperty || "",
        allowOffSite: (u as any).allowOffSite || 0,
        mileageRate: (u as any).mileageRate || "0.50",
        allowSpecialTerms: (u as any).allowSpecialTerms || 0,
        specialTermsAmount: (u as any).specialTermsAmount || "",
        w9OrW4: (u as any).w9OrW4 || "",
        docsComplete: (u as any).docsComplete || 0,
        requireFinancialConfirm: (u as any).requireFinancialConfirm || 0,
        allowPastDates: (u as any).allowPastDates || 0,
        receiveTransactionEmails: (u as any).receiveTransactionEmails || 0,
        allowWorkCredits: (u as any).allowWorkCredits || 0,
        workCreditReport: (u as any).workCreditReport || 0,
        documentUploadReport: (u as any).documentUploadReport || 0,
        docReminderEnabled: (u as any).docReminderEnabled || 0,
        docReminderDays: (u as any).docReminderDays || 3,
        allowContractorDocs: (u as any).allowContractorDocs || 0,
        allowCreatingContractors: (u as any).allowCreatingContractors || 0,
        allowMiles: (u as any).allowMiles === 0 ? 0 : 1,
        dailyReminderEnabled: (u as any).dailyReminderEnabled || 0,
        allowFlatRate: (u as any).allowFlatRate || 0,
        showWorkReport: (u as any).showWorkReport || 0,
        showMyDocuments: (u as any).showMyDocuments || 0,
        showWorkCredit: (u as any).showWorkCredit || 0,
        showMyContractors: (u as any).showMyContractors || 0,
        createdByUserId: (u as any).createdByUserId || null,
        createdByName: (u as any).createdByUserId ? (allUsersForNames.get((u as any).createdByUserId) || null) : null,
        assignedProperties: propIds.map(pid => propMap.get(pid)).filter(Boolean) as string[],
        archived: (u as any).archived || 0,
      };
    }));
    res.json(enriched);
  });

  app.post("/api/users", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;

    const { username, password, displayName, role, email,
      dailyTimeReport, dailyTransactionReport, reconciliationReport,
      homeProperty } = req.body;
    if (!username || !password || !displayName) {
      return res.status(400).json({ error: "Username, password, and display name are required" });
    }
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    if (email) {
      const allUsers = await storage.getAllUsers();
      const emailTaken = allUsers.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
      if (emailTaken) return res.status(409).json({ error: "This email address is already in use by another user." });
    }

    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });

    const existing = await storage.getUserByUsername(username);
    if (existing) return res.status(409).json({ error: "Username already taken" });

    const user = await storage.createUser({
      username,
      password,
      displayName,
      role: role || "manager",
      email: email || null,
      mustChangePassword: 1,
      dailyTimeReport: dailyTimeReport ? 1 : 0,
      dailyTransactionReport: dailyTransactionReport ? 1 : 0,
      reconciliationReport: reconciliationReport ? 1 : 0,
      homeProperty: homeProperty || null,
      w9OrW4: "w9",
      createdByUserId: session.userId,
    } as any);

    // Auto-assign home property if set
    if (homeProperty) {
      const allProps = await storage.getAllProperties();
      const homeProp = allProps.find(p => p.name === homeProperty);
      if (homeProp) {
        const existingPropIds = await storage.getUserPropertyIds(user.id);
        if (!existingPropIds.includes(homeProp.id)) {
          await storage.setUserProperties(user.id, [...existingPropIds, homeProp.id]);
        }
      }
    }

    res.json({ id: user.id, username: user.username, displayName: user.displayName, role: user.role, email: user.email });

    // Send welcome email to new user
    if (email) {
      setImmediate(async () => {
        try {
          const appUrl = "https://invoice-snap-production.up.railway.app";
          const videoUrl = "https://drive.google.com/file/d/1L2SFfyKK19vpJxuJs99VrIMtywF7ox76/view";

          // Try to attach the tutorial video directly so users don't need Drive access.
          const videoAttachment = await getTutorialVideoAttachment();
          const attachments: { filename: string; path: string }[] = [];
          if (videoAttachment) attachments.push(videoAttachment);

          // Attach the role-appropriate manual (Admin / Property Manager / Contractor)
          // if one has been uploaded. Each new user gets the latest version on disk
          // at the time their account is created.
          const manual = manualForRole(role);
          let manualAttached = false;
          let manualLabel = "";
          if (manual) {
            attachments.push(manual);
            manualAttached = true;
            if (role === "manager") manualLabel = "Property Manager Manual";
            else if (role === "contractor") manualLabel = "Contractor Manual";
            else manualLabel = "Admin Manual";
          }

          const tutorialBlock = videoAttachment
            ? `<p>The tutorial video is <b>attached to this email</b>. Open the attachment to watch it on any device.</p>
               <p style="color:#666;font-size:12px;">Can't see the attachment? You can also <a href="${videoUrl}" style="color:#01696F;">watch it online</a> (requires a Google account that has been granted access).</p>`
            : `<p>Watch this short video to learn how to install and use the app on your mobile device:</p>
               <p style="text-align:center;"><a href="${videoUrl}" style="display:inline-block;background:#01696F;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Watch Tutorial Video</a></p>
               <p style="color:#666;font-size:12px;text-align:center;">If the link asks for permission, contact your administrator to be added.</p>`;

          const playbookBlock = manualAttached
            ? `<h3 style="color:#01696F;">${manualLabel}</h3>
               <p>The <b>${manualLabel}</b> is attached to this email. It walks you through everything you need to know to get started.</p>
               ${role === "manager" ? `<p style="color:#666;font-size:12px;">You can also access the latest version any time from the <b>Property Manager Playbook</b> button at the top of your dashboard.</p>` : ""}`
            : "";

          await sendEmailToRecipients(
            [{ name: displayName, email }],
            `Welcome to Jetsetter Reporting`,
            `<html><body style="font-family:Arial;max-width:600px;margin:0 auto;">
              <div style="background:#01696F;padding:20px;text-align:center;">
                <h1 style="color:white;margin:0;">Welcome to Jetsetter Reporting</h1>
              </div>
              <div style="padding:20px;">
                <p>Hi ${displayName},</p>
                <p>You've been invited to use <b>Jetsetter Reporting</b> by your administrator. This is our company's reporting app for tracking receipts, cash transactions, time reporting, and documents.</p>
                <h3 style="color:#01696F;">Getting Started</h3>
                <p>1. <b>Open the app:</b> <a href="${appUrl}" style="color:#01696F;">${appUrl}</a></p>
                <p>2. <b>Log in</b> with your username: <b>${username}</b> and the password provided by your admin.</p>
                <p>3. On first login, you'll be asked to <b>change your password</b>.</p>
                <p>4. <b>Add the app to your home screen</b> for easy access — it works like a native app.</p>
                <h3 style="color:#01696F;">Watch the Tutorial</h3>
                ${tutorialBlock}
                ${playbookBlock}
                <p style="color:#888;font-size:12px;margin-top:30px;">If you have any questions, please contact your administrator.<br>- Jetsetter Reporting</p>
              </div>
            </body></html>`,
            attachments.length > 0 ? attachments : undefined
          );
          console.log(`[welcome] Sent welcome email to ${email} (role: ${role}, video attached: ${!!videoAttachment}, manual attached: ${manualAttached ? manualLabel : "none"})`);
        } catch (e) { console.error("[welcome] Failed to send welcome email:", e); }
      });
    }
  });

  // ---- Property Manager: Create Contractors ----
  // Requires allowCreatingContractors flag; creates a contractor auto-assigned to the PM's properties.
  app.post("/api/pm/contractors", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const pm = await storage.getUser(session.userId);
    if (!pm) return res.status(401).json({ error: "Unauthorized" });
    if (!isAdminRole(session.role) && !(pm as any).allowCreatingContractors) {
      return res.status(403).json({ error: "You don't have permission to create contractors" });
    }

    // Note: offSiteRate and allowOffSite are intentionally not accepted from
    // the PM. Those remain admin-only settings so a PM can't grant a
    // contractor off-site pay. An admin can enable them later via PUT.
    const { username, password, displayName, email, firstName, lastName, baseRate, mileageRate, homeProperty } = req.body;
    if (!username || !password || !displayName) {
      return res.status(400).json({ error: "Username, password, and display name are required" });
    }
    if (!email) return res.status(400).json({ error: "Email is required" });

    const allUsers = await storage.getAllUsers();
    const emailTaken = allUsers.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
    if (emailTaken) return res.status(409).json({ error: "This email address is already in use by another user." });

    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });

    const existing = await storage.getUserByUsername(username);
    if (existing) return res.status(409).json({ error: "Username already taken" });

    // Determine which properties to assign: default to ALL of the PM's properties,
    // optionally restricted to a specific homeProperty if the PM picked one.
    const pmPropIds = await storage.getUserPropertyIds(session.userId);
    const allProps = await storage.getAllProperties();
    const pmProps = allProps.filter(p => pmPropIds.includes(p.id));
    if (pmProps.length === 0 && !isAdminRole(session.role)) {
      return res.status(400).json({ error: "You don't have any assigned properties. Ask an admin to assign you properties first." });
    }

    let assignedPropIds = pmProps.map(p => p.id);
    let resolvedHomeProperty = homeProperty || null;
    if (homeProperty) {
      const homeProp = pmProps.find(p => p.name === homeProperty);
      if (!homeProp && !isAdminRole(session.role)) {
        return res.status(403).json({ error: "You can only assign the contractor to your own properties" });
      }
      if (homeProp) assignedPropIds = [homeProp.id];
    } else if (pmProps.length === 1) {
      resolvedHomeProperty = pmProps[0].name;
    }

    const user = await storage.createUser({
      username,
      password,
      displayName,
      role: "contractor",
      email: email || null,
      mustChangePassword: 1,
      firstName: firstName || null,
      lastName: lastName || null,
      baseRate: baseRate ? String(baseRate) : "0",
      offSiteRate: "0",
      mileageRate: mileageRate ? String(mileageRate) : "0.50",
      allowOffSite: 0,
      // Explicit opt-in from the PM; contractors without allowMiles cannot log miles.
      allowMiles: req.body.allowMiles ? 1 : 0,
      homeProperty: resolvedHomeProperty,
      w9OrW4: "w9",
      createdByUserId: session.userId,
    } as any);

    if (assignedPropIds.length > 0) {
      await storage.setUserProperties(user.id, assignedPropIds);
    }

    res.json({ id: user.id, username: user.username, displayName: user.displayName, role: user.role, email: user.email });

    // Send welcome email
    if (email) {
      setImmediate(async () => {
        try {
          const appUrl = "https://invoice-snap-production.up.railway.app";
          const videoUrl = "https://drive.google.com/file/d/1L2SFfyKK19vpJxuJs99VrIMtywF7ox76/view";

          // Attach the contractor (or other) manual if available
          const attachments: { filename: string; path: string }[] = [];
          const manual = manualForRole(user.role);
          let manualLabel = "";
          if (manual) {
            attachments.push(manual);
            if (user.role === "contractor") manualLabel = "Contractor Manual";
            else if (user.role === "manager") manualLabel = "Property Manager Manual";
            else manualLabel = "Admin Manual";
          }
          const manualBlock = manualLabel
            ? `<h3 style="color:#01696F;">${manualLabel}</h3>
               <p>The <b>${manualLabel}</b> is attached to this email — it covers everything you need to know to get started.</p>`
            : "";

          await sendEmailToRecipients(
            [{ name: displayName, email }],
            `Welcome to Jetsetter Reporting`,
            `<html><body style="font-family:Arial;max-width:600px;margin:0 auto;">
              <div style="background:#01696F;padding:20px;text-align:center;">
                <h1 style="color:white;margin:0;">Welcome to Jetsetter Reporting</h1>
              </div>
              <div style="padding:20px;">
                <p>Hi ${displayName},</p>
                <p>You've been invited to use <b>Jetsetter Reporting</b> by ${pm.displayName}. This is our company's reporting app for tracking receipts, cash transactions, time reporting, and documents.</p>
                <h3 style="color:#01696F;">Getting Started</h3>
                <p>1. <b>Open the app:</b> <a href="${appUrl}" style="color:#01696F;">${appUrl}</a></p>
                <p>2. <b>Log in</b> with your username: <b>${username}</b> and the password provided to you.</p>
                <p>3. On first login, you'll be asked to <b>change your password</b>.</p>
                <p>4. <b>Add the app to your home screen</b> for easy access.</p>
                <p style="text-align:center;margin-top:20px;"><a href="${videoUrl}" style="display:inline-block;background:#01696F;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Watch Tutorial Video</a></p>
                ${manualBlock}
                <p style="color:#888;font-size:12px;margin-top:30px;">- Jetsetter Reporting</p>
              </div>
            </body></html>`,
            attachments.length > 0 ? attachments : undefined
          );
          console.log(`[pm-welcome] Sent welcome email to ${email} (role: ${user.role}, manual: ${manualLabel || "none"})`);
        } catch (e) { console.error("[pm-welcome] Failed:", e); }
      });
    }

    // Admin alert: notify admins (subscribed to documentUploadReport) that
    // a property manager created a new contractor account.
    setImmediate(async () => {
      try {
        const adminPropIds = await storage.getUserPropertyIds(session.userId);
        const allProps = await storage.getAllProperties();
        const propMap = new Map(allProps.map(p => [p.id, p.name]));
        const propNames = adminPropIds.map(id => propMap.get(id)).filter(Boolean).join(", ");
        const allUsers = await storage.getAllUsers();
        const adminRecipients = allUsers
          .filter((u: any) => u.documentUploadReport && u.email && isAdminRole(u.role))
          .map((u: any) => ({ name: u.displayName, email: u.email }));
        if (adminRecipients.length === 0) return;
        await sendEmailToRecipients(
          adminRecipients,
          `New Contractor Created by ${pm.displayName}`,
          `<html><body style="font-family:Arial;max-width:600px;margin:0 auto;">
            <div style="background:#01696F;padding:18px;text-align:center;">
              <h2 style="color:white;margin:0;">New Contractor Created</h2>
            </div>
            <div style="padding:20px;">
              <p>A property manager just onboarded a new contractor in Jetsetter Reporting.</p>
              <table style="border-collapse:collapse;margin:8px 0;">
                <tr><td style="padding:4px 12px 4px 0;color:#666;">Property Manager</td><td style="padding:4px 0;"><b>${pm.displayName}</b></td></tr>
                <tr><td style="padding:4px 12px 4px 0;color:#666;">Contractor</td><td style="padding:4px 0;"><b>${displayName}</b></td></tr>
                <tr><td style="padding:4px 12px 4px 0;color:#666;">Username</td><td style="padding:4px 0;">${username}</td></tr>
                ${email ? `<tr><td style="padding:4px 12px 4px 0;color:#666;">Email</td><td style="padding:4px 0;">${email}</td></tr>` : ""}
                ${baseRate ? `<tr><td style="padding:4px 12px 4px 0;color:#666;">Base Rate</td><td style="padding:4px 0;">$${baseRate}/hr</td></tr>` : ""}
                ${mileageRate ? `<tr><td style="padding:4px 12px 4px 0;color:#666;">Mileage Rate</td><td style="padding:4px 0;">$${mileageRate}/mi</td></tr>` : ""}
                <tr><td style="padding:4px 12px 4px 0;color:#666;">Allow Miles</td><td style="padding:4px 0;">${req.body.allowMiles ? "Yes" : "No"}</td></tr>
                <tr><td style="padding:4px 12px 4px 0;color:#666;">Property</td><td style="padding:4px 0;">${resolvedHomeProperty || propNames}</td></tr>
                <tr><td style="padding:4px 12px 4px 0;color:#666;">Created</td><td style="padding:4px 0;">${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET</td></tr>
              </table>
              <p style="color:#666;font-size:13px;margin-top:14px;">You can review or adjust this contractor's settings (off-site rate, allow off-site, etc.) from the Admin Panel.</p>
              <p style="color:#888;font-size:11px;margin-top:24px;">- Jetsetter Reporting</p>
            </div>
          </body></html>`
        );
      } catch (e) { console.error("[pm-contractor-alert] Failed:", e); }
    });
  });

  // PM: List contractors in their properties
  app.get("/api/pm/contractors", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const pm = await storage.getUser(session.userId);
    if (!pm) return res.status(401).json({ error: "Unauthorized" });
    if (!isAdminRole(session.role) && !(pm as any).allowCreatingContractors) {
      return res.status(403).json({ error: "Not authorized" });
    }

    // A PM only manages contractors whose home base is the same as theirs.
    // Secondary property assignments don't grant visibility — the home base is
    // what decides which contractors belong to which PM.
    const pmHome = (pm as any).homeProperty;
    const allUsers = await storage.getAllUsers();
    const allProps = await storage.getAllProperties();
    const propMap = new Map(allProps.map(p => [p.id, p.name]));

    const contractors = [] as any[];
    for (const u of allUsers) {
      if (u.role !== "contractor") continue;
      if (u.id === session.userId) continue;
      // Admins still see every contractor; PMs only see contractors who share their home base.
      const sameHome = pmHome && (u as any).homeProperty === pmHome;
      if (!isAdminRole(session.role) && !sameHome) continue;
      const cPropIds = await storage.getUserPropertyIds(u.id);
      contractors.push({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        email: u.email,
        firstName: (u as any).firstName,
        lastName: (u as any).lastName,
        baseRate: (u as any).baseRate,
        offSiteRate: (u as any).offSiteRate,
        homeProperty: (u as any).homeProperty,
        assignedProperties: cPropIds.map(pid => propMap.get(pid)).filter(Boolean),
      });
    }
    res.json(contractors);
  });

  // PM: Get time reports for a specific contractor they manage (for pay calculation)
  app.get("/api/pm/contractors/:id/time-reports", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const pm = await storage.getUser(session.userId);
    if (!pm) return res.status(401).json({ error: "Unauthorized" });
    if (!isAdminRole(session.role) && !(pm as any).allowCreatingContractors) {
      return res.status(403).json({ error: "Not authorized" });
    }
    const contractorId = parseInt(req.params.id);
    // Verify the contractor shares at least one property with the PM
    const pmPropIds = new Set(await storage.getUserPropertyIds(session.userId));
    const cPropIds = await storage.getUserPropertyIds(contractorId);
    const shared = cPropIds.some(pid => pmPropIds.has(pid));
    if (!shared && !isAdminRole(session.role)) {
      return res.status(403).json({ error: "This contractor is not in your properties" });
    }
    const reports = await storage.getTimeReportsByUser(contractorId);
    // Restrict to time reports for PM's properties
    const allProps = await storage.getAllProperties();
    const pmPropNames = new Set(allProps.filter(p => pmPropIds.has(p.id)).map(p => p.name));
    const filtered = isAdminRole(session.role) ? reports : reports.filter(r => pmPropNames.has(r.property));
    res.json(filtered);
  });

  // Helper: load the time-tracking spreadsheet config (spreadsheetId etc.)
  function getTimeTrackingConfig(): { spreadsheetId: string } | null {
    try {
      const trConfigPath = path.resolve(dataDir, "time-tracking-config.json");
      if (!fs.existsSync(trConfigPath)) return null;
      const cfg = JSON.parse(fs.readFileSync(trConfigPath, "utf-8"));
      return cfg?.spreadsheetId ? cfg : null;
    } catch { return null; }
  }

  app.delete("/api/users/:id", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;

    const id = parseInt(req.params.id);
    if (id === session.userId) return res.status(400).json({ error: "Cannot delete yourself" });

    // Capture the user's name BEFORE deletion so we can clean up their
    // spreadsheet tab. Their cash transactions, credit-card receipts, work
    // credits, time reports, and flat-rate assignments are kept untouched.
    const target = await storage.getUser(id);
    const tabName = target?.displayName || `User ${id}`;

    await storage.deleteUser(id);

    // Remove the user's tab from the time-tracking spreadsheet.
    let tabRemoved = false;
    const trConfig = getTimeTrackingConfig();
    if (trConfig && isGoogleEnabled()) {
      try {
        tabRemoved = await deleteSheetTab(trConfig.spreadsheetId, tabName);
      } catch (e: any) {
        console.error("[user-delete] Failed to delete sheet tab:", e.message?.slice(0, 100));
      }
    }
    res.json({ ok: true, tabRemoved, tabName });
  });

  // Archive a user: hide them from the admin user list and block login,
  // but keep all their cash/CC/work-credit/time-report data intact and
  // hide (not delete) their tab on the time-tracking spreadsheet so the
  // historical entries remain accessible if needed.
  app.post("/api/users/:id/archive", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    if (id === session.userId) return res.status(400).json({ error: "Cannot archive yourself" });
    const target = await storage.getUser(id);
    if (!target) return res.status(404).json({ error: "User not found" });
    const tabName = target.displayName || `User ${id}`;

    await storage.setUserArchived(id, true);
    // Invalidate any active Bearer tokens the user might still have in
    // localStorage on their phone or laptop. Their next request lands on the
    // updated requireAuth() check, which returns 403 and forces re-login.
    try { await storage.deleteSessionsForUser(id); } catch (e: any) {
      console.error("[user-archive] Failed to purge sessions:", e.message?.slice(0, 100));
    }

    let tabHidden = false;
    const trConfig = getTimeTrackingConfig();
    if (trConfig && isGoogleEnabled()) {
      try {
        tabHidden = await hideSheetTab(trConfig.spreadsheetId, tabName);
      } catch (e: any) {
        console.error("[user-archive] Failed to hide sheet tab:", e.message?.slice(0, 100));
      }
    }
    res.json({ ok: true, tabHidden, tabName });
  });

  // Restore a previously archived user. Also emails them a fresh temporary
  // password so the admin never needs to see or hand out credentials. If the
  // user has no email on file the reset still happens (temp password is
  // written to the server log) — the admin can then use "Recover Login
  // Details" once an email is added.
  app.post("/api/users/:id/unarchive", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    const target = await storage.getUser(id);
    if (!target) return res.status(404).json({ error: "User not found" });
    const tabName = target.displayName || `User ${id}`;

    await storage.setUserArchived(id, false);

    // Force a password rotation on unarchive so the returning user must set
    // up new credentials. The helper handles the email + session purge.
    let emailed = false;
    try {
      await resetUserPasswordAndEmail(
        target,
        "Jetsetter Reporting — Welcome Back",
        "Your account has been reactivated. Here are your fresh login details:",
        "user-unarchive",
      );
      emailed = !!target.email;
    } catch (e: any) {
      console.error("[user-unarchive] Password rotation failed:", e.message?.slice(0, 120));
    }

    let tabUnhidden = false;
    const trConfig = getTimeTrackingConfig();
    if (trConfig && isGoogleEnabled()) {
      try {
        tabUnhidden = await unhideSheetTab(trConfig.spreadsheetId, tabName);
      } catch (e: any) {
        console.error("[user-unarchive] Failed to unhide sheet tab:", e.message?.slice(0, 100));
      }
    }
    // Include `emailed` so the client can show a helpful toast ("Fresh login
    // details emailed to X").
    res.json({ ok: true, tabUnhidden, tabName, emailed });
  });

  app.put("/api/users/:id", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const existing = await storage.getUser(id);
    if (!existing) return res.status(404).json({ error: "User not found" });

    const { displayName, email, password, role,
      dailyTimeReport, dailyTransactionReport, reconciliationReport,
      firstName, lastName, baseRate, offSiteRate, positions, homeProperty, allowOffSite,
      mileageRate, allowSpecialTerms, specialTermsAmount, w9OrW4, docsComplete,
      requireFinancialConfirm, allowPastDates, receiveTransactionEmails,
      allowWorkCredits, workCreditReport, documentUploadReport, docReminderEnabled, docReminderDays, allowContractorDocs, allowCreatingContractors,
      showWorkReport, showMyDocuments, showWorkCredit, showMyContractors, allowMiles, dailyReminderEnabled, allowFlatRate } = req.body;

    if (email) {
      const allUsers = await storage.getAllUsers();
      const emailTaken = allUsers.find(u => u.id !== id && u.email && u.email.toLowerCase() === email.toLowerCase());
      if (emailTaken) return res.status(409).json({ error: "This email address is already in use by another user." });
    }

    if (password !== undefined && password.trim()) {
      const pwError = validatePassword(password);
      if (pwError) return res.status(400).json({ error: pwError });
    }

    const updateData: any = {};
    if (displayName !== undefined) updateData.displayName = displayName;
    if (email !== undefined) updateData.email = email || null;
    if (password !== undefined && password.trim()) updateData.password = password;
    if (role !== undefined) updateData.role = role;
    if (dailyTimeReport !== undefined) updateData.dailyTimeReport = dailyTimeReport ? 1 : 0;
    if (dailyTransactionReport !== undefined) updateData.dailyTransactionReport = dailyTransactionReport ? 1 : 0;
    if (reconciliationReport !== undefined) updateData.reconciliationReport = reconciliationReport ? 1 : 0;
    if (firstName !== undefined) updateData.firstName = firstName || null;
    if (lastName !== undefined) updateData.lastName = lastName || null;
    if (baseRate !== undefined) updateData.baseRate = baseRate || null;
    if (offSiteRate !== undefined) updateData.offSiteRate = offSiteRate || null;
    if (positions !== undefined) {
      // Accept either a JSON string or a structured array. Normalise to a JSON string.
      if (positions === null || positions === "") {
        updateData.positions = null;
      } else if (typeof positions === "string") {
        updateData.positions = positions;
      } else if (Array.isArray(positions)) {
        const clean = positions
          .filter((p: any) => p && p.name && p.rate)
          .map((p: any) => ({ name: String(p.name).trim(), rate: String(p.rate).trim() }));
        updateData.positions = clean.length > 0 ? JSON.stringify(clean) : null;
      }
    }
    if (homeProperty !== undefined) updateData.homeProperty = homeProperty || null;
    if (allowOffSite !== undefined) updateData.allowOffSite = allowOffSite ? 1 : 0;
    if (mileageRate !== undefined) updateData.mileageRate = mileageRate || null;
    if (allowSpecialTerms !== undefined) updateData.allowSpecialTerms = allowSpecialTerms ? 1 : 0;
    if (specialTermsAmount !== undefined) updateData.specialTermsAmount = specialTermsAmount || null;
    if (w9OrW4 !== undefined) updateData.w9OrW4 = w9OrW4 || null;
    if (docsComplete !== undefined) updateData.docsComplete = docsComplete ? 1 : 0;
    if (requireFinancialConfirm !== undefined) updateData.requireFinancialConfirm = requireFinancialConfirm ? 1 : 0;
    if (allowPastDates !== undefined) updateData.allowPastDates = allowPastDates ? 1 : 0;
    if (receiveTransactionEmails !== undefined) updateData.receiveTransactionEmails = receiveTransactionEmails ? 1 : 0;
    if (allowWorkCredits !== undefined) updateData.allowWorkCredits = allowWorkCredits ? 1 : 0;
    if (workCreditReport !== undefined) updateData.workCreditReport = workCreditReport ? 1 : 0;
    if (documentUploadReport !== undefined) updateData.documentUploadReport = documentUploadReport ? 1 : 0;
    if (docReminderEnabled !== undefined) updateData.docReminderEnabled = docReminderEnabled ? 1 : 0;
    if (docReminderDays !== undefined) updateData.docReminderDays = parseInt(docReminderDays) || 3;
    if (allowContractorDocs !== undefined) updateData.allowContractorDocs = allowContractorDocs ? 1 : 0;
    if (allowCreatingContractors !== undefined) updateData.allowCreatingContractors = allowCreatingContractors ? 1 : 0;
    if (showWorkReport !== undefined) updateData.showWorkReport = showWorkReport ? 1 : 0;
    if (showMyDocuments !== undefined) updateData.showMyDocuments = showMyDocuments ? 1 : 0;
    if (showWorkCredit !== undefined) updateData.showWorkCredit = showWorkCredit ? 1 : 0;
    if (showMyContractors !== undefined) updateData.showMyContractors = showMyContractors ? 1 : 0;
    if (allowMiles !== undefined) updateData.allowMiles = allowMiles ? 1 : 0;
    if (dailyReminderEnabled !== undefined) updateData.dailyReminderEnabled = dailyReminderEnabled ? 1 : 0;
    if (allowFlatRate !== undefined) updateData.allowFlatRate = allowFlatRate ? 1 : 0;

    const updated = await storage.updateUser(id, updateData);
    res.json(updated);
  });

  app.get("/api/users/:id/properties", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const propertyIds = await storage.getUserPropertyIds(id);
    res.json(propertyIds);
  });

  app.put("/api/users/:id/properties", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const { propertyIds } = req.body;
    if (!Array.isArray(propertyIds)) return res.status(400).json({ error: "propertyIds must be an array" });
    await storage.setUserProperties(id, propertyIds);
    res.json({ ok: true });
  });

  // ---- PROPERTIES ----
  app.get("/api/properties", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    if (isAdminRole(session.role)) {
      const props = await storage.getAllProperties();
      res.json(props);
    } else {
      const props = await storage.getPropertiesForUser(session.userId);
      res.json(props);
    }
  });

  app.post("/api/properties", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;

    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Property name is required" });
    }
    const trimmed = name.trim();

    const existing = await storage.getPropertyByName(trimmed);
    if (existing) return res.status(409).json({ error: "Property already exists" });

    // Create Google Sheets tab first
    const tabId = await createSheetsTab(trimmed);

    const prop = await storage.createProperty({ name: trimmed, sheetsTabId: tabId ?? undefined });
    console.log(`[property] Added "${trimmed}" (sheetsTab: ${tabId})`);
    res.json(prop);
  });

  // Admin: set or clear a property's short code (e.g. "TE"), marketing URL, and/or
  // PM master-sheet URL.
  // Body: { code?: string|null, marketingUrl?: string|null, masterSheetUrl?: string|null }.
  // Any field may be omitted — only supplied fields are updated.
  app.put("/api/properties/:id", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const allProps = await storage.getAllProperties();
    const prop = allProps.find(p => p.id === id);
    if (!prop) return res.status(404).json({ error: "Property not found" });

    if ("code" in req.body) {
      const raw = req.body.code;
      const code = raw == null || raw === "" ? null : String(raw).trim().toUpperCase();
      if (code && !/^[A-Z0-9]{1,6}$/.test(code)) {
        return res.status(400).json({ error: "Code must be 1\u20136 letters or digits (e.g. 'TE')" });
      }
      // Enforce uniqueness so two properties don't share the same prefix.
      if (code) {
        const conflict = allProps.find(p => p.id !== id && (p as any).code?.toUpperCase() === code);
        if (conflict) return res.status(409).json({ error: `Code already used by '${conflict.name}'` });
      }
      await storage.updatePropertyCode(id, code);
    }
    if ("marketingUrl" in req.body) {
      const raw = req.body.marketingUrl;
      const url = raw == null || raw === "" ? null : String(raw).trim();
      if (url && !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: "Marketing URL must start with http:// or https://" });
      }
      await storage.updatePropertyMarketingUrl(id, url);
    }
    if ("masterSheetUrl" in req.body) {
      const raw = req.body.masterSheetUrl;
      const url = raw == null || raw === "" ? null : String(raw).trim();
      if (url && !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: "PM Master Sheet URL must start with http:// or https://" });
      }
      await storage.updatePropertyMasterSheetUrl(id, url);
    }

    const updated = (await storage.getAllProperties()).find(p => p.id === id);
    res.json(updated);
  });

  app.delete("/api/properties/:id", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;

    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    // Get the property name before deleting
    const allProps = await storage.getAllProperties();
    const prop = allProps.find(p => p.id === id);
    const propName = prop?.name || "Unknown";

    await storage.deleteProperty(id);
    res.json({ ok: true });

    // Rename sheet tabs instead of deleting (preserve history)
    setImmediate(async () => {
      try {
        if (isGoogleEnabled()) {
          const deactivatedName = `${propName} (DEACTIVATED)`;
          const dateStr = new Date().toISOString().split("T")[0];
          const note = `⚠️ PROPERTY DEACTIVATED on ${dateStr} - DO NOT USE THIS TAB FOR NEW ENTRIES`;

          // Rename in CC receipts spreadsheet
          const sheetsConfig = JSON.parse(fs.readFileSync(path.resolve(dataDir, "sheets-config.json"), "utf-8"));
          if (sheetsConfig?.spreadsheetId) {
            await renameSheetTab(sheetsConfig.spreadsheetId, propName, deactivatedName);
            await prependNoteToTab(sheetsConfig.spreadsheetId, deactivatedName, note);
          }

          // Rename in Cash transactions spreadsheet
          const cashConfigPath = path.resolve(dataDir, "cash-sheets-config.json");
          if (fs.existsSync(cashConfigPath)) {
            const cashConfig = JSON.parse(fs.readFileSync(cashConfigPath, "utf-8"));
            if (cashConfig?.spreadsheetId) {
              await renameSheetTab(cashConfig.spreadsheetId, propName, deactivatedName);
              await prependNoteToTab(cashConfig.spreadsheetId, deactivatedName, note);
            }
          }

          console.log(`[property] Deactivated sheet tabs for "${propName}"`);
        }
      } catch (e) { console.error("[property] Failed to deactivate sheet tabs:", e); }
    });
  });

  // ---- PHOTO UPLOAD ----
  app.post("/api/upload", async (req, res, next) => {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: "Unauthorized" });
    next();
  }, upload.single("photo"), fixUploadedExtension, (req: any, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    res.json({ filename: req.file.filename, path: `/api/uploads/${req.file.filename}` });
  });

  // ---- INVOICES ----
  app.post("/api/invoices", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;

    const parsed = invoiceFormSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { photoPath, photoPaths } = req.body;
    if (!photoPath) return res.status(400).json({ error: "Photo is required" });

    const user = await storage.getUser(session.userId);
    const recordNumber = await storage.getNextRecordNumber(parsed.data.property);
    // Per-property human-readable code, e.g. "TE-7". Used in Sheets'
    // "Receipt Identification" column AND appended to the Drive filename.
    const propertyCode = await storage.getNextPropertyCode(parsed.data.property);
    const invoice = await storage.createInvoice({
      userId: session.userId,
      photoPath,
      photoPaths: photoPaths || JSON.stringify([photoPath]),
      property: parsed.data.property,
      purchaseDate: parsed.data.purchaseDate,
      description: parsed.data.description,
      purpose: parsed.data.purpose,
      amount: parsed.data.amount,
      boughtBy: parsed.data.boughtBy || user?.displayName || "Unknown",
      paymentMethod: parsed.data.paymentMethod,
      lastFourDigits: parsed.data.paymentMethod === "cc" ? (parsed.data.lastFourDigits || null) : null,
      recordNumber,
      propertyCode,
      rentManagerIssue: parsed.data.rentManagerIssue || null,
      receiptType: req.body.receiptType || "expense",
      syncedToDrive: 0,
      syncedToSheets: 0,
      createdAt: new Date().toISOString(),
    } as any);

    res.json(invoice);

    // Background sync to Google Drive & Sheets + email notification (non-blocking)
    setImmediate(async () => {
      const submittedByName = user?.displayName || "Unknown";
      try {
        const sheetsOk = await syncToSheets(invoice, submittedByName);
        console.log(`[sync] Sheets sync for invoice ${invoice.id}: ${sheetsOk}`);
        if (sheetsOk) {
          await storage.updateInvoiceSyncStatus(invoice.id, "sheets", true);
          // Highlight refund rows in green
          if ((invoice as any).receiptType === "refund" && sheetsConfig) {
            await highlightLastRow(sheetsConfig.spreadsheetId, invoice.property, { red: 0.6, green: 1, blue: 0.6 });
          }
        }
      } catch (e) { console.error("[sync] Sheets error:", e); }
      try {
        const driveOk = await syncToDrive(invoice);
        console.log(`[sync] Drive sync for invoice ${invoice.id}: ${driveOk}`);
        if (driveOk) {
          await storage.updateInvoiceSyncStatus(invoice.id, "drive", true);
        }
      } catch (e) { console.error("[sync] Drive error:", e); }

      // Email notification with photo attachment
      try {
        const typeLabel = (invoice as any).receiptType === "refund" ? "REFUND" : "Expense";
        const attachments: any[] = [];
        const photoFile = path.resolve(dataDir, "uploads", invoice.photoPath.replace(/^\/api\/uploads\//, ""));
        if (fs.existsSync(photoFile)) {
          attachments.push({ filename: path.basename(photoFile), path: photoFile });
        }
        await sendNotificationEmails(
          `New Receipt: ${typeLabel} $${invoice.amount} - ${invoice.property}`,
          `<h3>New ${typeLabel} Receipt Submitted</h3>
           <p><strong>Property:</strong> ${invoice.property}</p>
           <p><strong>Amount:</strong> $${invoice.amount}</p>
           <p><strong>Description:</strong> ${invoice.description}</p>
           <p><strong>Purpose:</strong> ${invoice.purpose}</p>
           <p><strong>Bought By:</strong> ${invoice.boughtBy}</p>
           <p><strong>CC Last Digits:</strong> ••${invoice.lastFourDigits || "N/A"}</p>
           <p><strong>Submitted By:</strong> ${submittedByName}</p>
           <p><strong>Date:</strong> ${invoice.purchaseDate}</p>
           <p><strong>Record #:</strong> ${invoice.recordNumber || "N/A"}</p>`,
          attachments
        );
      } catch (e) { console.error("[email] Notification error:", e); }
    });
  });

  // Helper: returns the set of user IDs whose submissions a given viewer
  // (non-admin) is allowed to see. Visibility rules:
  //   * Property managers see themselves + every CONTRACTOR sharing their
  //     home base property (so they can monitor their crew).
  //   * Contractors see ONLY their own submissions — not the PM's, not
  //     other contractors' (one-way visibility, item 3 in June 2026 update).
  //   * A viewer with no home base sees only their own submissions.
  async function getVisibleUserIdsForManager(viewerUserId: number): Promise<Set<number>> {
    const allowed = new Set<number>([viewerUserId]);
    const viewer = await storage.getUser(viewerUserId);
    if (!viewer) return allowed;
    // Contractors are scoped to themselves only.
    if (viewer.role === "contractor") return allowed;
    const viewerHome = (viewer as any)?.homeProperty;
    if (!viewerHome) return allowed;
    const allUsers = await storage.getAllUsers();
    for (const u of allUsers) {
      if (u.id === viewerUserId) continue;
      // Property managers see contractors at their home base (not other PMs/admins).
      if (u.role === "contractor" && (u as any).homeProperty === viewerHome) {
        allowed.add(u.id);
      }
    }
    return allowed;
  }

  // Helper: returns invoices a non-admin user is allowed to see —
  // their own submissions + any submission by a contractor sharing their home base.
  async function getVisibleInvoicesForUser(userId: number) {
    const allowedUserIds = await getVisibleUserIdsForManager(userId);
    const allInvoices = await storage.getAllInvoices();
    return allInvoices
      .filter(inv => allowedUserIds.has(inv.userId))
      .sort((a, b) => b.id - a.id);
  }

  app.get("/api/invoices", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;

    let invoicesList;
    if (isAdminRole(session.role)) {
      invoicesList = await storage.getAllInvoices();
    } else {
      invoicesList = await getVisibleInvoicesForUser(session.userId);
    }

    // Enrich with user display names
    const allUsers = await storage.getAllUsers();
    const userMap = new Map(allUsers.map(u => [u.id, u.displayName]));

    const enriched = invoicesList.map(inv => ({
      ...inv,
      submittedBy: userMap.get(inv.userId) || "Unknown",
      photoPaths: inv.photoPaths ? JSON.parse(inv.photoPaths) : [inv.photoPath],
    }));

    res.json(enriched);
  });

  app.put("/api/invoices/:id", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const existing = await storage.getInvoice(id);
    if (!existing) return res.status(404).json({ error: "Receipt not found" });

    // Managers can only edit their own
    if (!isAdminRole(session.role) && existing.userId !== session.userId) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const { description, purpose, amount, boughtBy, paymentMethod, lastFourDigits, rentManagerIssue } = req.body;

    // Track what changed
    const changes: string[] = [];
    if (description !== undefined && description !== existing.description) changes.push(`Description: "${existing.description}" → "${description}"`);
    if (purpose !== undefined && purpose !== existing.purpose) changes.push(`Purpose: "${existing.purpose}" → "${purpose}"`);
    if (amount !== undefined && amount !== existing.amount) changes.push(`Amount: $${existing.amount} → $${amount}`);
    if (boughtBy !== undefined && boughtBy !== existing.boughtBy) changes.push(`Bought By: "${existing.boughtBy}" → "${boughtBy}"`);
    if (paymentMethod !== undefined && paymentMethod !== existing.paymentMethod) changes.push(`Payment: "${existing.paymentMethod}" → "${paymentMethod}"`);
    if (rentManagerIssue !== undefined && rentManagerIssue !== (existing.rentManagerIssue || "")) changes.push(`RM Issue: "${existing.rentManagerIssue || ""}" → "${rentManagerIssue}"`);

    const editUser = await storage.getUser(session.userId);
    const editEntry = { by: editUser?.displayName || "Unknown", at: new Date().toISOString(), changes };
    const existingHistory = existing.editHistory ? JSON.parse(existing.editHistory) : [];
    existingHistory.push(editEntry);

    const updated = await storage.updateInvoice(id, {
      description: description ?? existing.description,
      purpose: purpose ?? existing.purpose,
      amount: amount ?? existing.amount,
      boughtBy: boughtBy ?? existing.boughtBy,
      paymentMethod: paymentMethod ?? existing.paymentMethod,
      lastFourDigits: lastFourDigits ?? existing.lastFourDigits,
      rentManagerIssue: rentManagerIssue ?? existing.rentManagerIssue,
      editHistory: JSON.stringify(existingHistory),
    });

    res.json(updated);

    // Background: update the Sheets row
    if (isGoogleEnabled() && sheetsConfig && updated) {
      setImmediate(async () => {
        try {
          // Delete old row and add updated one
          const submittedByName = editUser?.displayName || "Unknown";
          if (existing.property && sheetsConfig!.tabs[existing.property]) {
            await deleteSheetRow(sheetsConfig!.spreadsheetId, existing.property, existing.purchaseDate, existing.description, existing.amount);
            await appendSheetRow(sheetsConfig!.spreadsheetId, existing.property, [
              updated.purchaseDate, updated.description, updated.purpose, updated.amount,
              updated.boughtBy, updated.paymentMethod === "cc" ? "Credit Card" : "Cash",
              updated.lastFourDigits || "", submittedByName, updated.createdAt,
              String(updated.recordNumber || ""), updated.rentManagerIssue || "",
              updated.receiptType || "expense",
              `EDITED by ${editEntry.by} at ${editEntry.at}: ${editEntry.changes.join("; ")}`,
            ]);
            // Highlight edited row in yellow
            await highlightLastRow(sheetsConfig!.spreadsheetId, existing.property, { red: 1, green: 1, blue: 0.6 });
          }
        } catch (e) { console.error("[edit] Sheets update failed:", e); }

        // Edit notification email
        try {
          const attachments: any[] = [];
          const photoFile = path.resolve(dataDir, "uploads", existing.photoPath.replace(/^\/api\/uploads\//, ""));
          if (fs.existsSync(photoFile)) attachments.push({ filename: path.basename(photoFile), path: photoFile });
          await sendNotificationEmails(
            `Receipt EDITED: ${existing.property} #${existing.recordNumber || ""} - $${updated.amount}`,
            `<h3>Receipt Edited</h3>
             <p><strong>Property:</strong> ${existing.property}</p>
             <p><strong>Record #:</strong> ${existing.recordNumber || "N/A"}</p>
             <p><strong>Edited by:</strong> ${editEntry.by}</p>
             <p><strong>Changes:</strong></p>
             <ul>${editEntry.changes.map((c: string) => `<li>${c}</li>`).join("")}</ul>
             <p><strong>New Amount:</strong> $${updated.amount}</p>
             <p style="color:#888;font-size:12px;margin-top:16px;">- Receipt App</p>`,
            attachments
          );
        } catch (e) { console.error("[edit-email] Failed:", e); }
      });
    }
  });

  app.delete("/api/invoices/:id", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    // Get the invoice first (needed for cleanup + auth check)
    const invoice = await storage.getInvoice(id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    // Managers can only delete their own invoices
    if (!isAdminRole(session.role) && invoice.userId !== session.userId) {
      return res.status(403).json({ error: "Not authorized to delete this invoice" });
    }

    // Delete from database first
    await storage.deleteInvoice(id);
    res.json({ ok: true });

    // Background cleanup: remove from Google Sheets and Drive (non-blocking)
    if (isGoogleEnabled() && sheetsConfig) {
      setImmediate(async () => {
        try {
          // Delete row from Google Sheets
          if (invoice.property && sheetsConfig!.tabs[invoice.property]) {
            await deleteSheetRow(
              sheetsConfig!.spreadsheetId,
              invoice.property,
              invoice.purchaseDate,
              invoice.description,
              invoice.amount
            );
          }
        } catch (e) { console.error("[delete] Sheets cleanup failed:", e); }

        // Delete all photos from Google Drive and local storage
        const allPaths: string[] = invoice.photoPaths ? JSON.parse(invoice.photoPaths) : [invoice.photoPath];
        const safeDesc = (invoice.description || "receipt").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 40);
        for (let i = 0; i < allPaths.length; i++) {
          try {
            const ext = path.extname(allPaths[i]).slice(1) || "jpg";
            const suffix = allPaths.length > 1 ? ` (${i + 1} of ${allPaths.length})` : "";
            const driveFileName = `${invoice.property} - ${invoice.purchaseDate} ${safeDesc}${suffix}.${ext}`;
            await deleteFromDrive(driveFileName);
          } catch (e) { console.error("[delete] Drive cleanup failed:", e); }
          try {
            const localPath = path.resolve(dataDir, "uploads", allPaths[i].replace(/^\/api\/uploads\//, ""));
            if (fs.existsSync(localPath)) { fs.unlinkSync(localPath); }
          } catch (e) { /* ignore */ }
        }
      });
    }
  });

  // Admin endpoint to re-sync all unsynced invoices to Google Sheets + Drive
  app.post("/api/admin/resync", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    if (!isGoogleEnabled() || !sheetsConfig) {
      return res.status(400).json({ error: "Google API not configured" });
    }

    const allInvoices = await storage.getAllInvoices();
    const users = await storage.getAllUsers();
    const userMap = new Map(users.map((u: any) => [u.id, u.displayName]));
    let sheetsCount = 0;
    let driveCount = 0;

    for (const inv of allInvoices) {
      const submittedByName = userMap.get(inv.userId) || "Unknown";
      if (!inv.syncedToSheets) {
        try {
          const ok = await syncToSheets(inv, submittedByName);
          if (ok) { await storage.updateInvoiceSyncStatus(inv.id, "sheets", true); sheetsCount++; }
        } catch (e) { console.error(`[resync] Sheets failed for invoice ${inv.id}:`, e); }
      }
      if (!inv.syncedToDrive) {
        try {
          const ok = await syncToDrive(inv);
          if (ok) { await storage.updateInvoiceSyncStatus(inv.id, "drive", true); driveCount++; }
        } catch (e) { console.error(`[resync] Drive failed for invoice ${inv.id}:`, e); }
      }
    }

    res.json({ ok: true, sheetsSync: sheetsCount, driveSync: driveCount, total: allInvoices.length });
  });

  // ---- DAILY REPORT ----
  app.post("/api/admin/daily-report", async (req, res) => {
    // Allow internal cron calls (from built-in scheduler)
    const authHeader = req.headers.authorization || "";
    const isInternalCron = authHeader === "Bearer internal-cron";
    if (!isInternalCron) {
      const session = await requireAdmin(req, res);
      if (!session) return;
    }

    const date = req.body.date || new Date().toISOString().split("T")[0];
    const allProps = await storage.getAllProperties();
    const allUsers = await storage.getAllUsers();
    const userMap = new Map(allUsers.map(u => [u.id, u.displayName]));

    // Get today's data
    const todayInvoices = await storage.getInvoicesByDate(date);
    const todayCash = await storage.getCashTransactionsByDate(date);

    // Build HTML report
    let html = `<div style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;">`;
    html += `<h1 style="color:#1a5c3a;">Daily Summary - ${date}</h1>`;
    html += `<p style="color:#666;">Generated on ${new Date().toISOString().replace("T", " ").slice(0, 19)}</p>`;

    // Credit Card Receipts section
    html += `<h2 style="color:#333;border-bottom:2px solid #1a5c3a;padding-bottom:5px;">Credit Card Receipts</h2>`;
    if (todayInvoices.length === 0) {
      html += `<p style="color:#888;">No credit card receipts today.</p>`;
    } else {
      let totalExpenses = 0, totalRefunds = 0;
      const byProperty = new Map<string, typeof todayInvoices>();
      for (const inv of todayInvoices) {
        const list = byProperty.get(inv.property) || [];
        list.push(inv);
        byProperty.set(inv.property, list);
        const amt = parseFloat(inv.amount) || 0;
        if ((inv as any).receiptType === "refund") totalRefunds += amt;
        else totalExpenses += amt;
      }
      for (const [prop, invs] of byProperty) {
        html += `<h3 style="color:#1a5c3a;">${prop}</h3>`;
        html += `<table style="border-collapse:collapse;width:100%;margin-bottom:10px;">`;
        html += `<tr style="background:#f0f0f0;"><th style="text-align:left;padding:6px;border:1px solid #ddd;">Description</th><th style="padding:6px;border:1px solid #ddd;">Amount</th><th style="padding:6px;border:1px solid #ddd;">Type</th><th style="padding:6px;border:1px solid #ddd;">By</th><th style="padding:6px;border:1px solid #ddd;">CC</th></tr>`;
        for (const inv of invs) {
          const type = (inv as any).receiptType === "refund" ? "<span style='color:green;'>Refund</span>" : "Expense";
          html += `<tr><td style="padding:6px;border:1px solid #ddd;">${inv.description}</td><td style="padding:6px;border:1px solid #ddd;text-align:right;">$${inv.amount}</td><td style="padding:6px;border:1px solid #ddd;text-align:center;">${type}</td><td style="padding:6px;border:1px solid #ddd;">${inv.boughtBy}</td><td style="padding:6px;border:1px solid #ddd;text-align:center;">**${inv.lastFourDigits || "N/A"}</td></tr>`;
        }
        html += `</table>`;
      }
      html += `<div style="background:#f8f8f8;padding:10px;border-radius:5px;margin:10px 0;">`;
      html += `<strong>Daily Totals:</strong> Expenses: $${totalExpenses.toFixed(2)} | Refunds: $${totalRefunds.toFixed(2)} | Net: $${(totalExpenses - totalRefunds).toFixed(2)}`;
      html += `</div>`;
    }

    // Cash Transactions section
    html += `<h2 style="color:#333;border-bottom:2px solid #e67e22;padding-bottom:5px;">Cash Transactions</h2>`;
    if (todayCash.length === 0) {
      html += `<p style="color:#888;">No cash transactions today.</p>`;
    } else {
      let totalIncome = 0, totalSpent = 0;
      const byPropCash = new Map<string, typeof todayCash>();
      for (const tx of todayCash) {
        const list = byPropCash.get(tx.property) || [];
        list.push(tx);
        byPropCash.set(tx.property, list);
        const amt = parseFloat(tx.amount) || 0;
        if (tx.type === "income") totalIncome += amt;
        else totalSpent += amt;
      }
      for (const [prop, txs] of byPropCash) {
        html += `<h3 style="color:#e67e22;">${prop}</h3>`;
        html += `<table style="border-collapse:collapse;width:100%;margin-bottom:10px;">`;
        html += `<tr style="background:#f0f0f0;"><th style="text-align:left;padding:6px;border:1px solid #ddd;">Category</th><th style="padding:6px;border:1px solid #ddd;">Amount</th><th style="padding:6px;border:1px solid #ddd;">Type</th><th style="padding:6px;border:1px solid #ddd;">Details</th></tr>`;
        for (const tx of txs) {
          const typeColor = tx.type === "income" ? "green" : "red";
          const details = [tx.description, tx.tenantName, tx.bankName].filter(Boolean).join(", ");
          html += `<tr><td style="padding:6px;border:1px solid #ddd;">${tx.category.replace(/_/g, " ")}</td><td style="padding:6px;border:1px solid #ddd;text-align:right;">$${tx.amount}</td><td style="padding:6px;border:1px solid #ddd;text-align:center;"><span style='color:${typeColor};'>${tx.type}</span></td><td style="padding:6px;border:1px solid #ddd;">${details}</td></tr>`;
        }
        html += `</table>`;
      }
      html += `<div style="background:#f8f8f8;padding:10px;border-radius:5px;margin:10px 0;">`;
      html += `<strong>Daily Totals:</strong> Income: $${totalIncome.toFixed(2)} | Spent: $${totalSpent.toFixed(2)} | Net: $${(totalIncome - totalSpent).toFixed(2)}`;
      html += `</div>`;
    }

    // Cash on Hand per property
    html += `<h2 style="color:#333;border-bottom:2px solid #333;padding-bottom:5px;">Cash on Hand</h2>`;
    html += `<table style="border-collapse:collapse;width:100%;">`;
    for (const prop of allProps) {
      const balance = await storage.getCashBalanceByProperty(prop.name);
      const color = balance >= 0 ? "green" : "red";
      html += `<tr><td style="padding:6px;border:1px solid #ddd;">${prop.name}</td><td style="padding:6px;border:1px solid #ddd;text-align:right;color:${color};font-weight:bold;">$${balance.toFixed(2)}</td></tr>`;
    }
    html += `</table>`;

    // Check Transactions for today + Checks on Hand summary.
    // Mirrors the Cash section. Each property gets a row of today's check
    // entries (showing deposit status + From + amount), and we append a
    // Checks on Hand table for un-deposited totals per property.
    const allChecks = await storage.getAllCheckTransactions();
    const todayChecks = allChecks.filter(c => c.date === date);
    if (todayChecks.length > 0) {
      html += `<h2 style="color:#0e7c66;border-bottom:2px solid #0e7c66;padding-bottom:5px;margin-top:20px;">Check Transactions (today)</h2>`;
      const byPropChecks = new Map<string, typeof todayChecks>();
      for (const c of todayChecks) {
        const list = byPropChecks.get(c.property) || [];
        list.push(c);
        byPropChecks.set(c.property, list);
      }
      let todayCheckTotal = 0;
      for (const [prop, checks] of byPropChecks) {
        html += `<h3 style="color:#0e7c66;">${prop}</h3>`;
        html += `<table style="border-collapse:collapse;width:100%;margin-bottom:10px;">`;
        html += `<tr style="background:#f0f0f0;"><th style="text-align:left;padding:6px;border:1px solid #ddd;">From</th><th style="padding:6px;border:1px solid #ddd;">Amount</th><th style="padding:6px;border:1px solid #ddd;">Check #</th><th style="padding:6px;border:1px solid #ddd;">Status</th><th style="padding:6px;border:1px solid #ddd;">Notes</th></tr>`;
        for (const c of checks) {
          todayCheckTotal += parseFloat(c.amount || "0");
          const statusColor = c.deposited ? "green" : "#b45309";
          html += `<tr><td style="padding:6px;border:1px solid #ddd;">${c.payerName || ""}</td><td style="padding:6px;border:1px solid #ddd;text-align:right;">$${c.amount}</td><td style="padding:6px;border:1px solid #ddd;text-align:center;">${c.checkNumber || ""}</td><td style="padding:6px;border:1px solid #ddd;text-align:center;color:${statusColor};">${c.deposited ? "Deposited" : "On Hand"}</td><td style="padding:6px;border:1px solid #ddd;">${c.notes || ""}</td></tr>`;
        }
        html += `</table>`;
      }
      html += `<div style="background:#f3fbf7;padding:10px;border-radius:5px;margin:10px 0;">`;
      html += `<strong>Total checks today:</strong> $${todayCheckTotal.toFixed(2)}`;
      html += `</div>`;
    }
    // Checks on Hand table — always shown alongside Cash on Hand.
    html += `<h2 style="color:#0e7c66;border-bottom:2px solid #0e7c66;padding-bottom:5px;margin-top:20px;">Checks on Hand</h2>`;
    html += `<table style="border-collapse:collapse;width:100%;">`;
    for (const prop of allProps) {
      const onHand = allChecks
        .filter(c => c.property === prop.name && !c.deposited)
        .reduce((acc, c) => acc + parseFloat(c.amount || "0"), 0);
      const color = onHand > 0 ? "#b45309" : "#999";
      html += `<tr><td style="padding:6px;border:1px solid #ddd;">${prop.name}</td><td style="padding:6px;border:1px solid #ddd;text-align:right;color:${color};font-weight:bold;">$${onHand.toFixed(2)}</td></tr>`;
    }
    html += `</table>`;

    // Transaction report HTML complete
    html += `<p style="color:#888;font-size:12px;margin-top:20px;">- Receipt App Daily Report</p></div>`;

    // Build separate Time Report HTML with financial summary
    const todayTimeReports = await storage.getTimeReportsByDate(date);
    let timeHtml = `<div style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;">`;
    timeHtml += `<h1 style="color:#3b82f6;">Daily Work Report - ${date}</h1>`;
    timeHtml += `<p style="color:#666;">Generated on ${new Date().toISOString().replace("T", " ").slice(0, 19)}</p>`;
    if (todayTimeReports.length > 0) {
      const allUsersMap = new Map(allUsers.map(u => [u.id, u]));

      // Track daily totals per worker for the summary
      const workerTotals = new Map<number, { name: string; hours: number; laborCost: number; mileageVal: number; specialVal: number; entries: number }>();

      // Individual entries
      timeHtml += `<h2 style="color:#333;border-bottom:1px solid #ddd;padding-bottom:5px;">Entries</h2>`;
      for (const tr of todayTimeReports) {
        const trUser = allUsersMap.get(tr.userId);
        const name = trUser?.displayName || "Unknown";
        let accomplishmentsList: string[] = [];
        try { accomplishmentsList = JSON.parse(tr.accomplishments || "[]"); } catch {}
        let hours = 0;
        let timeDisplay = `${tr.startTime} - ${tr.endTime}`;
        let blocks: { start: string; end: string }[] = [];
        try { blocks = tr.timeBlocks ? JSON.parse(tr.timeBlocks) : []; } catch {}
        if (blocks.length > 0) {
          hours = blocks.reduce((sum, b) => {
            const [bsh, bsm] = b.start.split(":").map(Number);
            const [beh, bem] = b.end.split(":").map(Number);
            return sum + ((beh * 60 + bem) - (bsh * 60 + bsm)) / 60;
          }, 0);
          timeDisplay = blocks.map(b => `${b.start}-${b.end}`).join(", ");
        } else {
          const [sh, sm] = (tr.startTime || "0:0").split(":").map(Number);
          const [eh, em] = (tr.endTime || "0:0").split(":").map(Number);
          hours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
        }

        // Financial calc for this entry
        const homeProperty = (trUser as any)?.homeProperty || "";
        const isOffSite = tr.property !== homeProperty && (trUser as any)?.allowOffSite;
        const rate = isOffSite ? parseFloat((trUser as any)?.offSiteRate || "0") : parseFloat((trUser as any)?.baseRate || "0");
        const laborCost = hours * rate;
        const milesVal = parseFloat(tr.miles || "0");
        const mileageVal = parseFloat(tr.mileageAmount || "0");
        const specialVal = tr.specialTerms ? parseFloat(tr.specialTermsAmount || "0") : 0;
        const entryCost = laborCost + mileageVal + specialVal;

        // Accumulate worker totals
        const existing = workerTotals.get(tr.userId) || { name, hours: 0, laborCost: 0, mileageVal: 0, specialVal: 0, entries: 0 };
        existing.hours += hours;
        existing.laborCost += laborCost;
        existing.mileageVal += mileageVal;
        existing.specialVal += specialVal;
        existing.entries += 1;
        workerTotals.set(tr.userId, existing);

        timeHtml += `<div style="background:#f0f4ff;padding:10px;border-radius:5px;margin:8px 0;">`;
        timeHtml += `<p><strong>${name}</strong> - ${tr.property}${isOffSite ? " (off-site)" : ""} (${timeDisplay}, ${hours.toFixed(1)}h)</p>`;
        if (accomplishmentsList.length > 0) {
          timeHtml += `<ul style="margin:4px 0;">${accomplishmentsList.map((a: string) => `<li>${a}</li>`).join("")}</ul>`;
        }
        timeHtml += `<p style="font-size:13px;color:#444;">Labor: ${hours.toFixed(1)}h × $${rate.toFixed(2)} = <strong>$${laborCost.toFixed(2)}</strong>`;
        timeHtml += ` | Miles: ${milesVal > 0 ? milesVal.toString() : "0"} ($${mileageVal.toFixed(2)})`;
        timeHtml += ` | Special Terms: $${specialVal.toFixed(2)}`;
        timeHtml += ` | <strong>Entry Total: $${entryCost.toFixed(2)}</strong></p>`;
        if (tr.notes) timeHtml += `<p style="color:#666;font-size:12px;">Notes: ${tr.notes}</p>`;
        timeHtml += `</div>`;
      }

      // Daily summary per worker
      timeHtml += `<h2 style="color:#333;border-bottom:1px solid #ddd;padding-bottom:5px;margin-top:20px;">Daily Summary</h2>`;
      timeHtml += `<table style="width:100%;border-collapse:collapse;margin:10px 0;">`;
      timeHtml += `<tr style="background:#f0f0f0;"><th style="text-align:left;padding:8px;border:1px solid #ddd;">Worker</th><th style="padding:8px;border:1px solid #ddd;">Entries</th><th style="padding:8px;border:1px solid #ddd;">Hours</th><th style="padding:8px;border:1px solid #ddd;">Labor</th><th style="padding:8px;border:1px solid #ddd;">Mileage</th><th style="padding:8px;border:1px solid #ddd;">Special</th><th style="padding:8px;border:1px solid #ddd;font-weight:bold;">Total</th></tr>`;
      let grandTotalHours = 0, grandTotalLabor = 0, grandTotalMileage = 0, grandTotalSpecial = 0;
      for (const [, wt] of workerTotals) {
        const workerTotal = wt.laborCost + wt.mileageVal + wt.specialVal;
        grandTotalHours += wt.hours;
        grandTotalLabor += wt.laborCost;
        grandTotalMileage += wt.mileageVal;
        grandTotalSpecial += wt.specialVal;
        timeHtml += `<tr>`;
        timeHtml += `<td style="padding:6px;border:1px solid #ddd;">${wt.name}</td>`;
        timeHtml += `<td style="padding:6px;border:1px solid #ddd;text-align:center;">${wt.entries}</td>`;
        timeHtml += `<td style="padding:6px;border:1px solid #ddd;text-align:right;">${wt.hours.toFixed(1)}h</td>`;
        timeHtml += `<td style="padding:6px;border:1px solid #ddd;text-align:right;">$${wt.laborCost.toFixed(2)}</td>`;
        timeHtml += `<td style="padding:6px;border:1px solid #ddd;text-align:right;">$${wt.mileageVal.toFixed(2)}</td>`;
        timeHtml += `<td style="padding:6px;border:1px solid #ddd;text-align:right;">$${wt.specialVal.toFixed(2)}</td>`;
        timeHtml += `<td style="padding:6px;border:1px solid #ddd;text-align:right;font-weight:bold;">$${workerTotal.toFixed(2)}</td>`;
        timeHtml += `</tr>`;
      }
      const grandTotal = grandTotalLabor + grandTotalMileage + grandTotalSpecial;
      timeHtml += `<tr style="background:#f8f8f8;font-weight:bold;">`;
      timeHtml += `<td style="padding:8px;border:1px solid #ddd;">TOTAL</td>`;
      timeHtml += `<td style="padding:8px;border:1px solid #ddd;text-align:center;">${todayTimeReports.length}</td>`;
      timeHtml += `<td style="padding:8px;border:1px solid #ddd;text-align:right;">${grandTotalHours.toFixed(1)}h</td>`;
      timeHtml += `<td style="padding:8px;border:1px solid #ddd;text-align:right;">$${grandTotalLabor.toFixed(2)}</td>`;
      timeHtml += `<td style="padding:8px;border:1px solid #ddd;text-align:right;">$${grandTotalMileage.toFixed(2)}</td>`;
      timeHtml += `<td style="padding:8px;border:1px solid #ddd;text-align:right;">$${grandTotalSpecial.toFixed(2)}</td>`;
      timeHtml += `<td style="padding:8px;border:1px solid #ddd;text-align:right;font-size:16px;">$${grandTotal.toFixed(2)}</td>`;
      timeHtml += `</tr></table>`;
    } else {
      timeHtml += `<p style="color:#888;">No work reports today.</p>`;
    }

    // Append Work Credits to the Daily Work Report
    const todayWorkCreditsForReport = await storage.getWorkCreditsByDate(date);
    if (todayWorkCreditsForReport.length > 0) {
      timeHtml += `<h2 style="color:#8b5cf6;border-bottom:1px solid #ddd;padding-bottom:5px;margin-top:25px;">Work Credits</h2>`;
      let wcDailyTotal = 0;
      for (const wc of todayWorkCreditsForReport) {
        const wcUser = allUsers.find(u => u.id === wc.userId);
        const wcName = wcUser?.displayName || "Unknown";
        let descList: string[] = [];
        try { descList = JSON.parse(wc.workDescriptions); } catch {}
        const amt = parseFloat(wc.totalAmount || "0");
        wcDailyTotal += amt;
        timeHtml += `<div style="background:#f5f0ff;padding:10px;border-radius:5px;margin:8px 0;">`;
        timeHtml += `<p><strong>${wc.tenantFirstName} ${wc.tenantLastName}</strong> - Lot/Unit: ${wc.lotOrUnit} - ${wc.property}</p>`;
        timeHtml += `<p style="font-size:12px;color:#666;">Submitted by: ${wcName}</p>`;
        timeHtml += `<p>Type: ${wc.creditType === "fixed" ? "Fixed Amount" : `Hourly (${wc.hoursWorked}h × $${wc.hourlyRate})`}</p>`;
        if (descList.length > 0) {
          timeHtml += `<ul style="margin:4px 0;">${descList.map((d: string) => `<li>${d}</li>`).join("")}</ul>`;
        }
        timeHtml += `<p style="font-weight:bold;">Credit: $${amt.toFixed(2)}</p>`;
        timeHtml += `</div>`;
      }
      timeHtml += `<div style="border-top:1px solid #8b5cf6;padding-top:8px;margin-top:10px;">`;
      timeHtml += `<p style="font-weight:bold;color:#8b5cf6;">Work Credits Total: ${todayWorkCreditsForReport.length} credits = $${wcDailyTotal.toFixed(2)}</p>`;
      timeHtml += `</div>`;
    }

    // Append Flat Rate Assignments to the Daily Work Report
    const todayFlatRatesForReport = await storage.getFlatRatesByDate(date);
    if (todayFlatRatesForReport.length > 0) {
      timeHtml += `<h2 style="color:#A12C7B;border-bottom:1px solid #ddd;padding-bottom:5px;margin-top:25px;">Flat Rate Assignments</h2>`;
      timeHtml += `<div style="background:#fdf3f9;padding:12px;border-left:4px solid #A12C7B;border-radius:4px;margin-bottom:10px;">`;
      let frDailyTotal = 0;
      for (const fr of todayFlatRatesForReport) {
        const submitter = (await storage.getUser(fr.userId))?.displayName || "Unknown";
        let accs: string[] = [];
        try { accs = JSON.parse(fr.accomplishments || "[]"); } catch {}
        const rateNum = parseFloat(fr.rate || "0");
        frDailyTotal += rateNum;
        timeHtml += `<div style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px dashed #e0c5d6;">`;
        timeHtml += `<p style="margin:2px 0;"><b>${submitter}</b> at <b>${fr.property}</b> — <b style="color:#A12C7B;">$${rateNum.toFixed(2)}</b></p>`;
        if (accs.length > 0) {
          timeHtml += `<ul style="margin:4px 0 4px 20px;padding:0;color:#444;">`;
          for (const a of accs) timeHtml += `<li>${a}</li>`;
          timeHtml += `</ul>`;
        }
        if (fr.notes) timeHtml += `<p style="margin:2px 0;color:#666;font-style:italic;">Notes: ${fr.notes}</p>`;
        timeHtml += `</div>`;
      }
      timeHtml += `<p style="font-weight:bold;color:#A12C7B;">Flat Rate Total: ${todayFlatRatesForReport.length} ${todayFlatRatesForReport.length === 1 ? "entry" : "entries"} = $${frDailyTotal.toFixed(2)}</p>`;
      timeHtml += `</div>`;
    }

    timeHtml += `<p style="color:#888;font-size:12px;margin-top:20px;">- Jetsetter Reporting</p></div>`;

    // Build Work Credits daily report
    const todayWorkCredits = await storage.getWorkCreditsByDate(date);
    let wcHtml = `<div style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;">`;
    wcHtml += `<h1 style="color:#8b5cf6;">Daily Work Credits Report - ${date}</h1>`;
    wcHtml += `<p style="color:#666;">Generated on ${new Date().toISOString().replace("T", " ").slice(0, 19)}</p>`;
    if (todayWorkCredits.length > 0) {
      let dailyTotal = 0;
      for (const wc of todayWorkCredits) {
        const wcUser = allUsers.find(u => u.id === wc.userId);
        const wcName = wcUser?.displayName || "Unknown";
        let descList: string[] = [];
        try { descList = JSON.parse(wc.workDescriptions); } catch {}
        const amt = parseFloat(wc.totalAmount || "0");
        dailyTotal += amt;
        wcHtml += `<div style="background:#f5f0ff;padding:10px;border-radius:5px;margin:8px 0;">`;
        wcHtml += `<p><strong>${wc.tenantFirstName} ${wc.tenantLastName}</strong> - Lot/Unit: ${wc.lotOrUnit} - ${wc.property}</p>`;
        wcHtml += `<p>Submitted by: ${wcName}</p>`;
        wcHtml += `<p>Type: ${wc.creditType === "fixed" ? "Fixed" : `Hourly (${wc.hoursWorked}h × $${wc.hourlyRate})`}</p>`;
        if (descList.length > 0) {
          wcHtml += `<ul style="margin:4px 0;">${descList.map((d: string) => `<li>${d}</li>`).join("")}</ul>`;
        }
        wcHtml += `<p style="font-weight:bold;font-size:16px;">Credit: $${amt.toFixed(2)}</p>`;
        wcHtml += `</div>`;
      }
      wcHtml += `<div style="border-top:2px solid #333;padding-top:10px;margin-top:15px;">`;
      wcHtml += `<p style="font-size:18px;font-weight:bold;">Daily Total: ${todayWorkCredits.length} credits = $${dailyTotal.toFixed(2)}</p>`;
      wcHtml += `</div>`;
    } else {
      wcHtml += `<p style="color:#888;">No work credits today.</p>`;
    }
    wcHtml += `<p style="color:#888;font-size:12px;margin-top:20px;">- Jetsetter Reporting</p></div>`;

    // Document upload status for daily summary
    let docStatusHtml = '<h2 style="color:#333;margin-top:20px;">Document Upload Status</h2>';
    const allDocs = await Promise.all(allUsers.map(async (u: any) => {
      const docs = await storage.getUserDocuments(u.id);
      const hasPhotoId = docs.some((d: any) => d.docType === "photo_id");
      const hasBanking = docs.some((d: any) => d.docType === "banking");
      const hasW9 = docs.some((d: any) => d.docType === "w9");
      const isComplete = hasPhotoId && hasBanking && hasW9;
      return { name: u.displayName, role: u.role, hasPhotoId, hasBanking, hasW9, isComplete, docsComplete: u.docsComplete };
    }));
    const incomplete = allDocs.filter(d => !d.isComplete && (d.role === "manager" || d.role === "contractor"));
    if (incomplete.length > 0) {
      docStatusHtml += '<table style="width:100%;border-collapse:collapse;margin:8px 0;">';
      docStatusHtml += '<tr style="background:#f0f0f0;"><th style="text-align:left;padding:6px;border:1px solid #ddd;">User</th><th style="padding:6px;border:1px solid #ddd;">Photo ID</th><th style="padding:6px;border:1px solid #ddd;">Banking</th><th style="padding:6px;border:1px solid #ddd;">W-9</th></tr>';
      for (const d of incomplete) {
        const check = '\u2705';
        const miss = '\u274C';
        docStatusHtml += `<tr><td style="padding:6px;border:1px solid #ddd;">${d.name}</td>`;
        docStatusHtml += `<td style="padding:6px;border:1px solid #ddd;text-align:center;">${d.hasPhotoId ? check : miss}</td>`;
        docStatusHtml += `<td style="padding:6px;border:1px solid #ddd;text-align:center;">${d.hasBanking ? check : miss}</td>`;
        docStatusHtml += `<td style="padding:6px;border:1px solid #ddd;text-align:center;">${d.hasW9 ? check : miss}</td></tr>`;
      }
      docStatusHtml += '</table>';
    } else {
      docStatusHtml += '<p style="color:#437a22;">All users have completed their document uploads.</p>';
    }

    // Contractor document status for daily summary
    const allContractorDocs = await storage.getAllContractorDocuments();
    if (allContractorDocs.length > 0) {
      // Group by contractor name
      const byContractor = new Map<string, typeof allContractorDocs>();
      for (const cd of allContractorDocs) {
        const key = `${cd.contractorFirstName} ${cd.contractorLastName}`;
        if (!byContractor.has(key)) byContractor.set(key, []);
        byContractor.get(key)!.push(cd);
      }
      docStatusHtml += '<h2 style="color:#333;margin-top:20px;">Contractor Document Status</h2>';
      docStatusHtml += '<table style="width:100%;border-collapse:collapse;margin:8px 0;">';
      docStatusHtml += '<tr style="background:#f0f0f0;"><th style="text-align:left;padding:6px;border:1px solid #ddd;">Contractor</th><th style="padding:6px;border:1px solid #ddd;">Photo ID</th><th style="padding:6px;border:1px solid #ddd;">Banking</th><th style="padding:6px;border:1px solid #ddd;">W-9</th></tr>';
      const check = '\u2705';
      const miss = '\u274C';
      for (const [name, docs] of byContractor) {
        const hasPhotoId = docs.some(d => d.docType === "photo_id");
        const hasBanking = docs.some(d => d.docType === "banking");
        const hasW9 = docs.some(d => d.docType === "w9");
        docStatusHtml += `<tr><td style="padding:6px;border:1px solid #ddd;">${name}</td>`;
        docStatusHtml += `<td style="padding:6px;border:1px solid #ddd;text-align:center;">${hasPhotoId ? check : miss}</td>`;
        docStatusHtml += `<td style="padding:6px;border:1px solid #ddd;text-align:center;">${hasBanking ? check : miss}</td>`;
        docStatusHtml += `<td style="padding:6px;border:1px solid #ddd;text-align:center;">${hasW9 ? check : miss}</td></tr>`;
      }
      docStatusHtml += '</table>';
    }
    // ---- Build ONE consolidated daily report ----
    // Strip leading/trailing wrappers from individual section HTMLs so they slot cleanly
    // into the master document. We intentionally keep the existing per-section HTML —
    // we just compose them with shared header/TOC/footer.
    //
    // Helpers for stripping the outer <div>...</div> + heading/footer from each section:
    const innerOf = (s: string) => {
      // Remove the leading `<div ...>` wrapper and trailing `</div>` and the section's
      // own <h1> + generated-on <p> + footer <p> so we don't repeat them.
      let body = s;
      body = body.replace(/^<div [^>]*>/, "");
      body = body.replace(/<\/div>\s*$/, "");
      body = body.replace(/<h1[^>]*>[\s\S]*?<\/h1>\s*<p[^>]*>Generated on[^<]*<\/p>/i, "");
      body = body.replace(/<p[^>]*>-\s*(Receipt App Daily Report|Jetsetter Reporting)<\/p>/gi, "");
      return body;
    };

    const txInner = innerOf(html);          // receipts + cash + cash-on-hand
    const timeInner = innerOf(timeHtml);    // time + work credits + flat rate (already grouped)
    // wcHtml content is already included inside timeHtml; we don't duplicate it.

    // Compute high-level totals for the executive summary banner
    const totalReceipts = todayInvoices.length;
    const totalCash = todayCash.length;
    const totalTime = todayTimeReports.length;
    const totalWC = todayWorkCreditsForReport.length;
    const totalFR = todayFlatRatesForReport.length;
    const anyActivity = totalReceipts + totalCash + totalTime + totalWC + totalFR > 0;

    const consolidated = `<div style="font-family:Arial,sans-serif;max-width:820px;margin:0 auto;color:#28251D;">
      <div style="background:#01696F;padding:20px;text-align:center;border-radius:6px 6px 0 0;">
        <h1 style="color:white;margin:0;font-size:22px;">Jetsetter Daily Report</h1>
        <p style="color:#cfeef0;margin:4px 0 0;font-size:13px;">${date}</p>
      </div>
      <div style="padding:18px;">
        <p style="color:#666;font-size:12px;margin:0 0 12px;">Generated ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</p>
        ${!anyActivity ? `<p style="background:#f7f6f2;padding:14px;border-radius:6px;color:#7A7974;">No activity logged today.</p>` : `
        <div style="background:#f7f6f2;padding:14px;border-radius:6px;margin-bottom:18px;">
          <p style="margin:0 0 6px;font-weight:bold;color:#01696F;">Today at a glance</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <tr><td style="padding:3px 0;color:#666;">Credit-card receipts</td><td style="padding:3px 0;text-align:right;font-weight:bold;">${totalReceipts}</td></tr>
            <tr><td style="padding:3px 0;color:#666;">Cash transactions</td><td style="padding:3px 0;text-align:right;font-weight:bold;">${totalCash}</td></tr>
            <tr><td style="padding:3px 0;color:#666;">Work reports</td><td style="padding:3px 0;text-align:right;font-weight:bold;">${totalTime}</td></tr>
            <tr><td style="padding:3px 0;color:#666;">Work credits</td><td style="padding:3px 0;text-align:right;font-weight:bold;">${totalWC}</td></tr>
            <tr><td style="padding:3px 0;color:#666;">Flat-rate assignments</td><td style="padding:3px 0;text-align:right;font-weight:bold;">${totalFR}</td></tr>
          </table>
        </div>
        <div style="background:#fbfbf9;padding:10px 14px;border:1px solid #e7e5dc;border-radius:6px;margin-bottom:18px;font-size:13px;">
          <p style="margin:0 0 4px;font-weight:bold;color:#01696F;">Sections in this report</p>
          <ol style="margin:0;padding-left:20px;color:#444;">
            ${(totalReceipts + totalCash) > 0 ? `<li>Transactions — receipts, cash, cash on hand</li>` : `<li style="color:#aaa;">Transactions (no activity)</li>`}
            ${(totalTime + totalWC + totalFR) > 0 ? `<li>Work — work reports, work credits, flat-rate assignments</li>` : `<li style="color:#aaa;">Work (no activity)</li>`}
            <li>Document upload status</li>
          </ol>
        </div>`}
        <h2 style="color:#01696F;border-bottom:2px solid #01696F;padding:0 0 6px;margin:24px 0 10px;">1. Transactions</h2>
        ${txInner || '<p style="color:#888;">No transactions today.</p>'}
        <h2 style="color:#3b82f6;border-bottom:2px solid #3b82f6;padding:0 0 6px;margin:32px 0 10px;">2. Work</h2>
        ${timeInner || '<p style="color:#888;">No work activity today.</p>'}
        <h2 style="color:#7A7974;border-bottom:2px solid #7A7974;padding:0 0 6px;margin:32px 0 10px;">3. Document upload status</h2>
        ${docStatusHtml.replace(/^<h2[^>]*>[^<]*<\/h2>/, "")}
        <p style="color:#888;font-size:11px;margin-top:30px;text-align:center;border-top:1px solid #e7e5dc;padding-top:12px;">- Jetsetter Reporting</p>
      </div>
    </div>`;

    // Recipients = union of every old subscriber set, deduplicated by email
    const sentTo: string[] = [];
    const recipientMap = new Map<string, { name: string; email: string }>();
    for (const u of allUsers as any[]) {
      if (!u.email) continue;
      const subscribed =
        u.dailyTransactionReport ||
        u.dailyTimeReport ||
        u.workCreditReport ||
        u.dailyReport; // legacy flag
      if (!subscribed) continue;
      // Hard exclude the company inbox — it was previously CC'd separately and
      // the user has asked for it to be dropped entirely from the daily report.
      if (u.email.toLowerCase() === "jetsettercapitalllc@gmail.com") continue;
      recipientMap.set(u.email.toLowerCase(), { name: u.displayName, email: u.email });
    }
    const consolidatedRecipients = Array.from(recipientMap.values());

    if (consolidatedRecipients.length > 0) {
      await sendEmailToRecipients(
        consolidatedRecipients,
        `Jetsetter Daily Report \u2014 ${date}`,
        consolidated
      );
      sentTo.push(...consolidatedRecipients.map(r => r.email));
    }

    // Archive: still upload the daily report HTML to the "Daily Reporting" Drive
    // folder so the historical archive is preserved, but DO NOT email it to the
    // company inbox anymore (the subscriber list already covers the right people).
    try {
      const reportFilePath = path.resolve(dataDir, `daily-report-${date}.html`);
      fs.writeFileSync(reportFilePath, consolidated);

      if (isGoogleEnabled()) {
        try {
          const dailyFolder = await ensureDriveFolder("Daily Reporting");
          if (dailyFolder) {
            await uploadToDrive(reportFilePath, `Jetsetter_Daily_Report_${date}.html`, dailyFolder);
          }
        } catch (e) { console.error("[daily-report] Drive folder upload failed:", e); }
      }

      try { fs.unlinkSync(reportFilePath); } catch {}
    } catch (e) { console.error("[daily-report] Failed to archive daily report:", e); }

    // The consolidated email replaces the old per-flag tx/time/work-credit emails.

    // Update document tracking spreadsheet
    try { await updateDocTrackingSheet(); } catch (e) { console.error("[doc-tracking] Daily update failed:", e); }

    res.json({ ok: true, date, receipts: todayInvoices.length, cashTx: todayCash.length, timeReports: todayTimeReports.length, workCredits: todayWorkCredits.length, sentTo: [...new Set(sentTo)] });
  });

  app.get("/api/invoices/export", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;

    let invoicesList;
    if (isAdminRole(session.role)) {
      invoicesList = await storage.getAllInvoices();
    } else {
      invoicesList = await getVisibleInvoicesForUser(session.userId);
    }

    const allUsers = await storage.getAllUsers();
    const userMap = new Map(allUsers.map(u => [u.id, u.displayName]));

    // Generate CSV
    const headers = ["Property", "Date", "Description", "Purpose", "Amount", "Bought By", "Payment Method", "Last 4 Digits", "Submitted By", "Created At"];
    const rows = invoicesList.map(inv => [
      `"${(inv.property || "").replace(/"/g, '""')}"`,
      inv.purchaseDate,
      `"${inv.description.replace(/"/g, '""')}"`,
      `"${inv.purpose.replace(/"/g, '""')}"`,
      inv.amount,
      `"${inv.boughtBy.replace(/"/g, '""')}"`,
      inv.paymentMethod === "cc" ? "Credit Card" : "Cash",
      inv.lastFourDigits || "",
      `"${(userMap.get(inv.userId) || "Unknown").replace(/"/g, '""')}"`,
      inv.createdAt,
    ]);

    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=invoices.csv");
    res.send(csv);
  });

  // ---- CASH TRANSACTIONS ----
  app.post("/api/cash-transactions", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;

    const { property, type, category, amount, date, unitLotNumber, tenantName, bankName, description, photoPath, photoPaths, payerName, notes } = req.body;
    if (!property || !type || !category || !amount || !date) {
      return res.status(400).json({ error: "property, type, category, amount, and date are required" });
    }
    if (!["income", "spent"].includes(type)) {
      return res.status(400).json({ error: "type must be 'income' or 'spent'" });
    }

    const user = await storage.getUser(session.userId);
    const recordNumber = await storage.getNextCashRecordNumber(property);
    const propertyCode = await storage.getNextPropertyCode(property);
    const tx = await storage.createCashTransaction({
      userId: session.userId,
      property,
      type,
      category,
      amount,
      date,
      unitLotNumber: unitLotNumber || null,
      tenantName: tenantName || null,
      bankName: bankName || null,
      description: description || null,
      payerName: payerName || null,
      notes: notes || null,
      photoPath: photoPath || null,
      photoPaths: photoPaths || null,
      recordNumber,
      propertyCode,
      syncedToSheets: 0,
      syncedToDrive: 0,
      createdAt: new Date().toISOString(),
    } as any);

    res.json(tx);

    // Background sync and email notification
    setImmediate(async () => {
      const submittedByName = user?.displayName || "Unknown";
      // Sync to Cash Sheets
      if (isGoogleEnabled() && cashSheetsConfig && cashSheetsConfig.tabs[property]) {
        try {
          const balance = await storage.getCashBalanceByProperty(property);
          // Column K (was String(recordNumber)) now carries the per-property
          // receipt identifier (e.g. "TE-7"). Keep the column index the same so
          // existing column letters in the spreadsheet keep their meaning.
          const receiptId = propertyCode || String(recordNumber);
          const row = [date, type, category, amount, unitLotNumber || "", tenantName || payerName || "", bankName || "", description || notes || "", submittedByName, new Date().toISOString(), receiptId, String(balance.toFixed(2))];
          const ok = await appendSheetRow(cashSheetsConfig.spreadsheetId, property, row);
          if (ok) await storage.updateCashTransactionSyncStatus(tx.id, "sheets", true);
        } catch (e) { console.error("[cash-sheets] Sync error:", e); }
      }
      // Drive sync for photos
      if (isGoogleEnabled() && photoPath) {
        try {
          const typeLabel = type === "income" ? "Income" : "Spent";
          const filePath = path.resolve(dataDir, "uploads", photoPath.replace(/^\/api\/uploads\//, ""));
          if (fs.existsSync(filePath)) {
            // Folder structure: Credit Card and Cash Receipts > Cash Receipts > Property
            let cashFolder = propertyFolderCache.get("__cash_root") || null;
            if (!cashFolder) {
              const mainReceiptsFolder = await getReceiptsRootFolderId();
              if (mainReceiptsFolder) {
                cashFolder = await ensureDriveFolder("Cash Receipts", mainReceiptsFolder);
                if (cashFolder) propertyFolderCache.set("__cash_root", cashFolder);
              }
            }
            let propFolder = propertyFolderCache.get("cash_" + property) || null;
            if (!propFolder && cashFolder) {
              propFolder = await ensureDriveFolder(property, cashFolder);
              if (propFolder) propertyFolderCache.set("cash_" + property, propFolder);
            }
            const ext = path.extname(filePath).slice(1) || "jpg";
            const codeSuffix = propertyCode ? ` ${propertyCode}` : "";
            const driveFileName = `Cash ${typeLabel}_${property}_${date}${codeSuffix}.${ext}`;
            await uploadToDrive(filePath, driveFileName, propFolder || cashFolder || undefined);
            await storage.updateCashTransactionSyncStatus(tx.id, "drive", true);
          }
        } catch (e) { console.error("[cash-drive] Sync error:", e); }
      }
      try {
        const typeLabel = type === "income" ? "Income" : "Spent";
        await sendNotificationEmails(
          `Cash ${typeLabel}: $${amount} - ${property}`,
          `<h3>New Cash ${typeLabel} Transaction</h3>
           <p><strong>Property:</strong> ${property}</p>
           <p><strong>Type:</strong> ${typeLabel}</p>
           <p><strong>Category:</strong> ${category}</p>
           <p><strong>Amount:</strong> $${amount}</p>
           <p><strong>Date:</strong> ${date}</p>
           ${description ? `<p><strong>Description:</strong> ${description}</p>` : ""}
           ${tenantName ? `<p><strong>Tenant:</strong> ${tenantName}</p>` : ""}
           ${unitLotNumber ? `<p><strong>Unit/Lot:</strong> ${unitLotNumber}</p>` : ""}
           ${bankName ? `<p><strong>Bank:</strong> ${bankName}</p>` : ""}
           <p><strong>Submitted By:</strong> ${submittedByName}</p>
           <p><strong>Record #:</strong> ${recordNumber}</p>`,
          photoPath ? [{ filename: path.basename(photoPath.replace(/^\/api\/uploads\//, "")), path: path.resolve(dataDir, "uploads", photoPath.replace(/^\/api\/uploads\//, "")) }] : []
        );
      } catch (e) { console.error("[email] Cash tx notification error:", e); }
    });
  });

  app.get("/api/cash-transactions", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;

    let txList;
    if (isAdminRole(session.role)) {
      txList = await storage.getAllCashTransactions();
    } else {
      txList = await storage.getCashTransactionsByUser(session.userId);
    }

    const allUsers = await storage.getAllUsers();
    const userMap = new Map(allUsers.map(u => [u.id, u.displayName]));
    const enriched = txList.map(tx => ({
      ...tx,
      submittedBy: userMap.get(tx.userId) || "Unknown",
      photoPaths: tx.photoPaths ? JSON.parse(tx.photoPaths) : (tx.photoPath ? [tx.photoPath] : []),
    }));

    res.json(enriched);
  });

  app.get("/api/cash-transactions/export", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    if (!isAdminRole(session.role)) return res.status(403).json({ error: "Admin only" });

    const txs = await storage.getAllCashTransactions();
    const users = await storage.getAllUsers();
    const userMap = new Map(users.map((u: any) => [u.id, u.displayName]));

    const headers = ["Date", "Property", "Type", "Category", "Amount", "Unit/Lot", "Tenant Name", "Bank Name", "Description", "Submitted By", "Record #", "Edited"];
    const rows = txs.map(tx => {
      const submittedBy = userMap.get(tx.userId) || "Unknown";
      const edited = tx.editHistory ? "Yes" : "";
      return [
        tx.date,
        `"${(tx.property || "").replace(/"/g, '""')}"`,
        tx.type,
        `"${(tx.category || "").replace(/"/g, '""')}"`,
        tx.amount,
        `"${(tx.unitLotNumber || "").replace(/"/g, '""')}"`,
        `"${(tx.tenantName || "").replace(/"/g, '""')}"`,
        `"${(tx.bankName || "").replace(/"/g, '""')}"`,
        `"${(tx.description || "").replace(/"/g, '""')}"`,
        `"${submittedBy.replace(/"/g, '""')}"`,
        String(tx.recordNumber || ""),
        edited,
      ].join(",");
    });

    const csv = [headers.join(","), ...rows].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=cash-transactions.csv");
    res.send(csv);
  });

  app.delete("/api/cash-transactions/:id", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const tx = await storage.getCashTransaction(id);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });

    if (!isAdminRole(session.role) && tx.userId !== session.userId) {
      return res.status(403).json({ error: "Not authorized" });
    }

    await storage.deleteCashTransaction(id);
    res.json({ ok: true });
  });

  app.put("/api/cash-transactions/:id", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const existing = await storage.getCashTransaction(id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    if (!isAdminRole(session.role) && existing.userId !== session.userId) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const { category, amount, date, unitLotNumber, tenantName, bankName, description } = req.body;

    // Track changes
    const changes: string[] = [];
    if (amount !== undefined && amount !== existing.amount) changes.push(`Amount: $${existing.amount} → $${amount}`);
    if (category !== undefined && category !== existing.category) changes.push(`Category: "${existing.category}" → "${category}"`);
    if (description !== undefined && description !== (existing.description || "")) changes.push(`Description: "${existing.description || ""}" → "${description}"`);
    if (date !== undefined && date !== existing.date) changes.push(`Date: "${existing.date}" → "${date}"`);
    if (unitLotNumber !== undefined && unitLotNumber !== (existing.unitLotNumber || "")) changes.push(`Unit/Lot: "${existing.unitLotNumber || ""}" → "${unitLotNumber}"`);
    if (tenantName !== undefined && tenantName !== (existing.tenantName || "")) changes.push(`Tenant: "${existing.tenantName || ""}" → "${tenantName}"`);
    if (bankName !== undefined && bankName !== (existing.bankName || "")) changes.push(`Bank: "${existing.bankName || ""}" → "${bankName}"`);

    const editUser = await storage.getUser(session.userId);
    const editEntry = { by: editUser?.displayName || "Unknown", at: new Date().toISOString(), changes };
    const existingHistory = existing.editHistory ? JSON.parse(existing.editHistory) : [];
    existingHistory.push(editEntry);

    const updated = await storage.updateCashTransaction(id, {
      category: category ?? existing.category,
      amount: amount ?? existing.amount,
      date: date ?? existing.date,
      unitLotNumber: unitLotNumber ?? existing.unitLotNumber,
      tenantName: tenantName ?? existing.tenantName,
      bankName: bankName ?? existing.bankName,
      description: description ?? existing.description,
      editHistory: JSON.stringify(existingHistory),
    });

    res.json(updated);

    // Background: update the Cash Sheets row
    if (isGoogleEnabled() && cashSheetsConfig && updated && cashSheetsConfig.tabs[existing.property]) {
      setImmediate(async () => {
        try {
          const submittedByName = editUser?.displayName || "Unknown";
          // Delete old row and add updated one
          await deleteSheetRow(cashSheetsConfig!.spreadsheetId, existing.property, existing.date, existing.type, existing.amount);
          const balance = await storage.getCashBalanceByProperty(existing.property);
          await appendSheetRow(cashSheetsConfig!.spreadsheetId, existing.property, [
            updated.date, updated.type, updated.category, updated.amount,
            updated.unitLotNumber || "", updated.tenantName || "", updated.bankName || "",
            updated.description || "", submittedByName, updated.createdAt,
            String(updated.recordNumber || ""), String(balance.toFixed(2)),
            `EDITED by ${editEntry.by} at ${editEntry.at}: ${editEntry.changes.join("; ")}`,
          ]);
          // Highlight edited row in yellow
          await highlightLastRow(cashSheetsConfig!.spreadsheetId, existing.property, { red: 1, green: 1, blue: 0.6 });
        } catch (e) { console.error("[cash-edit] Sheets sync failed:", e); }
      });
    }
  });

  app.get("/api/cash-balances", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;

    let props;
    if (isAdminRole(session.role)) {
      props = await storage.getAllProperties();
    } else {
      props = await storage.getPropertiesForUser(session.userId);
    }

    const balances: Record<string, number> = {};
    for (const p of props) {
      balances[p.name] = await storage.getCashBalanceByProperty(p.name);
    }
    res.json(balances);
  });

  // ============================================================
  // CHECK TRANSACTIONS
  // Dedicated from Cash. Each check counts toward "Checks on Hand"
  // until marked deposited.
  // ============================================================

  // Helper: rebuild ONE property tab in the Checks spreadsheet.
  async function rebuildCheckSheetForProperty(propertyName: string): Promise<{ ok: boolean; reason?: string; rows?: number }> {
    if (!isGoogleEnabled()) return { ok: false, reason: "google-disabled" };
    if (!checkSheetsConfig?.spreadsheetId) return { ok: false, reason: "no-config" };
    const headers = [
      "Date", "Property", "Amount", "From", "Unit/Lot",
      "Check #", "Notes", "Deposited", "Deposited At", "Deposit Slip",
      "Submitted By", "Submitted At", "Record #", "Property Code",
    ];
    await createSheetTab(checkSheetsConfig.spreadsheetId, propertyName, headers);
    await updateSheetRange(checkSheetsConfig.spreadsheetId, `'${propertyName}'!A1`, [headers]);
    await clearSheet(checkSheetsConfig.spreadsheetId, `'${propertyName}'!A2:Z`);

    const all = (await storage.getAllCheckTransactions()).filter(c => c.property === propertyName);
    const sorted = [...all].sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length === 0) return { ok: true, rows: 0 };

    const allUsers = await storage.getAllUsers();
    const userMap = new Map(allUsers.map(u => [u.id, u.displayName]));
    const rows: string[][] = sorted.map(c => [
      c.date, c.property, c.amount,
      c.payerName || "", c.unitLotNumber || "",
      c.checkNumber || "", c.notes || "",
      c.deposited ? "Yes" : "No",
      c.depositedAt || "",
      (c as any).depositPhotoPath || "",
      userMap.get(c.userId) || `User ${c.userId}`,
      c.createdAt,
      String(c.recordNumber || ""),
      c.propertyCode || "",
    ]);
    await updateSheetRange(checkSheetsConfig.spreadsheetId, `'${propertyName}'!A2`, rows);
    return { ok: true, rows: rows.length };
  }

  app.post("/api/check-transactions", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const { property, amount, date, payerName, checkNumber, unitLotNumber, notes, photoPath, photoPaths, deposited } = req.body;
    if (!property || !amount || !date) {
      return res.status(400).json({ error: "property, amount and date are required" });
    }
    if (!payerName) {
      return res.status(400).json({ error: "From (payerName) is required for a check" });
    }
    const user = await storage.getUser(session.userId);
    const recordNumber = await storage.getNextCashRecordNumber(property); // shared per-property counter
    const propertyCode = await storage.getNextPropertyCode(property);
    const nowIso = new Date().toISOString();
    const tx = await storage.createCheckTransaction({
      userId: session.userId,
      property,
      amount,
      date,
      payerName,
      checkNumber: checkNumber || null,
      unitLotNumber: unitLotNumber || null,
      notes: notes || null,
      photoPath: photoPath || null,
      photoPaths: photoPaths || null,
      deposited: deposited ? 1 : 0,
      depositedAt: deposited ? nowIso : null,
      recordNumber,
      propertyCode,
      syncedToSheets: 0,
      syncedToDrive: 0,
      createdAt: nowIso,
    } as any);
    res.json(tx);

    // Background sync to Sheets + Drive + email
    setImmediate(async () => {
      try {
        if (checkSheetsConfig?.spreadsheetId) {
          await rebuildCheckSheetForProperty(property);
        }
      } catch (e) { console.error("[check-sheets] sync error:", e); }
      // Drive: same folder pattern as Cash, under "Credit Card and Cash Receipts/Check Receipts/<property>".
      if (isGoogleEnabled() && photoPath) {
        try {
          const filePath = path.resolve(dataDir, "uploads", photoPath.replace(/^\/api\/uploads\//, ""));
          if (fs.existsSync(filePath)) {
            let rootFolder = propertyFolderCache.get("__check_root") || null;
            if (!rootFolder) {
              const main = await getReceiptsRootFolderId();
              if (main) {
                rootFolder = await ensureDriveFolder("Check Receipts", main);
                if (rootFolder) propertyFolderCache.set("__check_root", rootFolder);
              }
            }
            let propFolder = propertyFolderCache.get("check_" + property) || null;
            if (!propFolder && rootFolder) {
              propFolder = await ensureDriveFolder(property, rootFolder);
              if (propFolder) propertyFolderCache.set("check_" + property, propFolder);
            }
            const ext = path.extname(filePath).slice(1) || "jpg";
            const codeSuffix = propertyCode ? ` ${propertyCode}` : "";
            const driveFileName = `Check_${property}_${date}${codeSuffix}.${ext}`;
            await uploadToDrive(filePath, driveFileName, propFolder || rootFolder || undefined);
          }
        } catch (e) { console.error("[check-drive] sync error:", e); }
      }
      try {
        await sendNotificationEmails(
          `Check received: $${amount} - ${property}`,
          `<h3>New Check Transaction</h3>
           <p><strong>Property:</strong> ${property}</p>
           <p><strong>Amount:</strong> $${amount}</p>
           <p><strong>From:</strong> ${payerName}</p>
           <p><strong>Date:</strong> ${date}</p>
           ${checkNumber ? `<p><strong>Check #:</strong> ${checkNumber}</p>` : ""}
           ${unitLotNumber ? `<p><strong>Unit/Lot:</strong> ${unitLotNumber}</p>` : ""}
           ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ""}
           <p><strong>Deposited at submission:</strong> ${deposited ? "Yes" : "No"}</p>
           <p><strong>Submitted by:</strong> ${user?.displayName || ""}</p>
           <p><strong>Record #:</strong> ${recordNumber} (${propertyCode || ""})</p>`,
          photoPath ? [{ filename: path.basename(photoPath.replace(/^\/api\/uploads\//, "")), path: path.resolve(dataDir, "uploads", photoPath.replace(/^\/api\/uploads\//, "")) }] : []
        );
      } catch (e) { console.error("[email] check notification error:", e); }
    });
  });

  app.get("/api/check-transactions", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    let txList;
    if (isAdminRole(session.role)) {
      txList = await storage.getAllCheckTransactions();
    } else {
      // Property managers see their own + their crew's checks (home base scope);
      // contractors see only their own. Mirror the visibility used by
      // /api/cash-transactions to keep these features consistent.
      const allowed = await getVisibleUserIdsForManager(session.userId);
      const all = await storage.getAllCheckTransactions();
      txList = all.filter(c => allowed.has(c.userId));
    }
    const allUsers = await storage.getAllUsers();
    const userMap = new Map(allUsers.map(u => [u.id, u.displayName]));
    const enriched = txList.map(t => ({ ...t, submittedBy: userMap.get(t.userId) || "Unknown" }));
    res.json(enriched);
  });

  app.put("/api/check-transactions/:id", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const existing = await storage.getCheckTransaction(id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    if (existing.userId !== session.userId && !isAdminRole(session.role)) {
      return res.status(403).json({ error: "Not authorized" });
    }
    const { amount, date, payerName, checkNumber, unitLotNumber, notes, deposited } = req.body;
    const updateData: any = {};
    if (amount !== undefined) updateData.amount = String(amount);
    if (date !== undefined) updateData.date = date;
    if (payerName !== undefined) updateData.payerName = payerName;
    if (checkNumber !== undefined) updateData.checkNumber = checkNumber || null;
    if (unitLotNumber !== undefined) updateData.unitLotNumber = unitLotNumber || null;
    if (notes !== undefined) updateData.notes = notes || null;
    if (deposited !== undefined) {
      updateData.deposited = deposited ? 1 : 0;
      updateData.depositedAt = deposited ? new Date().toISOString() : null;
    }
    const updated = await storage.updateCheckTransaction(id, updateData);
    res.json(updated);
    setImmediate(async () => {
      try { await rebuildCheckSheetForProperty(existing.property); } catch {}
    });
  });

  // Convenience endpoint for the "Mark as deposited" button.
  // Body: { depositPhotoPath: string }  — photo of the deposit slip /
  // mobile-deposit confirmation, captured at the moment of deposit.
  app.post("/api/check-transactions/:id/deposit", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    const existing = await storage.getCheckTransaction(id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    if (existing.userId !== session.userId && !isAdminRole(session.role)) {
      return res.status(403).json({ error: "Not authorized" });
    }
    // The deposit-slip photo is now OPTIONAL. The dashboard confirmation
    // dialog alone is sufficient for marking a check deposited; if the user
    // still wants to attach a slip later we'll re-add it as an explicit
    // optional upload UI rather than gating the flow on it.
    const { depositPhotoPath } = req.body || {};
    const updated = await storage.updateCheckTransaction(id, {
      deposited: 1,
      depositedAt: new Date().toISOString(),
      depositPhotoPath: depositPhotoPath || null,
    } as any);
    res.json(updated);
    setImmediate(async () => {
      try { await rebuildCheckSheetForProperty(existing.property); } catch {}
      // Also push the deposit slip to Drive next to the check photo.
      if (isGoogleEnabled() && depositPhotoPath) {
        try {
          const filePath = path.resolve(dataDir, "uploads", depositPhotoPath.replace(/^\/api\/uploads\//, ""));
          if (fs.existsSync(filePath)) {
            let rootFolder = propertyFolderCache.get("__check_root") || null;
            if (!rootFolder) {
              const main = await getReceiptsRootFolderId();
              if (main) {
                rootFolder = await ensureDriveFolder("Check Receipts", main);
                if (rootFolder) propertyFolderCache.set("__check_root", rootFolder);
              }
            }
            let propFolder = propertyFolderCache.get("check_" + existing.property) || null;
            if (!propFolder && rootFolder) {
              propFolder = await ensureDriveFolder(existing.property, rootFolder);
              if (propFolder) propertyFolderCache.set("check_" + existing.property, propFolder);
            }
            const ext = path.extname(filePath).slice(1) || "jpg";
            const codeSuffix = existing.propertyCode ? ` ${existing.propertyCode}` : "";
            const driveFileName = `Deposit_${existing.property}_${existing.date}${codeSuffix}.${ext}`;
            await uploadToDrive(filePath, driveFileName, propFolder || rootFolder || undefined);
          }
        } catch (e) { console.error("[check-deposit-drive] sync error:", e); }
      }
    });
  });

  app.delete("/api/check-transactions/:id", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    const existing = await storage.getCheckTransaction(id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    if (existing.userId !== session.userId && !isAdminRole(session.role)) {
      return res.status(403).json({ error: "Not authorized" });
    }
    await storage.deleteCheckTransaction(id);
    res.json({ ok: true });
    setImmediate(async () => {
      try { await rebuildCheckSheetForProperty(existing.property); } catch {}
    });
  });

  // Per-property un-deposited totals — powers the "Checks on Hand" dashboard card.
  app.get("/api/check-transactions/balances", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const props = isAdminRole(session.role)
      ? await storage.getAllProperties()
      : await storage.getPropertiesForUser(session.userId);
    const allChecks = await storage.getAllCheckTransactions();
    const balances: Record<string, number> = {};
    for (const p of props) {
      const sum = allChecks
        .filter(c => c.property === p.name && !c.deposited)
        .reduce((acc, c) => acc + parseFloat(c.amount || "0"), 0);
      balances[p.name] = sum;
    }
    res.json(balances);
  });

  // Admin-only: provision the Check spreadsheet and create one tab per property.
  // Admin diagnostic / control for the receipts root Drive folder. Lets you
  // see the currently-active folder ID and (if needed) point the app at a
  // specific Drive folder ID so all uploads go into the same one.
  app.get("/api/admin/drive-folder", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    let exists = false;
    if (driveFolderConfig.receiptsRootId && isGoogleEnabled()) {
      try { exists = await driveFolderExists(driveFolderConfig.receiptsRootId); } catch {}
    }
    res.json({
      receiptsRootId: driveFolderConfig.receiptsRootId || null,
      exists,
      cacheKeys: Array.from(propertyFolderCache.keys()),
    });
  });
  // Force the discovery to run NOW so the folder ID gets persisted before any
  // upload happens. Idempotent — calls getReceiptsRootFolderId() which only
  // searches if there's no cached ID, then writes the config.
  app.post("/api/admin/drive-folder/discover", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    if (!isGoogleEnabled()) return res.status(400).json({ error: "Google API not configured" });
    const id = await getReceiptsRootFolderId();
    if (!id) return res.status(500).json({ error: "Could not find or create the Credit Card and Cash Receipts folder" });
    res.json({ ok: true, receiptsRootId: id });
  });

  app.post("/api/admin/drive-folder", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const { receiptsRootId } = req.body || {};
    if (!receiptsRootId || typeof receiptsRootId !== "string") {
      return res.status(400).json({ error: "receiptsRootId is required" });
    }
    // Verify the ID is real and is a folder before committing.
    if (isGoogleEnabled()) {
      const ok = await driveFolderExists(receiptsRootId).catch(() => false);
      if (!ok) return res.status(400).json({ error: "Folder not found or not accessible" });
    }
    driveFolderConfig.receiptsRootId = receiptsRootId;
    saveDriveFolderConfig();
    // Bust property-folder cache so subfolders re-resolve under the new root.
    propertyFolderCache.clear();
    res.json({ ok: true, receiptsRootId });
  });

  app.post("/api/admin/init-check-sheet", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    if (!isGoogleEnabled()) return res.status(400).json({ error: "Google API not configured" });
    try {
      let spreadsheetId = checkSheetsConfig?.spreadsheetId;
      if (!spreadsheetId) {
        // Create new spreadsheet at Drive root via Sheets API (same pattern
        // used by the time-reports sync endpoint).
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET
        );
        oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
        const sheets = google.sheets({ version: "v4", auth: oauth2Client });
        const created = await sheets.spreadsheets.create({
          requestBody: { properties: { title: "Check Transactions" } },
        });
        spreadsheetId = created.data.spreadsheetId!;
        checkSheetsConfig = { spreadsheetId, tabs: {} };
        fs.writeFileSync(CHECK_SHEETS_CONFIG_PATH, JSON.stringify(checkSheetsConfig, null, 2));
        console.log(`[check-sheets] Created spreadsheet ${spreadsheetId}`);
      }
      // Make sure one tab exists per property, with current data.
      const props = await storage.getAllProperties();
      let tabs = 0, rows = 0;
      for (const p of props) {
        const result = await rebuildCheckSheetForProperty(p.name);
        if (result.ok) { tabs++; rows += (result.rows || 0); }
      }
      res.json({ ok: true, spreadsheetId, tabs, rows });
    } catch (e: any) {
      console.error("[check-sheets] init error:", e);
      res.status(500).json({ error: e.message || "Failed to init Check sheet" });
    }
  });

  // Migration: pull every category=check row out of cash_transactions into
  // check_transactions, mark them as already deposited, then rebuild both
  // spreadsheets. Idempotent — only moves rows whose category is still 'check'.
  app.post("/api/admin/migrate-checks", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    try {
      const all = await storage.getAllCashTransactions();
      const oldChecks = all.filter(c => c.category === "check");
      const nowIso = new Date().toISOString();
      let migrated = 0;
      const touchedProps = new Set<string>();
      for (const c of oldChecks) {
        await storage.createCheckTransaction({
          userId: c.userId,
          property: c.property,
          amount: c.amount,
          date: c.date,
          payerName: (c as any).payerName || (c as any).tenantName || null,
          checkNumber: null,
          unitLotNumber: c.unitLotNumber || null,
          notes: (c as any).notes || c.description || null,
          photoPath: c.photoPath || null,
          photoPaths: c.photoPaths || null,
          deposited: 1, // already deposited per migration policy
          depositedAt: nowIso,
          recordNumber: c.recordNumber || null,
          propertyCode: (c as any).propertyCode || null,
          syncedToSheets: 0,
          syncedToDrive: 0,
          createdAt: c.createdAt,
        } as any);
        await storage.deleteCashTransaction(c.id);
        touchedProps.add(c.property);
        migrated++;
      }
      // Rebuild affected tabs in both spreadsheets so they reflect reality.
      for (const p of Array.from(touchedProps)) {
        try { await rebuildCheckSheetForProperty(p); } catch {}
      }
      // Also resync cash sheet so the check rows disappear from there.
      if (cashSheetsConfig?.spreadsheetId) {
        for (const p of Array.from(touchedProps)) {
          try {
            const remaining = (await storage.getAllCashTransactions())
              .filter(c => c.property === p)
              .sort((a, b) => a.date.localeCompare(b.date));
            const headers = ["Date", "Type", "Category", "Amount", "Unit/Lot", "Tenant", "Bank", "Description", "Submitted By", "Submitted At", "Record #", "Balance"];
            await updateSheetRange(cashSheetsConfig.spreadsheetId, `${p}!A1`, [headers]);
            await clearSheet(cashSheetsConfig.spreadsheetId, `${p}!A2:L`);
            if (remaining.length > 0) {
              const allUsers = await storage.getAllUsers();
              const userMap = new Map(allUsers.map(u => [u.id, u.displayName]));
              let running = 0;
              const cashRows = remaining.map(c => {
                running += (c.type === "income" ? 1 : -1) * parseFloat(c.amount || "0");
                return [
                  c.date, c.type, c.category, c.amount,
                  c.unitLotNumber || "", c.tenantName || (c as any).payerName || "",
                  c.bankName || "", c.description || (c as any).notes || "",
                  userMap.get(c.userId) || "", c.createdAt,
                  (c as any).propertyCode || String(c.recordNumber || ""),
                  running.toFixed(2),
                ];
              });
              await updateSheetRange(cashSheetsConfig.spreadsheetId, `${p}!A2`, cashRows);
            }
          } catch (e) { console.error("[migrate-checks] cash sheet rebuild:", e); }
        }
      }
      res.json({ ok: true, migrated, properties: Array.from(touchedProps) });
    } catch (e: any) {
      console.error("[migrate-checks] error:", e);
      res.status(500).json({ error: e.message || "Migration failed" });
    }
  });

  // ---- CC STATEMENT RECONCILIATION ----

  function parseStatementCsv(filePath: string): { date: string; description: string; amount: string }[] {
    const content = fs.readFileSync(filePath, "utf-8");
    return parseStatementText(content);
  }

  function parseStatementText(content: string): { date: string; description: string; amount: string }[] {
    const lines = content.split("\n").map(l => l.trim()).filter(l => l);
    if (lines.length < 2) return [];

    const rows: { date: string; description: string; amount: string }[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].match(/(".*?"|[^,]+)/g)?.map(c => c.replace(/^"|"$/g, "").trim()) || [];
      if (cols.length < 3) continue;

      let date = "", description = "", amount = "";
      for (const col of cols) {
        if (!date && /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(col)) {
          const parts = col.split(/[\/\-]/);
          if (parts[0].length === 4) date = col;
          else if (parts.length === 3) {
            const y = parts[2].length === 2 ? "20" + parts[2] : parts[2];
            date = `${y}-${parts[0].padStart(2,"0")}-${parts[1].padStart(2,"0")}`;
          }
        } else if (!amount && /^-?\$?[\d,]+\.?\d*$/.test(col.replace(/[$,\s]/g, ""))) {
          amount = col.replace(/[$,\s]/g, "");
          if (amount.startsWith("-")) amount = amount.slice(1);
        } else if (!description && col.length > 2 && !/^\d+$/.test(col)) {
          description = col;
        }
      }
      if (date && amount) {
        rows.push({ date, description: description || "Unknown", amount });
      }
    }
    return rows;
  }

  async function parseStatementPdf(filePath: string, fallbackYear?: string): Promise<{ date: string; description: string; amount: string }[]> {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    const text = data.text;
    const rows: { date: string; description: string; amount: string }[] = [];

    // Infer the statement year from billing period or statement date
    // Look for patterns like "02/17/26" or "03/16/2026" or "2026 totals" or "Billing Period: 02/17/26-03/16/26"
    // Use the fallback year from the admin-provided date range, or infer from PDF text
    let defaultYear = fallbackYear || new Date().getFullYear().toString();
    if (!fallbackYear) {
      const billingMatch = text.match(/Billing\s*Period[:\s]*(\d{1,2}\/\d{1,2}\/(\d{2,4}))/i);
      if (billingMatch) {
        const y = billingMatch[2];
        defaultYear = y.length === 2 ? "20" + y : y;
      } else {
        const stmtYearMatch = text.match(/(?:as of|through|ending|statement)\s+\d{1,2}\/\d{1,2}\/(\d{2,4})/i)
          || text.match(/(20\d{2})\s+(?:totals|statement)/i);
        if (stmtYearMatch) {
          const y = stmtYearMatch[1];
          defaultYear = y.length === 2 ? "20" + y : y;
        }
      }
    }

    const lines = text.split("\n").map(l => l.trim()).filter(l => l);

    // Helper to parse a date string into YYYY-MM-DD
    function parseDate(raw: string): string {
      const parts = raw.split(/[\/\-]/);
      if (parts.length === 3) {
        const y = parts[2].length === 2 ? "20" + parts[2] : parts[2];
        return `${y}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
      } else if (parts.length === 2) {
        return `${defaultYear}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
      }
      return "";
    }

    // === Strategy 1: Single-line format (Citi style) ===
    // Date(s) + description + amount all on one line
    for (const line of lines) {
      const amountMatch = line.match(/-?\$?([\d,]+\.\d{2})\s*$/);
      if (!amountMatch) continue;

      const datePatterns = [
        /^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/,
        /^(\d{1,2}\/\d{1,2})\d{1,2}\/\d{1,2}/,
        /^(\d{1,2}\/\d{1,2})\s+\d{1,2}\/\d{1,2}/,
        /^(\d{1,2}\/\d{1,2})[\s\D]/,
      ];

      let date = "", descStart = 0;
      for (const pat of datePatterns) {
        const m = line.match(pat);
        if (m) {
          date = parseDate(m[1]);
          const dualNoSpace = line.match(/^\d{1,2}\/\d{1,2}\d{1,2}\/\d{1,2}/);
          const dualWithSpace = line.match(/^\d{1,2}\/\d{1,2}\s+\d{1,2}\/\d{1,2}\s*/);
          descStart = dualNoSpace ? dualNoSpace[0].length : dualWithSpace ? dualWithSpace[0].length : m[0].length;
          break;
        }
      }
      if (!date) continue;

      let amount = amountMatch[1].replace(/,/g, "");
      let desc = line.slice(descStart, amountMatch.index!).trim().replace(/\s{2,}/g, " ");
      if (!desc) desc = "Unknown";

      if (parseFloat(amount) > 0 && !line.startsWith("-") && !amountMatch[0].startsWith("-")) {
        rows.push({ date, description: desc, amount });
      }
    }

    // === Strategy 2: Multi-line format (AMEX style) ===
    // If Strategy 1 found nothing, try multi-line: date on one line, description on next, amount a few lines later
    if (rows.length === 0) {
      for (let i = 0; i < lines.length; i++) {
        // Look for a date-only line: MM/DD/YY or MM/DD/YYYY (nothing else significant on the line)
        const dateOnlyMatch = lines[i].match(/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/);
        if (!dateOnlyMatch) continue;

        const date = parseDate(dateOnlyMatch[1]);
        if (!date) continue;

        // Next line(s) should be description, then eventually an amount line
        let desc = "";
        let amount = "";
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const amtMatch = lines[j].match(/^-?\$([\d,]+\.\d{2})$/);
          if (amtMatch) {
            amount = amtMatch[1].replace(/,/g, "");
            break;
          }
          // Skip lines that are just numbers (phone, reference) or page markers
          if (/^p\.\s*\d/.test(lines[j]) || /^Continued/i.test(lines[j]) || /^Amount$/i.test(lines[j])
              || /^Card Ending/i.test(lines[j]) || /^Total/i.test(lines[j])
              || /^[A-Z]+\s+[A-Z]+$/i.test(lines[j]) && lines[j].length < 30 && /^\d/.test(lines[j]) === false) {
            continue;
          }
          // First non-date, non-amount line is the description
          if (!desc && lines[j].length > 3 && !/^\d+$/.test(lines[j])) {
            desc = lines[j].replace(/\s{2,}/g, " ");
          }
        }

        if (date && amount && parseFloat(amount) > 0 && parseFloat(amount) < 50000 && desc) {
          // Skip summary/header lines that aren't real transactions
          const descLower = desc.toLowerCase();
          if (descLower.includes('new balance') || descLower.includes('payment due')
              || descLower.includes('minimum payment') || descLower.includes('total')) continue;
          rows.push({ date, description: desc, amount });
        }
      }
    }

    return rows;
  }

  app.post("/api/admin/upload-statement", upload.single("statement"), fixUploadedExtension, async (req: any, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;

    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { property, ccLastDigits, startDate, endDate } = req.body;
    if (!property || !ccLastDigits || !startDate || !endDate) {
      return res.status(400).json({ error: "Property, CC digits, start date, and end date are required" });
    }

    const filePath = `/api/uploads/${req.file.filename}`;
    const fullPath = path.resolve(dataDir, "uploads", req.file.filename);

    const ext = path.extname(req.file.originalname || req.file.filename).toLowerCase();
    let transactions: { date: string; description: string; amount: string }[];
    if (ext === ".pdf" || req.file.mimetype === "application/pdf") {
      // Pass the year from the admin-provided date range as fallback
      const stmtYear = startDate ? startDate.split("-")[0] : undefined;
      transactions = await parseStatementPdf(fullPath, stmtYear);
    } else {
      transactions = parseStatementCsv(fullPath);
    }

    const stmt = await storage.createCcStatement({
      property,
      ccLastDigits,
      startDate,
      endDate,
      filePath,
      parsedData: JSON.stringify(transactions),
      uploadedBy: session.userId,
      createdAt: new Date().toISOString(),
    });

    if (isGoogleEnabled()) {
      setImmediate(async () => {
        try {
          const mainFolder = await ensureDriveFolder("CC Statements and Matches");
          if (mainFolder) {
            const statementsFolder = await ensureDriveFolder("CC Statements", mainFolder);
            if (statementsFolder) {
              const propFolder = await ensureDriveFolder(property, statementsFolder);
              if (propFolder) {
                const driveExt = ext === ".pdf" ? ".pdf" : ".csv";
                await uploadToDrive(fullPath, `Statement_${property}_${startDate}_to_${endDate}${driveExt}`, propFolder);
              }
            }
          }
        } catch (e) { console.error("[statement] Drive upload failed:", e); }
      });
    }

    res.json({ id: stmt.id, transactions: transactions.length });
  });

  app.post("/api/admin/reconcile/:id", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;

    const id = parseInt(req.params.id);
    const stmt = await storage.getCcStatement(id);
    if (!stmt) return res.status(404).json({ error: "Statement not found" });

    const stmtTransactions: { date: string; description: string; amount: string }[] =
      stmt.parsedData ? JSON.parse(stmt.parsedData) : [];

    const receipts = await storage.getInvoicesByPropertyAndDateRange(stmt.property, stmt.startDate, stmt.endDate);
    const allUsers = await storage.getAllUsers();
    const userMap = new Map(allUsers.map(u => [u.id, u.displayName]));

    const matched: { stmt: any; receipt: any }[] = [];
    const unmatchedStmt: any[] = [];
    const unmatchedReceipts: any[] = [];
    const usedReceiptIds = new Set<number>();

    for (const stmtTx of stmtTransactions) {
      const stmtAmt = parseFloat(stmtTx.amount);
      const stmtDate = new Date(stmtTx.date);

      let found = false;
      for (const receipt of receipts) {
        if (usedReceiptIds.has(receipt.id)) continue;
        const recAmt = parseFloat(receipt.amount);
        const recDate = new Date(receipt.purchaseDate);

        // Exact match: amount within 1 cent
        const exactAmtMatch = Math.abs(stmtAmt - recAmt) < 0.01;
        // Fuzzy match: dollar amount matches but cents may differ (manager didn't enter cents)
        const dollarMatch = Math.floor(stmtAmt) === Math.floor(recAmt);
        const centsDiffer = !exactAmtMatch && dollarMatch;
        const dayDiff = Math.abs(stmtDate.getTime() - recDate.getTime()) / (1000 * 60 * 60 * 24);

        if ((exactAmtMatch || dollarMatch) && dayDiff <= 1) {
          const note = centsDiffer ? `Cents mismatch: statement $${stmtAmt.toFixed(2)} vs receipt $${recAmt.toFixed(2)}` : "";
          matched.push({ stmt: stmtTx, receipt, note });
          usedReceiptIds.add(receipt.id);
          found = true;
          break;
        }
      }
      if (!found) {
        unmatchedStmt.push(stmtTx);
      }
    }

    for (const receipt of receipts) {
      if (!usedReceiptIds.has(receipt.id)) {
        unmatchedReceipts.push(receipt);
      }
    }

    // Generate HTML report
    let html = `<div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto;">`;
    html += `<h1 style="color:#1a5c3a;">CC Statement Reconciliation Report</h1>`;
    html += `<p><strong>Property:</strong> ${stmt.property}</p>`;
    html += `<p><strong>Credit Card:</strong> ••••${stmt.ccLastDigits}</p>`;
    html += `<p><strong>Period:</strong> ${stmt.startDate} to ${stmt.endDate}</p>`;
    html += `<p><strong>Generated:</strong> ${new Date().toISOString().replace("T", " ").slice(0, 19)}</p>`;

    html += `<div style="background:#f0f8f0;padding:15px;border-radius:8px;margin:15px 0;">`;
    html += `<h2 style="margin:0;">Summary</h2>`;
    html += `<p>Statement transactions: <strong>${stmtTransactions.length}</strong></p>`;
    html += `<p>Matched with receipts: <strong style="color:green;">${matched.length}</strong></p>`;
    html += `<p>Unmatched on statement: <strong style="color:${unmatchedStmt.length > 0 ? 'red' : 'green'};">${unmatchedStmt.length}</strong></p>`;
    html += `<p>Extra receipts (not on statement): <strong style="color:${unmatchedReceipts.length > 0 ? 'orange' : 'green'};">${unmatchedReceipts.length}</strong></p>`;
    html += `</div>`;

    if (matched.length > 0) {
      html += `<h2 style="color:green;">Matched Transactions (${matched.length})</h2>`;
      html += `<table style="border-collapse:collapse;width:100%;"><tr style="background:#e8f5e9;"><th style="padding:6px;border:1px solid #ddd;text-align:left;">Date</th><th style="padding:6px;border:1px solid #ddd;">Statement</th><th style="padding:6px;border:1px solid #ddd;">Receipt</th><th style="padding:6px;border:1px solid #ddd;">Amount</th><th style="padding:6px;border:1px solid #ddd;">Submitted By</th></tr>`;
      for (const m of matched) {
        const noteHtml = m.note ? `<br/><span style="color:orange;font-size:11px;">⚠ ${m.note}</span>` : "";
        html += `<tr><td style="padding:6px;border:1px solid #ddd;">${m.stmt.date}</td><td style="padding:6px;border:1px solid #ddd;">${m.stmt.description}</td><td style="padding:6px;border:1px solid #ddd;">${m.receipt.description}</td><td style="padding:6px;border:1px solid #ddd;text-align:right;">$${m.stmt.amount}${noteHtml}</td><td style="padding:6px;border:1px solid #ddd;">${userMap.get(m.receipt.userId) || "Unknown"}</td></tr>`;
      }
      html += `</table>`;
    }

    if (unmatchedStmt.length > 0) {
      html += `<h2 style="color:red;">Missing from Receipts (${unmatchedStmt.length})</h2>`;
      html += `<p style="color:red;">These transactions appear on the CC statement but were NOT reported by any property manager.</p>`;
      html += `<table style="border-collapse:collapse;width:100%;"><tr style="background:#ffebee;"><th style="padding:6px;border:1px solid #ddd;text-align:left;">Date</th><th style="padding:6px;border:1px solid #ddd;">Store/Description</th><th style="padding:6px;border:1px solid #ddd;">Amount</th></tr>`;
      for (const tx of unmatchedStmt) {
        html += `<tr><td style="padding:6px;border:1px solid #ddd;">${tx.date}</td><td style="padding:6px;border:1px solid #ddd;">${tx.description}</td><td style="padding:6px;border:1px solid #ddd;text-align:right;">$${tx.amount}</td></tr>`;
      }
      html += `</table>`;
    }

    if (unmatchedReceipts.length > 0) {
      html += `<h2 style="color:orange;">Extra Receipts Not on Statement (${unmatchedReceipts.length})</h2>`;
      html += `<table style="border-collapse:collapse;width:100%;"><tr style="background:#fff3e0;"><th style="padding:6px;border:1px solid #ddd;">Date</th><th style="padding:6px;border:1px solid #ddd;">Description</th><th style="padding:6px;border:1px solid #ddd;">Amount</th><th style="padding:6px;border:1px solid #ddd;">By</th></tr>`;
      for (const r of unmatchedReceipts) {
        html += `<tr><td style="padding:6px;border:1px solid #ddd;">${r.purchaseDate}</td><td style="padding:6px;border:1px solid #ddd;">${r.description}</td><td style="padding:6px;border:1px solid #ddd;text-align:right;">$${r.amount}</td><td style="padding:6px;border:1px solid #ddd;">${userMap.get(r.userId) || "Unknown"}</td></tr>`;
      }
      html += `</table>`;
    }

    html += `<p style="color:#888;font-size:12px;margin-top:20px;">- Receipt App Reconciliation</p></div>`;

    await storage.updateCcStatement(id, {
      reportHtml: html,
      matched: matched.length,
      unmatched: unmatchedStmt.length,
      total: stmtTransactions.length,
    });

    // Save report to Drive
    if (isGoogleEnabled()) {
      try {
        const mainFolder = await ensureDriveFolder("CC Statements and Matches");
        if (mainFolder) {
          const reportsFolder = await ensureDriveFolder("Matches Generated Reports", mainFolder);
          if (reportsFolder) {
            const propFolder = await ensureDriveFolder(stmt.property, reportsFolder);
            if (propFolder) {
              const reportPath = path.resolve(dataDir, `reconcile-${id}.html`);
              fs.writeFileSync(reportPath, html);
              await uploadToDrive(reportPath, `Reconciliation_${stmt.property}_${stmt.startDate}_${stmt.endDate}.html`, propFolder);
              try { fs.unlinkSync(reportPath); } catch {}
            }
          }
        }
      } catch (e) { console.error("[reconcile] Drive save failed:", e); }
    }

    // Email report to subscribed admins
    try {
      const subscribers = allUsers.filter((u: any) => (u.reconciliationReport || u.statementReports) && u.email);
      if (subscribers.length > 0) {
        const subject = `CC Reconciliation: ${stmt.property} - ••${stmt.ccLastDigits} (${stmt.startDate} to ${stmt.endDate}) - ${matched.length}/${stmtTransactions.length} matched`;
        const reconRecipients = subscribers.map((u: any) => ({ name: u.displayName, email: u.email }));
        await sendEmailToRecipients(reconRecipients, subject, html);
      }
    } catch (e) { console.error("[reconcile] Email failed:", e); }

    res.json({
      matched: matched.length,
      unmatched: unmatchedStmt.length,
      extraReceipts: unmatchedReceipts.length,
      total: stmtTransactions.length,
      unmatchedDetails: unmatchedStmt,
    });
  });

  app.get("/api/admin/statements", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const stmts = await storage.getAllCcStatements();
    res.json(stmts);
  });

  // ---- Time Reports ----
  app.post("/api/time-reports", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const { property, date, startTime, endTime, timeBlocks, accomplishments, miles, mileageAmount, specialTerms, specialTermsAmount, notes, positionName, positionRate } = req.body;
    if (!property || !date || !startTime || !endTime || !accomplishments) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Block reporting in the future — based on Foley, AL time (Central Time).
    // If a user tries to submit a same-day report whose end time (or any block's
    // end time) is later than the current wall-clock in America/Chicago, reject.
    // Future dates are also blocked outright. Past dates are always fine.
    try {
      const nowInFoley = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
      const todayInFoley = nowInFoley.toISOString().split("T")[0];
      if (date > todayInFoley) {
        return res.status(400).json({
          error: `Cannot report for a future date. Today in Foley (Central Time) is ${todayInFoley}.`,
        });
      }
      if (date === todayInFoley) {
        const nowMinutes = nowInFoley.getHours() * 60 + nowInFoley.getMinutes();
        // Collect every block end (and start) for a same-day report; use the
        // largest end. Old-style single startTime/endTime rows fall back to those.
        let latestEndMinutes = 0;
        let latestEndLabel = "";
        if (timeBlocks && Array.isArray(timeBlocks) && timeBlocks.length > 0) {
          for (const b of timeBlocks) {
            if (!b?.end) continue;
            const [eh, em] = String(b.end).split(":").map(Number);
            const em0 = eh * 60 + em;
            if (em0 > latestEndMinutes) {
              latestEndMinutes = em0;
              latestEndLabel = b.end;
            }
          }
        } else if (endTime) {
          const [eh, em] = String(endTime).split(":").map(Number);
          latestEndMinutes = eh * 60 + em;
          latestEndLabel = endTime;
        }
        if (latestEndMinutes > nowMinutes) {
          const hh = String(Math.floor(nowMinutes / 60)).padStart(2, "0");
          const mm = String(nowMinutes % 60).padStart(2, "0");
          return res.status(400).json({
            error: `Reported end time (${latestEndLabel}) is later than the current time in Foley (Central Time). It's ${hh}:${mm} there right now — you can't report hours that haven't happened yet.`,
          });
        }
      }
    } catch (e) { console.error("[time-reports] future-time check failed:", e); }

    // Check for overlapping time blocks with existing reports by same user on same day
    const existingReports = await storage.getTimeReportsByUserAndDate(session.userId, date);
    if (existingReports.length > 0 && timeBlocks && Array.isArray(timeBlocks)) {
      for (const existing of existingReports) {
        let existingBlocks: { start: string; end: string }[] = [];
        try { existingBlocks = existing.timeBlocks ? JSON.parse(existing.timeBlocks) : []; } catch {}
        if (existingBlocks.length === 0) {
          existingBlocks = [{ start: existing.startTime, end: existing.endTime }];
        }
        for (const newBlock of timeBlocks) {
          const [nsh, nsm] = newBlock.start.split(":").map(Number);
          const [neh, nem] = newBlock.end.split(":").map(Number);
          const newStart = nsh * 60 + nsm;
          const newEnd = neh * 60 + nem;
          for (const exBlock of existingBlocks) {
            const [esh, esm] = exBlock.start.split(":").map(Number);
            const [eeh, eem] = exBlock.end.split(":").map(Number);
            const exStart = esh * 60 + esm;
            const exEnd = eeh * 60 + eem;
            // Overlap: new starts before existing ends AND new ends after existing starts
            if (newStart < exEnd && newEnd > exStart) {
              return res.status(400).json({
                error: `Time overlap detected: ${newBlock.start}-${newBlock.end} overlaps with an existing report (${exBlock.start}-${exBlock.end}) on ${date}. Please adjust your time blocks or delete the conflicting report.`
              });
            }
          }
        }
      }
    }

    const report = await storage.createTimeReport({
      userId: session.userId,
      property,
      date,
      startTime,
      endTime,
      timeBlocks: timeBlocks ? JSON.stringify(timeBlocks) : null,
      accomplishments: JSON.stringify(accomplishments),
      miles: miles || null,
      mileageAmount: mileageAmount || null,
      specialTerms: specialTerms ? 1 : 0,
      specialTermsAmount: specialTermsAmount || null,
      notes: notes || null,
      positionName: positionName || null,
      positionRate: positionRate || null,
      syncedToSheets: 0,
      createdAt: new Date().toISOString(),
    });
    res.json(report);

    // Background: email notification + Drive sync
    setImmediate(async () => {
      try {
        const user = await storage.getUser(session.userId);
        const displayName = user?.displayName || "Unknown";
        const userName = (user as any)?.firstName && (user as any)?.lastName
          ? `${(user as any).firstName}_${(user as any).lastName}`
          : displayName;
        const accList = Array.isArray(accomplishments) ? accomplishments : JSON.parse(accomplishments);

        // Calculate hours from time blocks
        let totalHours = 0;
        let timeDisplay = `${startTime} - ${endTime}`;
        const blocks = timeBlocks && Array.isArray(timeBlocks) ? timeBlocks : [];
        if (blocks.length > 0) {
          totalHours = blocks.reduce((sum: number, b: any) => {
            const [bsh, bsm] = b.start.split(":").map(Number);
            const [beh, bem] = b.end.split(":").map(Number);
            return sum + ((beh * 60 + bem) - (bsh * 60 + bsm)) / 60;
          }, 0);
          timeDisplay = blocks.map((b: any) => `${b.start} - ${b.end}`).join(", ");
        } else {
          const [sh, sm] = (startTime || "0:0").split(":").map(Number);
          const [eh, em] = (endTime || "0:0").split(":").map(Number);
          totalHours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
        }

        // Financial calculations
        const homeProperty = (user as any)?.homeProperty || "";
        const isOffSite = property !== homeProperty && (user as any)?.allowOffSite;
        const rate = isOffSite ? parseFloat((user as any)?.offSiteRate || "0") : parseFloat((user as any)?.baseRate || "0");
        const laborCost = totalHours * rate;
        const milesVal = parseFloat(miles || "0");
        const mileageVal = parseFloat(mileageAmount || "0");
        const specialVal = specialTerms ? parseFloat(specialTermsAmount || "0") : 0;
        const totalCost = laborCost + mileageVal + specialVal;

        // Build detailed HTML report
        const reportHtml = `<html><body style="font-family:Arial;max-width:600px;margin:0 auto;">
          <h2 style="color:#3b82f6;border-bottom:2px solid #3b82f6;padding-bottom:8px;">Work Report - ${date}</h2>
          <table style="width:100%;border-collapse:collapse;margin:10px 0;">
            <tr><td style="padding:6px 0;color:#666;">Employee</td><td style="padding:6px 0;font-weight:bold;text-align:right;">${displayName}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Property</td><td style="padding:6px 0;font-weight:bold;text-align:right;">${property}${isOffSite ? " (off-site)" : ""}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Date</td><td style="padding:6px 0;text-align:right;">${date}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Time Blocks</td><td style="padding:6px 0;text-align:right;">${timeDisplay}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Total Hours</td><td style="padding:6px 0;font-weight:bold;text-align:right;">${totalHours.toFixed(1)} hrs</td></tr>
          </table>
          <h3 style="margin-top:15px;">Accomplishments</h3>
          <ul style="margin:4px 0;">${accList.map((a: string) => `<li>${a}</li>`).join("")}</ul>
          ${notes ? `<p style="color:#666;"><em>Notes: ${notes}</em></p>` : ""}
          <h3 style="margin-top:15px;border-top:1px solid #ddd;padding-top:10px;">Financial Summary</h3>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:4px 0;">Labor: ${totalHours.toFixed(1)} hrs × $${rate.toFixed(2)}/hr</td><td style="padding:4px 0;text-align:right;font-weight:bold;">$${laborCost.toFixed(2)}</td></tr>
            <tr><td style="padding:4px 0;">Mileage: ${milesVal > 0 ? milesVal + " miles" : "0 miles"}</td><td style="padding:4px 0;text-align:right;">$${mileageVal.toFixed(2)}</td></tr>
            <tr><td style="padding:4px 0;">Special Terms / Travel</td><td style="padding:4px 0;text-align:right;">$${specialVal.toFixed(2)}</td></tr>
            <tr style="border-top:2px solid #333;"><td style="padding:8px 0;font-weight:bold;font-size:16px;">Total</td><td style="padding:8px 0;text-align:right;font-weight:bold;font-size:16px;">$${totalCost.toFixed(2)}</td></tr>
          </table>
          <p style="color:#888;font-size:11px;margin-top:20px;">- Jetsetter Reporting</p>
        </body></html>`;

        // 1. Send immediate email to dailyTimeReport subscribers
        try {
          const allUsers = await storage.getAllUsers();
          const timeEmailRecipients = allUsers
            .filter((u: any) => u.dailyTimeReport && u.email && isAdminRole(u.role))
            .map((u: any) => ({ name: u.displayName, email: u.email }));
          if (timeEmailRecipients.length > 0) {
            await sendEmailToRecipients(
              timeEmailRecipients,
              `Work Report: ${displayName} - ${property} - ${date} (${totalHours.toFixed(1)}h / $${totalCost.toFixed(2)})`,
              reportHtml
            );
          }
        } catch (e) { console.error("[time-report] Email error:", e); }

        // 2. Drive sync: save to daily folder + user folder
        if (isGoogleEnabled()) {
          try {
            const reportFilePath = path.resolve(dataDir, `time-report-${report.id}.html`);
            fs.writeFileSync(reportFilePath, reportHtml);

            const mainFolder = await ensureDriveFolder("Time Reporting");
            if (mainFolder) {
              // Save to daily shared folder: Time Reporting > Daily Reports > YYYY-MM-DD
              const dailyReportsFolder = await ensureDriveFolder("Daily Reports", mainFolder);
              if (dailyReportsFolder) {
                const dayFolder = await ensureDriveFolder(date, dailyReportsFolder);
                if (dayFolder) {
                  await uploadToDrive(reportFilePath, `${displayName}_${property}_${date}.html`, dayFolder);
                }
              }

              // Also save to user folder: Time Reporting > Property_Name > Time Reports
              const folderName = `${property}_${userName}`;
              const userFolder = await ensureDriveFolder(folderName, mainFolder);
              if (userFolder) {
                const reportsFolder = await ensureDriveFolder("Time Reports", userFolder);
                if (reportsFolder) {
                  await uploadToDrive(reportFilePath, `Time_Report_${date}.html`, reportsFolder);
                }
              }
            }

            try { fs.unlinkSync(reportFilePath); } catch {}
          } catch (e) { console.error("[time-report] Drive sync error:", e); }

          // Update Time Reporting tracking spreadsheet by rebuilding this user's tab.
          // Rebuild (vs. append) keeps the layout consistent with Position-aware
          // rates and the new Type column shared with flat-rate rows.
          try {
            const result = await rebuildTimeReportSheetForUser(session.userId);
            if (!result.ok) {
              console.log(`[time-report] Sheet rebuild skipped: ${result.reason}`);
            }
          } catch (e) { console.error("[time-report] Tracking spreadsheet error:", e); }
        }
      } catch (e) { console.error("[time-report] Background error:", e); }
    });
  });

  app.get("/api/time-reports", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    let reports;
    if (isAdminRole(session.role)) {
      reports = await storage.getAllTimeReports();
    } else {
      // PM sees their own reports + reports from contractors whose home base
      // matches the PM's home base property.
      const allowedUserIds = await getVisibleUserIdsForManager(session.userId);
      const allReports = await storage.getAllTimeReports();
      reports = allReports
        .filter(r => allowedUserIds.has(r.userId))
        .sort((a, b) => b.id - a.id);
    }
    // Enrich with submittedBy
    const allUsers = await storage.getAllUsers();
    const userMap = new Map(allUsers.map(u => [u.id, u.displayName]));
    const enriched = reports.map(r => ({ ...r, submittedBy: userMap.get(r.userId) || "Unknown" }));
    res.json(enriched);
  });

  app.get("/api/time-reports/user/:id", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const userId = parseInt(req.params.id);
    const reports = await storage.getTimeReportsByUser(userId);
    res.json(reports);
  });

  app.delete("/api/time-reports/:id", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    // Capture the report BEFORE deleting so we know which user's sheet tab to rebuild.
    const all = await storage.getAllTimeReports();
    const existing = all.find(r => r.id === id);
    await storage.deleteTimeReport(id);
    // Mirror the deletion to Google Sheets in the background (don't block the response).
    if (existing) {
      setImmediate(async () => {
        try {
          const result = await rebuildTimeReportSheetForUser(existing.userId);
          if (!result.ok) {
            console.log(`[time-reports delete] Skipped sheet rebuild for user ${existing.userId}: ${result.reason}`);
          } else {
            console.log(`[time-reports delete] Rebuilt sheet tab for user ${existing.userId} after deleting report ${id}`);
          }
        } catch (e) {
          console.error(`[time-reports delete] Failed to rebuild sheet for user ${existing.userId}:`, e);
        }
      });
    }
    res.json({ ok: true });
  });

  // ---- Work Credits ----
  app.post("/api/work-credits", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;

    // Check if user has allowWorkCredits
    const sessionUser = await storage.getUser(session.userId);
    if (!isAdminRole(session.role) && !(sessionUser as any)?.allowWorkCredits) {
      return res.status(403).json({ error: "Work credits not enabled for your account" });
    }

    const { property, date, tenantFirstName, tenantLastName, lotOrUnit, workDescriptions, creditType, fixedAmount, hoursWorked, hourlyRate, timeBlocks, totalAmount } = req.body;

    if (!property || !date || !tenantFirstName || !tenantLastName || !lotOrUnit || !workDescriptions || !creditType || !totalAmount) {
      return res.status(400).json({ error: "All fields are required" });
    }

    if (creditType === "hourly" && (!hoursWorked || !hourlyRate)) {
      return res.status(400).json({ error: "Hours and rate are required for hourly credits" });
    }

    if (creditType === "fixed" && !fixedAmount) {
      return res.status(400).json({ error: "Amount is required for fixed credits" });
    }

    const credit = await storage.createWorkCredit({
      userId: session.userId,
      property,
      date,
      tenantFirstName,
      tenantLastName,
      lotOrUnit,
      workDescriptions: JSON.stringify(workDescriptions),
      creditType,
      fixedAmount: fixedAmount || null,
      hoursWorked: hoursWorked || null,
      hourlyRate: hourlyRate || null,
      timeBlocks: timeBlocks ? JSON.stringify(timeBlocks) : null,
      totalAmount,
      syncedToSheets: 0,
      createdAt: new Date().toISOString(),
    });

    res.json(credit);

    // Background: email + Drive + Sheets sync
    setImmediate(async () => {
      try {
        const user = await storage.getUser(session.userId);
        const displayName = user?.displayName || "Unknown";
        const descList = Array.isArray(workDescriptions) ? workDescriptions : JSON.parse(workDescriptions);

        // Build email HTML
        const emailHtml = `<html><body style="font-family:Arial;max-width:600px;margin:0 auto;">
          <h2 style="color:#8b5cf6;border-bottom:2px solid #8b5cf6;padding-bottom:8px;">Work Credit - ${date}</h2>
          <table style="width:100%;border-collapse:collapse;margin:10px 0;">
            <tr><td style="padding:6px 0;color:#666;">Submitted by</td><td style="padding:6px 0;font-weight:bold;text-align:right;">${displayName}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Property</td><td style="padding:6px 0;font-weight:bold;text-align:right;">${property}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Date</td><td style="padding:6px 0;text-align:right;">${date}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Tenant</td><td style="padding:6px 0;text-align:right;">${tenantFirstName} ${tenantLastName}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Lot/Unit</td><td style="padding:6px 0;text-align:right;">${lotOrUnit}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Type</td><td style="padding:6px 0;text-align:right;">${creditType === "fixed" ? "Fixed Amount" : "Hourly"}</td></tr>
            ${creditType === "hourly" ? `<tr><td style="padding:6px 0;color:#666;">Hours × Rate</td><td style="padding:6px 0;text-align:right;">${hoursWorked}h × $${hourlyRate}/hr</td></tr>` : ""}
          </table>
          <h3>Work Description</h3>
          <ul>${descList.map((d: string) => `<li>${d}</li>`).join("")}</ul>
          <div style="border-top:2px solid #333;margin-top:15px;padding-top:10px;">
            <p style="font-size:18px;font-weight:bold;">Credit Amount: $${totalAmount}</p>
          </div>
          <p style="color:#888;font-size:11px;margin-top:20px;">- Jetsetter Reporting</p>
        </body></html>`;

        // Send email to work credit report subscribers
        const allUsers = await storage.getAllUsers();
        const recipients = allUsers
          .filter((u: any) => (u.workCreditReport || u.dailyTransactionReport) && u.email && isAdminRole(u.role))
          .map((u: any) => ({ name: u.displayName, email: u.email }));
        if (recipients.length > 0) {
          await sendEmailToRecipients(
            recipients,
            `Work Credit: ${tenantFirstName} ${tenantLastName} - ${property} - $${totalAmount} (${date})`,
            emailHtml
          );
        }

        // Google Sheets sync
        if (isGoogleEnabled()) {
          try {
            const wcConfigPath = path.resolve(dataDir, "work-credits-config.json");
            let wcConfig: any = null;
            if (fs.existsSync(wcConfigPath)) {
              wcConfig = JSON.parse(fs.readFileSync(wcConfigPath, "utf-8"));
            }
            if (!wcConfig?.spreadsheetId) {
              // Auto-create at Drive root level
              try {
                const { google: goog } = require("googleapis");
                const oa = new goog.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
                oa.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
                const sh = goog.sheets({ version: "v4", auth: oa });
                const ssRes = await sh.spreadsheets.create({ requestBody: { properties: { title: "Work Credits - All Properties" } } });
                if (ssRes.data.spreadsheetId) {
                  wcConfig = { spreadsheetId: ssRes.data.spreadsheetId };
                  fs.writeFileSync(wcConfigPath, JSON.stringify(wcConfig));
                  console.log(`[work-credit] Created spreadsheet: ${ssRes.data.spreadsheetId}`);
                }
              } catch (e) { console.error("[work-credit] Failed to create spreadsheet:", e); }
            }
            if (wcConfig?.spreadsheetId) {
              await createSheetTab(wcConfig.spreadsheetId, property, [
                "Date", "Submitted By", "Tenant", "Lot/Unit", "Description",
                "Type", "Hours × Rate", "Amount ($)", "Submitted At",
              ]);
              await appendSheetRow(wcConfig.spreadsheetId, property, [
                date,
                displayName,
                `${tenantFirstName} ${tenantLastName}`,
                lotOrUnit,
                descList.join("; "),
                creditType,
                creditType === "hourly" ? `${hoursWorked}h × $${hourlyRate}` : "Fixed",
                `$${totalAmount}`,
                new Date().toISOString(),
              ]);
            }
          } catch (e) { console.error("[work-credit] Sheets sync error:", e); }

          // Drive sync: Work Credits > Property > file
          try {
            const wcFolder = await ensureDriveFolder("Work Credits");
            if (wcFolder) {
              const propFolder = await ensureDriveFolder(property, wcFolder);
              if (propFolder) {
                const reportHtml = emailHtml;
                const filePath = path.resolve(dataDir, `work-credit-${credit.id}.html`);
                fs.writeFileSync(filePath, reportHtml);
                await uploadToDrive(filePath, `WorkCredit_${tenantFirstName}_${tenantLastName}_${date}.html`, propFolder);
                try { fs.unlinkSync(filePath); } catch {}
              }
            }
          } catch (e) { console.error("[work-credit] Drive sync error:", e); }
        }
      } catch (e) { console.error("[work-credit] Background error:", e); }
    });
  });

  app.get("/api/work-credits", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    let credits;
    if (isAdminRole(session.role)) {
      credits = await storage.getAllWorkCredits();
    } else {
      // PM sees own + work credits from contractors who share PM's home base property
      const allowedUserIds = await getVisibleUserIdsForManager(session.userId);
      const allCredits = await storage.getAllWorkCredits();
      credits = allCredits
        .filter(c => allowedUserIds.has(c.userId))
        .sort((a, b) => b.id - a.id);
    }
    // Enrich with submittedBy (display name)
    const allUsers = await storage.getAllUsers();
    const userMap = new Map(allUsers.map(u => [u.id, u.displayName]));
    const enriched = credits.map(c => ({ ...c, submittedBy: userMap.get(c.userId) || "Unknown" }));
    res.json(enriched);
  });

  app.delete("/api/work-credits/:id", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    await storage.deleteWorkCredit(id);
    res.json({ ok: true });
  });

  // ---- Flat Rate Assignments ----
  app.post("/api/flat-rate-assignments", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const user = await storage.getUser(session.userId);
    if (!isAdminRole(session.role) && !(user as any)?.allowFlatRate) {
      return res.status(403).json({ error: "You don't have permission to submit flat rate assignments" });
    }
    const { property, date, rate, accomplishments, notes } = req.body;
    if (!property || !date || rate === undefined || rate === null || rate === "") {
      return res.status(400).json({ error: "Property, date, and rate are required" });
    }
    const rateNum = parseFloat(rate);
    if (isNaN(rateNum) || rateNum <= 0 || rateNum > 10000) {
      return res.status(400).json({ error: "Rate must be greater than 0 and at most $10,000" });
    }
    if (date > new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({ error: "Date cannot be in the future" });
    }
    const accs = Array.isArray(accomplishments) ? accomplishments.filter((s: string) => s && s.trim()) : [];
    if (accs.length === 0) {
      return res.status(400).json({ error: "At least one accomplishment is required" });
    }
    const created = await storage.createFlatRate({
      userId: session.userId,
      property,
      date,
      rate: String(rateNum),
      accomplishments: JSON.stringify(accs),
      notes: notes || null,
      createdAt: new Date().toISOString(),
    });
    res.json(created);

    // Mirror flat-rate into the Time Reports spreadsheet so everything is in one place.
    setImmediate(async () => {
      try { await rebuildTimeReportSheetForUser(session.userId); } catch {}
    });

    // Per-entry email to admins subscribed to work credit reports or daily transaction
    // reports (matches the work-credit notification list).
    setImmediate(async () => {
      try {
        const submitter = await storage.getUser(session.userId);
        const submitterName = submitter?.displayName || "Unknown";
        const allUsers = await storage.getAllUsers();
        const recipients = allUsers
          .filter((u: any) => (u.workCreditReport || u.dailyTransactionReport) && u.email && isAdminRole(u.role))
          .map((u: any) => ({ name: u.displayName, email: u.email }));
        if (recipients.length === 0) return;
        const accListHtml = accs.map((a: string) => `<li>${a}</li>`).join("");
        const html = `<html><body style="font-family:Arial;max-width:600px;margin:0 auto;">
          <div style="background:#01696F;padding:18px;text-align:center;">
            <h2 style="color:white;margin:0;">Flat Rate Assignment</h2>
          </div>
          <div style="padding:20px;color:#28251D;line-height:1.5;">
            <p>A new flat-rate assignment was submitted in Jetsetter Reporting.</p>
            <table style="border-collapse:collapse;margin:8px 0;">
              <tr><td style="padding:4px 12px 4px 0;color:#666;">Submitted By</td><td style="padding:4px 0;"><b>${submitterName}</b></td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666;">Property</td><td style="padding:4px 0;">${property}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666;">Date</td><td style="padding:4px 0;">${date}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666;">Flat Rate</td><td style="padding:4px 0;"><b style="color:#A12C7B;">$${rateNum.toFixed(2)}</b></td></tr>
            </table>
            <p style="margin-top:14px;margin-bottom:4px;"><b>Accomplishments</b></p>
            <ul style="margin:0 0 8px 20px;padding:0;">${accListHtml}</ul>
            ${notes ? `<p style="margin-top:14px;margin-bottom:4px;"><b>Notes</b></p><p style="margin:0;color:#444;">${notes}</p>` : ""}
            <p style="color:#888;font-size:11px;margin-top:24px;">- Jetsetter Reporting</p>
          </div>
        </body></html>`;
        await sendEmailToRecipients(
          recipients,
          `Flat Rate: ${submitterName} - ${property} - $${rateNum.toFixed(2)} (${date})`,
          html
        );
      } catch (e) { console.error("[flat-rate-email] Failed:", e); }
    });
  });

  app.get("/api/flat-rate-assignments", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    let rows;
    if (isAdminRole(session.role)) {
      rows = await storage.getAllFlatRates();
    } else {
      // PM sees own + flat-rate entries from contractors who share PM's home base
      const allowedUserIds = await getVisibleUserIdsForManager(session.userId);
      const all = await storage.getAllFlatRates();
      rows = all
        .filter(r => allowedUserIds.has(r.userId))
        .sort((a, b) => b.id - a.id);
    }
    // Enrich with submittedBy
    const allUsers = await storage.getAllUsers();
    const userMap = new Map(allUsers.map(u => [u.id, u.displayName]));
    res.json(rows.map(r => ({ ...r, submittedBy: userMap.get(r.userId) || "Unknown" })));
  });

  app.delete("/api/flat-rate-assignments/:id", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const row = await storage.getFlatRate(id);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.userId !== session.userId && !isAdminRole(session.role)) {
      return res.status(403).json({ error: "Not authorized" });
    }
    const targetUserId = row.userId;
    await storage.deleteFlatRate(id);
    res.json({ ok: true });
    // Mirror to Google Sheets (item 1: flat-rate rows live in the same tab).
    setImmediate(async () => {
      try { await rebuildTimeReportSheetForUser(targetUserId); } catch {}
    });
  });

  // ---- Document Reminders ----
  app.post("/api/admin/doc-reminders", async (req, res) => {
    const authHeader = req.headers.authorization || "";
    const isInternalCron = authHeader === "Bearer internal-cron";
    if (!isInternalCron) {
      const session = await requireAdmin(req, res);
      if (!session) return;
    }

    const allUsers = await storage.getAllUsers();
    let sent = 0;

    for (const u of allUsers) {
      if (!(u as any).docReminderEnabled || !(u as any).email) continue;
      if ((u as any).docsComplete === 1) continue;

      const docs = await storage.getUserDocuments(u.id);
      const hasPhotoId = docs.some((d: any) => d.docType === "photo_id");
      const hasBanking = docs.some((d: any) => d.docType === "banking");
      const hasW9 = docs.some((d: any) => d.docType === "w9");

      if (hasPhotoId && hasBanking && hasW9) continue;

      const reminderDays = (u as any).docReminderDays || 3;
      const daysSinceEpoch = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
      if (daysSinceEpoch % reminderDays !== 0) continue;

      const missing: string[] = [];
      if (!hasPhotoId) missing.push("Photo ID");
      if (!hasBanking) missing.push("Banking Information");
      if (!hasW9) missing.push("W-9 Form");

      const emailHtml = `<html><body style="font-family:Arial;">
        <h2 style="color:#01696F;">Document Upload Reminder</h2>
        <p>Hi ${u.displayName},</p>
        <p>This is a friendly reminder that the following documents are still needed:</p>
        <ul>${missing.map(m => `<li style="color:#A12C7B;font-weight:bold;">${m}</li>`).join("")}</ul>
        <p>Please log in to <b>Jetsetter Reporting</b> and upload your documents under <b>My Documents</b>.</p>
        <p style="color:#888;font-size:11px;">- Jetsetter Reporting</p>
      </body></html>`;

      try {
        await sendEmailToRecipients(
          [{ name: u.displayName, email: (u as any).email }],
          `Reminder: Documents needed - ${missing.join(", ")}`,
          emailHtml
        );
        sent++;
      } catch (e) { console.error(`[doc-reminder] Failed for ${u.displayName}:`, e); }
    }

    res.json({ sent });
  });

  // Daily 7pm reminder (called by node-cron Mon–Sat). Sends a friendly
  // reminder to each user with dailyReminderEnabled=1. Property managers get
  // the full message about hours + work credits + cash/CC; contractors get
  // just the hours-reporting line.
  app.post("/api/admin/daily-7pm-reminders", async (req, res) => {
    const authHeader = req.headers.authorization || "";
    const isInternalCron = authHeader === "Bearer internal-cron";
    if (!isInternalCron) {
      const session = await requireAdmin(req, res);
      if (!session) return;
    }

    // Heartbeat: record each fire (manual or cron) so we can audit silently-missed days.
    const heartbeatPath = path.resolve(dataDir, "reminder-heartbeat.json");
    let heartbeat: { lastFiredAt: string; lastFiredBy: string; history: any[] } = {
      lastFiredAt: "", lastFiredBy: "", history: [],
    };
    try {
      if (fs.existsSync(heartbeatPath)) heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, "utf-8"));
    } catch {}

    const allUsers = await storage.getAllUsers();
    let sent = 0;
    const errors: string[] = [];

    for (const u of allUsers) {
      if (!(u as any).dailyReminderEnabled) continue;
      if (!u.email) continue;
      // Only managers and contractors get the reminder.
      if (u.role !== "manager" && u.role !== "contractor") continue;

      const firstName = (u as any).firstName || u.displayName?.split(" ")[0] || u.username;

      const isManager = u.role === "manager";
      const reminderBody = isManager
        ? `<p>Hi ${firstName},</p>
           <p>This is a friendly reminder that after the working day you have submitted your daily reporting:</p>
           <ul style="margin:8px 0 8px 20px;padding:0;">
             <li>Hours worked</li>
             <li>Work credits</li>
             <li>Any cash / credit-card transactions</li>
           </ul>
           <p>Best regards,<br/>Jetsetter Capital</p>`
        : `<p>Hi ${firstName},</p>
           <p>This is a friendly reminder to submit your hours-worked report for today.</p>
           <p>Best regards,<br/>Jetsetter Capital</p>`;

      const html = `<html><body style="font-family:Arial;max-width:600px;margin:0 auto;">
        <div style="background:#01696F;padding:18px;text-align:center;">
          <h2 style="color:white;margin:0;">Daily Reporting Reminder</h2>
        </div>
        <div style="padding:20px;color:#28251D;line-height:1.5;">
          ${reminderBody}
          <p style="color:#888;font-size:11px;margin-top:24px;">- Jetsetter Reporting</p>
        </div>
      </body></html>`;

      try {
        await sendEmailToRecipients(
          [{ name: u.displayName, email: u.email }],
          `Daily Reporting Reminder — ${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}`,
          html
        );
        // Per-user audit: mark the most recent successful reminder send.
        try {
          await storage.updateUser(u.id, { lastDailyReminderAt: new Date().toISOString() } as any);
        } catch {}
        sent++;
      } catch (e: any) {
        errors.push(`${u.username}: ${e.message}`);
      }
    }

    // Persist heartbeat with last 30 fires
    try {
      heartbeat.lastFiredAt = new Date().toISOString();
      heartbeat.lastFiredBy = isInternalCron ? "cron" : "manual";
      heartbeat.history = (heartbeat.history || []).concat([{
        at: heartbeat.lastFiredAt,
        by: heartbeat.lastFiredBy,
        sent, errors: errors.length,
      }]).slice(-30);
      fs.writeFileSync(heartbeatPath, JSON.stringify(heartbeat, null, 2));
    } catch (e) { console.error("[reminders] heartbeat write failed:", e); }
    console.log(`[reminders] Fired by ${heartbeat.lastFiredBy} — sent ${sent}, errors ${errors.length}`);

    res.json({ sent, errors });
  });

  // Admin diagnostic: when did the daily reminder last fire?
  // Helps catch silent cron failures (e.g. after a deploy).
  app.get("/api/admin/reminder-status", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const heartbeatPath = path.resolve(dataDir, "reminder-heartbeat.json");
    let heartbeat: any = {};
    try {
      if (fs.existsSync(heartbeatPath)) heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, "utf-8"));
    } catch {}
    const users = await storage.getAllUsers();
    const enabled = users
      .filter((u: any) => u.dailyReminderEnabled && u.email && !u.archived)
      .map((u: any) => ({
        displayName: u.displayName,
        email: u.email,
        role: u.role,
        lastDailyReminderAt: u.lastDailyReminderAt || null,
      }));
    res.json({ heartbeat, enabledUsers: enabled });
  });

  // ---- User Documents ----
  app.post("/api/user-documents", upload.single("document"), fixUploadedExtension, async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const { docType, bankName, routingNumber, accountNumber } = req.body;
    if (!docType) return res.status(400).json({ error: "docType is required" });
    const filePath = req.file ? `/api/uploads/${req.file.filename}` : null;

    // Reset docsComplete if user had docs approved (admin needs to re-review)
    const currentUser = await storage.getUser(session.userId);
    if ((currentUser as any)?.docsComplete === 1) {
      await storage.updateUser(session.userId, { docsComplete: 0 } as any);
    }

    const doc = await storage.createUserDocument({
      userId: session.userId,
      docType,
      filePath,
      bankName: bankName || null,
      routingNumber: routingNumber || null,
      accountNumber: accountNumber || null,
      createdAt: new Date().toISOString(),
    });
    res.json(doc);

    // Drive sync in background
    setImmediate(async () => {
      try {
        if (isGoogleEnabled()) {
          const docUser = await storage.getUser(session.userId);
          const userName = (docUser as any)?.firstName && (docUser as any)?.lastName
            ? `${(docUser as any).firstName}_${(docUser as any).lastName}`
            : docUser?.displayName || "Unknown";
          const prop = (docUser as any)?.homeProperty || "General";
          const folderName = `${prop}_${userName}`;

          const mainFolder = await ensureDriveFolder("Time Reporting");
          if (mainFolder) {
            const userFolder = await ensureDriveFolder(folderName, mainFolder);
            if (userFolder) {
              const docsFolder = await ensureDriveFolder("Documents", userFolder);
              if (docsFolder) {
                if (req.file) {
                  // Upload photo/file to Drive
                  const fullPath = path.resolve(dataDir, "uploads", req.file.filename);
                  if (fs.existsSync(fullPath)) {
                    const ext = path.extname(req.file.filename).slice(1);
                    const docName = `${docType}_${docUser?.displayName || "user"}_${Date.now()}.${ext}`;
                    await uploadToDrive(fullPath, docName, docsFolder);
                  }
                } else if (docType === "banking" && (bankName || routingNumber || accountNumber)) {
                  // Create a text file with banking info and upload to Drive
                  const txtContent = [
                    `Banking Information for ${docUser?.displayName || "User"}`,
                    `Date: ${new Date().toLocaleDateString()}`,
                    ``,
                    `Bank Name: ${bankName || "N/A"}`,
                    `Routing Number: ${routingNumber || "N/A"}`,
                    `Account Number: ${accountNumber || "N/A"}`,
                  ].join("\n");
                  const txtPath = path.resolve(dataDir, "uploads", `banking_${session.userId}_${Date.now()}.txt`);
                  fs.writeFileSync(txtPath, txtContent);
                  await uploadToDrive(txtPath, `Banking_Info_${docUser?.displayName || "user"}_${Date.now()}.txt`, docsFolder);
                  // Clean up temp file
                  try { fs.unlinkSync(txtPath); } catch {}
                }
              }
            }
          }
          // Also sync to shared User Documents folder
          try {
            const sharedDocsFolder = await ensureDriveFolder("User Documents");
            if (sharedDocsFolder) {
              const displayName = docUser?.displayName || "Unknown";
              const userDocsFolder = await ensureDriveFolder(displayName, sharedDocsFolder);
              if (userDocsFolder && req.file) {
                const fullPath = path.resolve(dataDir, "uploads", req.file.filename);
                if (fs.existsSync(fullPath)) {
                  const ext = path.extname(req.file.filename).slice(1);
                  const docName = `${docType}_${Date.now()}.${ext}`;
                  await uploadToDrive(fullPath, docName, userDocsFolder);
                }
              }
            }
          } catch (e) { console.error("[docs] Shared folder sync error:", e); }
        }
      } catch (e) { console.error("[docs] Drive sync error:", e); }

      // Update document tracking spreadsheet
      try { await updateDocTrackingSheet(); } catch (e) { console.error("[doc-tracking] Update failed:", e); }

      // Email admins who have documentUploadReport enabled
      try {
        const allUsersForEmail = await storage.getAllUsers();
        const docEmailRecipients = allUsersForEmail
          .filter((u: any) => u.documentUploadReport && u.email && isAdminRole(u.role))
          .map((u: any) => ({ name: u.displayName, email: u.email }));
        if (docEmailRecipients.length > 0) {
          const docUser = await storage.getUser(session.userId);
          const docDisplayName = docUser?.displayName || "Unknown";
          const docTypeLabel = docType === "photo_id" ? "Photo ID" : docType === "banking" ? "Banking Info" : docType === "w9" ? "W-9 Form" : docType;
          await sendEmailToRecipients(
            docEmailRecipients,
            `Document Uploaded: ${docDisplayName} - ${docTypeLabel}`,
            `<html><body style="font-family:Arial;">
              <h2 style="color:#01696F;">Document Upload Notification</h2>
              <p><strong>User:</strong> ${docDisplayName}</p>
              <p><strong>Document Type:</strong> ${docTypeLabel}</p>
              <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
              ${docType === "banking" && bankName ? `<p><strong>Bank:</strong> ${bankName}</p>` : ""}
              <p style="color:#888;font-size:11px;margin-top:20px;">- Jetsetter Reporting</p>
            </body></html>`
          );
        }
      } catch (e) { console.error("[docs] Email notification failed:", e); }
    });
  });

  app.get("/api/user-documents", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const docs = await storage.getUserDocuments(session.userId);
    res.json(docs);
  });

  app.get("/api/user-documents/:userId", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const docs = await storage.getUserDocuments(parseInt(req.params.userId));
    res.json(docs);
  });

  app.delete("/api/user-documents/:id", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    await storage.deleteUserDocument(parseInt(req.params.id));
    res.json({ ok: true });
    // Update tracking sheet in background
    setImmediate(async () => {
      try { await updateDocTrackingSheet(); } catch (e) { console.error("[doc-tracking] Update failed:", e); }
    });
  });

  // ---- Contractor Documents ----
  app.post("/api/contractor-documents", upload.single("document"), fixUploadedExtension, async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    // Check permission
    const currentUser = await storage.getUser(session.userId);
    if (!isAdminRole(session.role) && !(currentUser as any)?.allowContractorDocs) {
      return res.status(403).json({ error: "You don't have permission to submit contractor documents" });
    }

    const { contractorFirstName, contractorLastName, contractorEmail, contractorPhone, docType, bankName, routingNumber, accountNumber } = req.body;
    if (!contractorFirstName || !contractorLastName || !docType) {
      return res.status(400).json({ error: "Contractor name and document type are required" });
    }

    const filePath = req.file ? `/api/uploads/${req.file.filename}` : null;
    const doc = await storage.createContractorDocument({
      submittedByUserId: session.userId,
      contractorFirstName,
      contractorLastName,
      contractorEmail: contractorEmail || null,
      contractorPhone: contractorPhone || null,
      docType,
      filePath,
      bankName: bankName || null,
      routingNumber: routingNumber || null,
      accountNumber: accountNumber || null,
      createdAt: new Date().toISOString(),
    });
    res.json(doc);

    // Background: Drive sync + email notification
    setImmediate(async () => {
      try {
        if (isGoogleEnabled()) {
          const contractorName = `${contractorFirstName}_${contractorLastName}`;
          // All document uploads (login users + standalone contractors) now live
          // under "User Documents". Each standalone contractor gets their own
          // subfolder named after them inside that combined folder.
          const mainFolder = await ensureDriveFolder("User Documents");
          if (mainFolder) {
            const contractorFolder = await ensureDriveFolder(contractorName, mainFolder);
            if (contractorFolder) {
              if (req.file) {
                const fullPath = path.resolve(dataDir, "uploads", req.file.filename);
                if (fs.existsSync(fullPath)) {
                  const ext = path.extname(req.file.filename).slice(1);
                  const docName = `${docType}_${contractorName}_${Date.now()}.${ext}`;
                  await uploadToDrive(fullPath, docName, contractorFolder);
                }
              } else if (docType === "banking" && (bankName || routingNumber || accountNumber)) {
                const txtContent = [
                  `Banking Information for ${contractorFirstName} ${contractorLastName}`,
                  `Date: ${new Date().toLocaleDateString()}`,
                  ``,
                  `Bank Name: ${bankName || "N/A"}`,
                  `Routing Number: ${routingNumber || "N/A"}`,
                  `Account Number: ${accountNumber || "N/A"}`,
                ].join("\n");
                const txtPath = path.resolve(dataDir, "uploads", `contractor_banking_${Date.now()}.txt`);
                fs.writeFileSync(txtPath, txtContent);
                await uploadToDrive(txtPath, `Banking_Info_${contractorName}_${Date.now()}.txt`, contractorFolder);
                try { fs.unlinkSync(txtPath); } catch {}
              }
            }
          }
        }
      } catch (e) { console.error("[contractor-docs] Drive sync error:", e); }

      // Email admins who have documentUploadReport enabled
      try {
        const allUsersForEmail = await storage.getAllUsers();
        const docEmailRecipients = allUsersForEmail
          .filter((u: any) => u.documentUploadReport && u.email && isAdminRole(u.role))
          .map((u: any) => ({ name: u.displayName, email: u.email }));
        if (docEmailRecipients.length > 0) {
          const submitter = currentUser?.displayName || "Unknown";
          const docTypeLabel = docType === "photo_id" ? "Photo ID" : docType === "banking" ? "Banking Info" : docType === "w9" ? "W-9 Form" : docType;
          await sendEmailToRecipients(
            docEmailRecipients,
            `Contractor Document Uploaded: ${contractorFirstName} ${contractorLastName} - ${docTypeLabel}`,
            `<html><body style="font-family:Arial;">
              <h2 style="color:#01696F;">Contractor Document Upload</h2>
              <p><strong>Contractor:</strong> ${contractorFirstName} ${contractorLastName}</p>
              ${contractorEmail ? `<p><strong>Email:</strong> ${contractorEmail}</p>` : ""}
              ${contractorPhone ? `<p><strong>Phone:</strong> ${contractorPhone}</p>` : ""}
              <p><strong>Document Type:</strong> ${docTypeLabel}</p>
              <p><strong>Submitted By:</strong> ${submitter}</p>
              <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
              ${docType === "banking" && bankName ? `<p><strong>Bank:</strong> ${bankName}</p>` : ""}
              <p style="color:#888;font-size:11px;margin-top:20px;">- Jetsetter Reporting</p>
            </body></html>`
          );
        }
      } catch (e) { console.error("[contractor-docs] Email notification failed:", e); }
    });
  });

  app.get("/api/contractor-documents", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    // Admins see all, others see only their own
    if (isAdminRole(session.role)) {
      const docs = await storage.getAllContractorDocuments();
      res.json(docs);
    } else {
      const docs = await storage.getContractorDocumentsByUser(session.userId);
      res.json(docs);
    }
  });

  app.delete("/api/contractor-documents/:id", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const doc = await storage.getContractorDocument(parseInt(req.params.id));
    if (!doc) return res.status(404).json({ error: "Document not found" });
    // Only the submitter or an admin can delete
    if (doc.submittedByUserId !== session.userId && !isAdminRole(session.role)) {
      return res.status(403).json({ error: "Not authorized to delete this document" });
    }
    await storage.deleteContractorDocument(parseInt(req.params.id));
    res.json({ ok: true });
  });

  // ---- Admin Workforce Report ----
  // Helper: compute the pay summary for a single user & date range.
  // Used by both the admin route and the non-admin route.
  async function computeWorkforceReport(userIdNum: number, startDate: string, endDate: string) {
    const reports = await storage.getTimeReportsByUserAndDateRange(userIdNum, startDate, endDate);
    const userObj = await storage.getUser(userIdNum);

    // Precompute per-entry rate so the totals match the sheet (which also
    // honors positionRate -> offSiteRate -> baseRate). The old code used a
    // single flat baseRate, which is what caused the Pay Calculator to show
    // $18 even though the sheet had already used $20 / $15 position rates.
    const baseRate = parseFloat((userObj as any)?.baseRate || "0");
    const offSiteRate = parseFloat((userObj as any)?.offSiteRate || "0");
    const homeProperty = (userObj as any)?.homeProperty || "";
    const mileageRate = parseFloat((userObj as any)?.mileageRate || "0.50");

    let totalHours = 0;
    let totalMiles = 0;
    let totalMileagePay = 0;
    let totalSpecialTerms = 0;
    let laborCost = 0;
    const daysWorked = new Set<string>();

    function rateFor(r: any) {
      if (r.positionRate) return parseFloat(r.positionRate);
      const isOff = r.property !== homeProperty && (userObj as any)?.allowOffSite;
      return isOff ? offSiteRate : baseRate;
    }

    for (const r of reports) {
      let blocks: { start: string; end: string }[] = [];
      try { blocks = r.timeBlocks ? JSON.parse(r.timeBlocks) : []; } catch {}
      let entryHours = 0;
      if (blocks.length > 0) {
        entryHours = blocks.reduce((sum, b) => {
          const [bsh, bsm] = b.start.split(":").map(Number);
          const [beh, bem] = b.end.split(":").map(Number);
          return sum + ((beh * 60 + bem) - (bsh * 60 + bsm)) / 60;
        }, 0);
      } else {
        const [sh, sm] = (r.startTime || "0:0").split(":").map(Number);
        const [eh, em] = (r.endTime || "0:0").split(":").map(Number);
        entryHours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
      }
      totalHours += entryHours;
      laborCost += entryHours * rateFor(r);
      totalMiles += parseFloat(r.miles || "0");
      totalMileagePay += parseFloat(r.mileageAmount || "0");
      if (r.specialTerms) totalSpecialTerms += parseFloat(r.specialTermsAmount || "0");
      daysWorked.add(r.date);
    }

    // Flat rate assignments contribute additional pay independent of hours.
    const flatRates = await storage.getFlatRatesByUserAndDateRange(userIdNum, startDate, endDate);
    const totalFlatRate = flatRates.reduce((sum, fr) => sum + parseFloat(fr.rate || "0"), 0);
    for (const fr of flatRates) daysWorked.add(fr.date);
    const enrichedFlatRates = flatRates.map(fr => {
      let accs: string[] = [];
      try { accs = JSON.parse(fr.accomplishments || "[]"); } catch {}
      return { ...fr, rate: parseFloat(fr.rate || "0"), accomplishmentsList: accs };
    });

    const grandTotal = laborCost + totalMileagePay + totalSpecialTerms + totalFlatRate;

    const enrichedReports = reports.map(r => {
      let hours = 0;
      let blocks: { start: string; end: string }[] = [];
      try { blocks = r.timeBlocks ? JSON.parse(r.timeBlocks) : []; } catch {}
      if (blocks.length > 0) {
        hours = blocks.reduce((sum, b) => {
          const [bsh, bsm] = b.start.split(":").map(Number);
          const [beh, bem] = b.end.split(":").map(Number);
          return sum + ((beh * 60 + bem) - (bsh * 60 + bsm)) / 60;
        }, 0);
      } else {
        const [sh, sm] = (r.startTime || "0:0").split(":").map(Number);
        const [eh, em] = (r.endTime || "0:0").split(":").map(Number);
        hours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
      }
      const isOffSite = r.property !== homeProperty && (userObj as any)?.allowOffSite;
      // Position rate (when set on the report) wins over off-site/base rate.
      const rate = r.positionRate ? parseFloat(r.positionRate) : (isOffSite ? offSiteRate : baseRate);
      const entryCost = hours * rate;
      const entryMileage = parseFloat(r.mileageAmount || "0");
      const entrySpecial = r.specialTerms ? parseFloat(r.specialTermsAmount || "0") : 0;
      let accs: string[] = [];
      try { accs = JSON.parse(r.accomplishments || "[]"); } catch {}
      return {
        ...r,
        calculatedHours: parseFloat(hours.toFixed(2)),
        rate,
        isOffSite,
        laborCost: parseFloat(entryCost.toFixed(2)),
        mileageAmount: parseFloat(entryMileage.toFixed(2)),
        specialAmount: parseFloat(entrySpecial.toFixed(2)),
        entryTotal: parseFloat((entryCost + entryMileage + entrySpecial).toFixed(2)),
        accomplishmentsList: accs,
      };
    });

    return {
      user: {
        id: userObj?.id,
        displayName: userObj?.displayName,
        firstName: (userObj as any)?.firstName,
        lastName: (userObj as any)?.lastName,
        baseRate: (userObj as any)?.baseRate || "0",
        offSiteRate: (userObj as any)?.offSiteRate || "0",
        homeProperty,
        mileageRate: mileageRate.toString(),
      },
      period: { startDate, endDate },
      summary: {
        daysWorked: daysWorked.size,
        totalHours: parseFloat(totalHours.toFixed(1)),
        totalMiles: parseFloat(totalMiles.toFixed(1)),
        totalMileagePay: parseFloat(totalMileagePay.toFixed(2)),
        totalSpecialTerms: parseFloat(totalSpecialTerms.toFixed(2)),
        totalFlatRate: parseFloat(totalFlatRate.toFixed(2)),
        flatRateCount: flatRates.length,
        laborCost: parseFloat(laborCost.toFixed(2)),
        grandTotal: parseFloat(grandTotal.toFixed(2)),
        baseRate,
      },
      reports: enrichedReports,
      flatRates: enrichedFlatRates,
    };
  }

  // Helper: determine which user IDs a given viewer may run workforce reports for.
  // A property manager can only see contractors whose HOME BASE matches their own,
  // even if the PM is also assigned to other properties for support purposes.
  async function getWorkforceViewableUserIds(viewerId: number, viewerRole: string): Promise<Set<number>> {
    const allowed = new Set<number>([viewerId]);
    if (isAdminRole(viewerRole)) {
      const all = await storage.getAllUsers();
      for (const u of all) allowed.add(u.id);
      return allowed;
    }
    const viewer = await storage.getUser(viewerId);
    if ((viewer as any)?.allowCreatingContractors) {
      const viewerHome = (viewer as any)?.homeProperty;
      if (viewerHome) {
        const all = await storage.getAllUsers();
        for (const u of all) {
          if (u.id === viewerId) continue;
          if (u.role !== "contractor") continue;
          if ((u as any).homeProperty === viewerHome) allowed.add(u.id);
        }
      }
    }
    return allowed;
  }

  // Non-admin workforce report (any authenticated user)
  app.get("/api/workforce-report/available-users", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const allowed = await getWorkforceViewableUserIds(session.userId, session.role);
    const all = await storage.getAllUsers();
    const allProps = await storage.getAllProperties();
    const propMap = new Map(allProps.map(p => [p.id, p.name]));
    const list = [] as any[];
    for (const u of all) {
      if (!allowed.has(u.id)) continue;
      // Non-admin viewers only get themselves + contractors; admins get everyone.
      if (!isAdminRole(session.role) && u.role !== "contractor" && u.id !== session.userId) continue;
      const propIds = await storage.getUserPropertyIds(u.id);
      list.push({
        id: u.id,
        displayName: u.displayName,
        role: u.role,
        homeProperty: (u as any).homeProperty,
        assignedProperties: propIds.map(pid => propMap.get(pid)).filter(Boolean),
      });
    }
    list.sort((a, b) => a.displayName.localeCompare(b.displayName));
    res.json(list);
  });

  app.get("/api/workforce-report", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const { userId, startDate, endDate } = req.query as any;
    if (!userId || !startDate || !endDate) {
      return res.status(400).json({ error: "userId, startDate, endDate required" });
    }
    const targetId = parseInt(userId);
    const allowed = await getWorkforceViewableUserIds(session.userId, session.role);
    if (!allowed.has(targetId)) {
      return res.status(403).json({ error: "You don't have permission to view this user's pay report" });
    }
    const data = await computeWorkforceReport(targetId, startDate, endDate);
    res.json(data);
  });

  app.get("/api/admin/workforce-report", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const { userId, startDate, endDate } = req.query as any;
    if (!userId || !startDate || !endDate) {
      return res.status(400).json({ error: "userId, startDate, endDate required" });
    }
    // Delegates to the same helper used by /api/workforce-report so admins
    // and non-admins see identical numbers (including flat rate assignments).
    const data = await computeWorkforceReport(parseInt(userId), startDate, endDate);
    res.json(data);
  });

  // (legacy admin workforce-report block kept below for the diff history;
  //  the route above now delegates to the shared helper. This dead block is
  //  removed entirely.)
  app.get("/api/admin/workforce-report-legacy", async (req, res) => {
    return res.status(410).json({ error: "Use /api/admin/workforce-report" });
    // Unreachable but keeping for ts-typing.
    const reports: any[] = [];
    const userObj: any = null;
    const totalHours = 0, totalMiles = 0, totalMileagePay = 0, totalSpecialTerms = 0;
    const daysWorked = new Set<string>();
    const baseRate = 0, offSiteRate = 0, homeProperty = "", mileageRate = 0;
    const laborCost = 0, grandTotal = 0;
    const enrichedReports: any[] = [];
    res.json({
      user: {
        id: userObj?.id,
        displayName: userObj?.displayName,
        firstName: (userObj as any)?.firstName,
        lastName: (userObj as any)?.lastName,
        baseRate: (userObj as any)?.baseRate || "0",
        offSiteRate: (userObj as any)?.offSiteRate || "0",
        homeProperty,
        mileageRate: mileageRate.toString(),
      },
      period: { startDate, endDate },
      summary: {
        daysWorked: daysWorked.size,
        totalHours: parseFloat(totalHours.toFixed(1)),
        totalMiles: parseFloat(totalMiles.toFixed(1)),
        totalMileagePay: parseFloat(totalMileagePay.toFixed(2)),
        totalSpecialTerms: parseFloat(totalSpecialTerms.toFixed(2)),
        laborCost: parseFloat(laborCost.toFixed(2)),
        grandTotal: parseFloat(grandTotal.toFixed(2)),
        baseRate,
      },
      reports: enrichedReports,
    });
  });

  // ---- Helper: rebuild one user's tab in the Time Reports spreadsheet ----
  // Used by both the manual sync endpoint below and the delete-time-report handler
  // (so deleting a row in the app also removes it from the sheet).
  async function rebuildTimeReportSheetForUser(userId: number): Promise<{ ok: boolean; reason?: string }> {
    if (!isGoogleEnabled()) return { ok: false, reason: "google-disabled" };
    const trConfigPath = path.resolve(dataDir, "time-tracking-config.json");
    if (!fs.existsSync(trConfigPath)) return { ok: false, reason: "no-config" };
    let trConfig: any;
    try { trConfig = JSON.parse(fs.readFileSync(trConfigPath, "utf-8")); }
    catch { return { ok: false, reason: "bad-config" }; }
    if (!trConfig?.spreadsheetId) return { ok: false, reason: "no-sheet" };

    const user = await storage.getUser(userId);
    if (!user) return { ok: false, reason: "no-user" };
    const tabName = user.displayName || `User ${userId}`;

    // Column layout: Type was added so flat-rate assignments share the same
    // sheet as the regular time reports (item 1 in June 2026 update).
    const headers = [
      "Type", "Date", "Property", "Position / Time Blocks", "Total Hours", "Rate ($/hr)",
      "Labor ($)", "Miles", "Mileage Pay ($)", "Special Terms ($)",
      "Total ($)", "Accomplishments", "Notes", "Submitted At",
    ];
    await createSheetTab(trConfig.spreadsheetId, tabName, headers);
    // Force-rewrite row 1 so existing tabs created with the old 13-column layout
    // pick up the new "Type" column too. createSheetTab only writes headers on
    // brand-new tabs, so this catch-up step is required.
    await updateSheetRange(trConfig.spreadsheetId, `'${tabName}'!A1`, [headers]);
    await clearSheet(trConfig.spreadsheetId, `'${tabName}'!A2:Z`);

    const reports = (await storage.getAllTimeReports()).filter(r => r.userId === userId);
    const flatRates = (await storage.getAllFlatRates()).filter(fr => fr.userId === userId);
    const homeProperty = (user as any)?.homeProperty || "";
    const baseRate = parseFloat((user as any)?.baseRate || "0");
    const offSiteRate = parseFloat((user as any)?.offSiteRate || "0");

    // Build a unified list sorted by date so flat-rate rows interleave with
    // hourly rows. Flat-rate rows live in their own table but show up here too.
    type Entry =
      | { kind: "time"; date: string; r: any }
      | { kind: "flat"; date: string; fr: any };
    const merged: Entry[] = [
      ...reports.map((r): Entry => ({ kind: "time", date: r.date, r })),
      ...flatRates.map((fr): Entry => ({ kind: "flat", date: fr.date, fr })),
    ].sort((a, b) => a.date.localeCompare(b.date));

    const rows: string[][] = [];
    for (const entry of merged) {
      if (entry.kind === "flat") {
        const fr = entry.fr;
        const amt = parseFloat(fr.rate || "0");
        let accs: string[] = [];
        try { accs = JSON.parse(fr.accomplishments || "[]"); } catch {}
        rows.push([
          "Flat Rate", fr.date, fr.property, "", "", "",
          `$${amt.toFixed(2)}`, "0", "$0.00", "$0.00",
          `$${amt.toFixed(2)}`, accs.join("; "), fr.notes || "", fr.createdAt,
        ]);
        continue;
      }
      const r = entry.r;
      let hours = 0;
      let timeDisplay = `${r.startTime || ""} - ${r.endTime || ""}`;
      let blocks: { start: string; end: string }[] = [];
      try { blocks = r.timeBlocks ? JSON.parse(r.timeBlocks) : []; } catch {}
      if (blocks.length > 0) {
        hours = blocks.reduce((sum, b) => {
          const [bsh, bsm] = b.start.split(":").map(Number);
          const [beh, bem] = b.end.split(":").map(Number);
          return sum + ((beh * 60 + bem) - (bsh * 60 + bsm)) / 60;
        }, 0);
        timeDisplay = blocks.map(b => `${b.start} - ${b.end}`).join(", ");
      } else if (r.startTime && r.endTime) {
        const [sh, sm] = r.startTime.split(":").map(Number);
        const [eh, em] = r.endTime.split(":").map(Number);
        hours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
      }
      // Rate selection: explicit position rate wins, otherwise off-site/base.
      const isOffSite = r.property !== homeProperty && (user as any)?.allowOffSite;
      const rate = r.positionRate
        ? parseFloat(r.positionRate)
        : (isOffSite ? offSiteRate : baseRate);
      const rateLabelSuffix = r.positionName ? ` — ${r.positionName}` : (isOffSite ? " (off-site)" : "");
      const laborCost = hours * rate;
      const milesVal = parseFloat(r.miles || "0");
      const mileageVal = parseFloat(r.mileageAmount || "0");
      const specialVal = r.specialTerms ? parseFloat(r.specialTermsAmount || "0") : 0;
      const totalCost = laborCost + mileageVal + specialVal;
      let accs: string[] = [];
      try { accs = JSON.parse(r.accomplishments || "[]"); } catch {}
      if (blocks.length > 1) {
        for (let bi = 0; bi < blocks.length; bi++) {
          const blk = blocks[bi];
          const [bsh, bsm] = blk.start.split(":").map(Number);
          const [beh, bem] = blk.end.split(":").map(Number);
          const blockHours = ((beh * 60 + bem) - (bsh * 60 + bsm)) / 60;
          const blockLabor = blockHours * rate;
          rows.push([
            "Hourly", r.date, r.property + rateLabelSuffix,
            `${blk.start} - ${blk.end}`, blockHours.toFixed(1),
            `$${rate.toFixed(2)}`, `$${blockLabor.toFixed(2)}`,
            bi === 0 ? milesVal.toString() : "0",
            bi === 0 ? `$${mileageVal.toFixed(2)}` : "$0.00",
            bi === 0 ? `$${specialVal.toFixed(2)}` : "$0.00",
            bi === 0 ? `$${totalCost.toFixed(2)}` : `$${blockLabor.toFixed(2)}`,
            bi === 0 ? accs.join("; ") : "(continued)",
            bi === 0 ? (r.notes || "") : "", r.createdAt,
          ]);
        }
      } else {
        rows.push([
          "Hourly", r.date, r.property + rateLabelSuffix,
          timeDisplay, hours.toFixed(1),
          `$${rate.toFixed(2)}`, `$${laborCost.toFixed(2)}`,
          milesVal.toString(), `$${mileageVal.toFixed(2)}`,
          `$${specialVal.toFixed(2)}`, `$${totalCost.toFixed(2)}`,
          accs.join("; "), r.notes || "", r.createdAt,
        ]);
      }
    }
    if (rows.length > 0) {
      await updateSheetRange(trConfig.spreadsheetId, `'${tabName}'!A2`, rows);
    }
    return { ok: true };
  }

  // ---- Sync All Time Reports to Spreadsheet ----
  app.post("/api/admin/sync-time-reports-sheet", async (req, res) => {
    const authHeader = req.headers.authorization || "";
    const isInternalCron = authHeader === "Bearer internal-cron";
    if (!isInternalCron) {
      const session = await requireAdmin(req, res);
      if (!session) return;
    }

    if (!isGoogleEnabled()) return res.status(400).json({ error: "Google API not configured" });

    try {
      const mainFolder = await ensureDriveFolder("Time Reporting");
      if (!mainFolder) return res.status(500).json({ error: "Could not create Drive folder" });

      // Create or find the spreadsheet (at Drive root, like Cash Transactions)
      const trConfigPath = path.resolve(dataDir, "time-tracking-config.json");
      let trConfig: any = null;
      if (fs.existsSync(trConfigPath)) {
        trConfig = JSON.parse(fs.readFileSync(trConfigPath, "utf-8"));
      }

      // Verify the spreadsheet still exists (not trashed)
      if (trConfig?.spreadsheetId) {
        try {
          const { google } = require("googleapis");
          const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET
          );
          oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
          const driveCheck = google.drive({ version: "v3", auth: oauth2Client });
          const file = await driveCheck.files.get({ fileId: trConfig.spreadsheetId, fields: "trashed" });
          if (file.data.trashed) {
            console.log("[sync-time-sheet] Old spreadsheet was trashed, creating new one");
            trConfig = null;
          }
        } catch (e: any) {
          console.log("[sync-time-sheet] Old spreadsheet not accessible, creating new one");
          trConfig = null;
        }
      }

      if (!trConfig?.spreadsheetId) {
        // Create at Drive root level (not in a subfolder) so it's visible alongside other spreadsheets
        const { google } = require("googleapis");
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET
        );
        oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
        const sheets = google.sheets({ version: "v4", auth: oauth2Client });
        const ssRes = await sheets.spreadsheets.create({
          requestBody: { properties: { title: "Time Reports - All Users" } },
        });
        const ssId = ssRes.data.spreadsheetId;
        if (!ssId) return res.status(500).json({ error: "Could not create spreadsheet" });
        trConfig = { spreadsheetId: ssId };
        fs.writeFileSync(trConfigPath, JSON.stringify(trConfig));
        console.log(`[sync-time-sheet] Created new spreadsheet at Drive root: ${ssId}`);
      }

      const allUsers = await storage.getAllUsers();
      const allReports = await storage.getAllTimeReports();

      // Group reports by user
      const userMap = new Map<number, any>();
      for (const u of allUsers) {
        userMap.set(u.id, u);
      }

      const reportsByUser = new Map<number, any[]>();
      for (const r of allReports) {
        if (!reportsByUser.has(r.userId)) reportsByUser.set(r.userId, []);
        reportsByUser.get(r.userId)!.push(r);
      }

      let tabsCreated = 0;
      let rowsWritten = 0;

      // Bulk rebuild: delegate to the shared per-user helper so the layout
      // (including the Type column + flat-rate rows + position-aware rates)
      // stays in lockstep with single-user rebuilds.
      for (const [userId, _reports] of reportsByUser) {
        const user = userMap.get(userId);
        if (!user) continue;
        const result = await rebuildTimeReportSheetForUser(userId);
        if (result.ok) {
          tabsCreated++;
          rowsWritten += (await storage.getAllTimeReports()).filter(r => r.userId === userId).length
            + (await storage.getAllFlatRates()).filter(fr => fr.userId === userId).length;
        }
      }
      // Also rebuild tabs for users who ONLY have flat-rate assignments (no time reports).
      const flatRateUserIds = new Set((await storage.getAllFlatRates()).map(fr => fr.userId));
      for (const fuid of Array.from(flatRateUserIds)) {
        if (reportsByUser.has(fuid)) continue;
        const user = userMap.get(fuid);
        if (!user) continue;
        const result = await rebuildTimeReportSheetForUser(fuid);
        if (result.ok) {
          tabsCreated++;
          rowsWritten += (await storage.getAllFlatRates()).filter(fr => fr.userId === fuid).length;
        }
      }

      // ---- Build Summary tab ----
      const summaryHeaders = [
        "Employee", "Property", "Total Hours", "Rate ($/hr)", "Labor ($)",
        "Total Miles", "Mileage Pay ($)", "Special Terms ($)", "Grand Total ($)", "# Entries",
      ];
      await createSheetTab(trConfig.spreadsheetId, "Summary", summaryHeaders);
      await clearSheet(trConfig.spreadsheetId, "'Summary'!A2:Z");

      // Aggregate per user per property
      const summaryMap = new Map<string, {
        user: string; property: string; hours: number; rate: number;
        labor: number; miles: number; mileage: number; special: number; total: number; entries: number;
      }>();

      for (const [userId, reports] of reportsByUser) {
        const user = userMap.get(userId);
        if (!user) continue;
        const displayName = user.displayName || `User ${userId}`;
        const homeProperty = (user as any)?.homeProperty || "";
        const baseRate = parseFloat((user as any)?.baseRate || "0");
        const offSiteRate = parseFloat((user as any)?.offSiteRate || "0");

        for (const r of reports) {
          const key = `${userId}::${r.property}`;
          let hours = 0;
          let blocks: { start: string; end: string }[] = [];
          try { blocks = r.timeBlocks ? JSON.parse(r.timeBlocks) : []; } catch {}
          if (blocks.length > 0) {
            hours = blocks.reduce((sum, b) => {
              const [bsh, bsm] = b.start.split(":").map(Number);
              const [beh, bem] = b.end.split(":").map(Number);
              return sum + ((beh * 60 + bem) - (bsh * 60 + bsm)) / 60;
            }, 0);
          } else if (r.startTime && r.endTime) {
            const [sh, sm] = r.startTime.split(":").map(Number);
            const [eh, em] = r.endTime.split(":").map(Number);
            hours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
          }
          const isOffSite = r.property !== homeProperty && (user as any)?.allowOffSite;
          const rate = isOffSite ? offSiteRate : baseRate;
          const labor = hours * rate;
          const milesVal = parseFloat(r.miles || "0");
          const mileageVal = parseFloat(r.mileageAmount || "0");
          const specialVal = r.specialTerms ? parseFloat(r.specialTermsAmount || "0") : 0;

          const existing = summaryMap.get(key) || {
            user: displayName, property: r.property, hours: 0, rate,
            labor: 0, miles: 0, mileage: 0, special: 0, total: 0, entries: 0,
          };
          existing.hours += hours;
          existing.labor += labor;
          existing.miles += milesVal;
          existing.mileage += mileageVal;
          existing.special += specialVal;
          existing.total += labor + mileageVal + specialVal;
          existing.entries += 1;
          summaryMap.set(key, existing);
        }
      }

      // Sort by user name then property
      const summaryRows: string[][] = [];
      const sorted = [...summaryMap.values()].sort((a, b) =>
        a.user.localeCompare(b.user) || a.property.localeCompare(b.property)
      );

      let grandHours = 0, grandLabor = 0, grandMiles = 0, grandMileage = 0, grandSpecial = 0, grandTotal = 0, grandEntries = 0;
      for (const s of sorted) {
        summaryRows.push([
          s.user, s.property, s.hours.toFixed(1), `$${s.rate.toFixed(2)}`,
          `$${s.labor.toFixed(2)}`, s.miles.toFixed(1), `$${s.mileage.toFixed(2)}`,
          `$${s.special.toFixed(2)}`, `$${s.total.toFixed(2)}`, s.entries.toString(),
        ]);
        grandHours += s.hours; grandLabor += s.labor; grandMiles += s.miles;
        grandMileage += s.mileage; grandSpecial += s.special; grandTotal += s.total; grandEntries += s.entries;
      }
      // Grand total row
      summaryRows.push([
        "TOTAL", "", grandHours.toFixed(1), "",
        `$${grandLabor.toFixed(2)}`, grandMiles.toFixed(1), `$${grandMileage.toFixed(2)}`,
        `$${grandSpecial.toFixed(2)}`, `$${grandTotal.toFixed(2)}`, grandEntries.toString(),
      ]);

      if (summaryRows.length > 0) {
        await updateSheetRange(trConfig.spreadsheetId, "'Summary'!A2", summaryRows);
      }

      res.json({
        ok: true,
        spreadsheetId: trConfig.spreadsheetId,
        users: reportsByUser.size,
        totalReports: allReports.length,
        tabsCreated,
        rowsWritten,
      });
    } catch (e: any) {
      console.error("[sync-time-sheet] Error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // Multer error handler for file size limits
  app.use((err: any, _req: any, res: any, next: any) => {
    if (err?.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `File too large. Maximum size is 10MB. Please compress or resize your file.` });
    }
    if (err?.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({ error: "Unexpected file field." });
    }
    next(err);
  });

  return httpServer;
}
