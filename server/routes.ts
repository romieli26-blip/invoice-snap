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
import { initGoogleApis, isGoogleEnabled, appendSheetRow, createSheetTab, uploadToDrive, ensureDriveFolder, deleteSheetRow, deleteFromDrive, highlightLastRow, renameSheetTab, prependNoteToTab, createSpreadsheetInFolder, updateSheetRange, clearSheet, shareFolderWithEmail } from "./google-api";
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
        let mime = [
          `To: ${recipient.name} <${recipient.email}>`,
          `From: "Jetsetter Reporting" <jetsetterinvoices1@gmail.com>`,
          `Subject: ${subject}`,
          `MIME-Version: 1.0`,
        ];

        if (attachments && attachments.length > 0) {
          mime.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "");
          mime.push(`--${boundary}`);
          mime.push(`Content-Type: text/html; charset="UTF-8"`, "", htmlBody, "");
          for (const att of attachments) {
            if (fs.existsSync(att.path)) {
              const fileData = fs.readFileSync(att.path).toString("base64");
              const ext = path.extname(att.filename).slice(1) || "jpg";
              const mimeType = ext === "pdf" ? "application/pdf" : `image/${ext}`;
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

  const row = [
    invoice.purchaseDate, invoice.description, invoice.purpose, invoice.amount,
    invoice.boughtBy, invoice.paymentMethod === "cc" ? "Credit Card" : "Cash",
    invoice.lastFourDigits || "", submittedByName, invoice.createdAt,
    String(invoice.recordNumber || ""), invoice.rentManagerIssue || "",
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

    // Clear and rewrite the sheet
    await clearSheet(config.spreadsheetId, "Sheet1!A:Z");
    await updateSheetRange(config.spreadsheetId, "Sheet1!A1", rows);
    console.log(`[doc-tracking] Updated spreadsheet with ${rows.length - 1} users`);
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

async function syncToDrive(invoice: any): Promise<boolean> {
  const allPaths: string[] = invoice.photoPaths ? JSON.parse(invoice.photoPaths) : [invoice.photoPath];
  const safeDesc = (invoice.description || "receipt").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 40);

  // Try Google API first (works on Railway)
  if (isGoogleEnabled()) {
    try {
      // Folder structure: Credit Card and Cash Receipts > Credit Card Receipts > Property
      let ccReceiptsFolder = propertyFolderCache.get("__cc_receipts_root") || null;
      if (!ccReceiptsFolder) {
        const mainReceiptsFolder = await ensureDriveFolder("Credit Card and Cash Receipts");
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
      for (let i = 0; i < allPaths.length; i++) {
        const p = allPaths[i];
        const filePath = path.resolve(dataDir, "uploads", p.replace(/^\/api\/uploads\//, ""));
        if (!fs.existsSync(filePath)) continue;
        const ext = path.extname(filePath).slice(1) || "jpg";
        const suffix = allPaths.length > 1 ? ` (${i + 1} of ${allPaths.length})` : "";
        const fileName = `${invoice.property} - ${invoice.purchaseDate} ${safeDesc}${suffix}.${ext}`;
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
    const fileName = `${invoice.property} - ${invoice.purchaseDate} ${safeDesc}.${ext}`;
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

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Initialize Google APIs (service account for Railway, or fallback to external-tool)
  initGoogleApis();

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
  app.post("/api/forgot-password", async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const allUsers = await storage.getAllUsers();
    const user = allUsers.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());

    if (!user) {
      return res.json({ ok: true, message: "If an account with that email exists, login details have been sent." });
    }

    const tempPassword = crypto.randomBytes(4).toString("hex");
    await storage.updateUser(user.id, { password: tempPassword });

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
          `Subject: Receipt App - Your Login Details`,
          `MIME-Version: 1.0`,
          `Content-Type: text/html; charset="UTF-8"`,
          ``,
          `<h3>Login Details</h3>
           <p>Hi ${user.displayName},</p>
           <p>Your login details for the Receipt App:</p>
           <p><strong>Username:</strong> ${user.username}</p>
           <p><strong>Temporary Password:</strong> ${tempPassword}</p>
           <p>Please log in and ask your admin to update your password.</p>
           <p style="color:#888;font-size:12px;margin-top:16px;">- Receipt App</p>`,
        ].join("\r\n");

        const raw = Buffer.from(mime).toString("base64url");
        await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
        console.log(`[forgot-password] Sent login details to ${user.email}`);
      }
    } catch (err: any) {
      console.error("[forgot-password] Email failed:", err.message?.slice(0, 200));
    }

    res.json({ ok: true, message: "If an account with that email exists, login details have been sent." });
  });

  // ---- AUTH ----
  app.post("/api/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid credentials" });

    const user = await storage.getUserByUsername(parsed.data.username);
    if (!user || user.password !== parsed.data.password) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const token = generateToken();
    await storage.createSession(token, user.id, user.role);

    res.json({ token, user: {
      id: user.id, username: user.username, displayName: user.displayName, role: user.role,
      firstName: (user as any).firstName, lastName: (user as any).lastName,
      mileageRate: (user as any).mileageRate, allowOffSite: (user as any).allowOffSite,
      allowSpecialTerms: (user as any).allowSpecialTerms, specialTermsAmount: (user as any).specialTermsAmount,
      homeProperty: (user as any).homeProperty, baseRate: (user as any).baseRate, offSiteRate: (user as any).offSiteRate,
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
    const allUsers = await storage.getAllUsers();
    const allProps = await storage.getAllProperties();
    const propMap = new Map(allProps.map(p => [p.id, p.name]));

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
        showWorkReport: (u as any).showWorkReport || 0,
        showMyDocuments: (u as any).showMyDocuments || 0,
        showWorkCredit: (u as any).showWorkCredit || 0,
        showMyContractors: (u as any).showMyContractors || 0,
        assignedProperties: propIds.map(pid => propMap.get(pid)).filter(Boolean) as string[],
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
                <p>Watch this short video to learn how to install and use the app on your mobile device:</p>
                <p style="text-align:center;"><a href="${videoUrl}" style="display:inline-block;background:#01696F;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Watch Tutorial Video</a></p>
                <p style="color:#888;font-size:12px;margin-top:30px;">If you have any questions, please contact your administrator.<br>- Jetsetter Reporting</p>
              </div>
            </body></html>`
          );
          console.log(`[welcome] Sent welcome email to ${email}`);
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

    const { username, password, displayName, email, firstName, lastName, baseRate, offSiteRate, mileageRate, allowOffSite, homeProperty } = req.body;
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
      offSiteRate: offSiteRate ? String(offSiteRate) : "0",
      mileageRate: mileageRate ? String(mileageRate) : "0.50",
      allowOffSite: allowOffSite ? 1 : 0,
      homeProperty: resolvedHomeProperty,
      w9OrW4: "w9",
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
                <p style="color:#888;font-size:12px;margin-top:30px;">- Jetsetter Reporting</p>
              </div>
            </body></html>`
          );
        } catch (e) { console.error("[pm-welcome] Failed:", e); }
      });
    }
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

    const pmPropIds = new Set(await storage.getUserPropertyIds(session.userId));
    const allUsers = await storage.getAllUsers();
    const allProps = await storage.getAllProperties();
    const propMap = new Map(allProps.map(p => [p.id, p.name]));

    const contractors = [] as any[];
    for (const u of allUsers) {
      if (u.role !== "contractor") continue;
      if (u.id === session.userId) continue;
      const cPropIds = await storage.getUserPropertyIds(u.id);
      const shared = cPropIds.some(pid => pmPropIds.has(pid));
      if (shared) {
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

  app.delete("/api/users/:id", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;

    const id = parseInt(req.params.id);
    if (id === session.userId) return res.status(400).json({ error: "Cannot delete yourself" });

    await storage.deleteUser(id);
    res.json({ ok: true });
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
      firstName, lastName, baseRate, offSiteRate, homeProperty, allowOffSite,
      mileageRate, allowSpecialTerms, specialTermsAmount, w9OrW4, docsComplete,
      requireFinancialConfirm, allowPastDates, receiveTransactionEmails,
      allowWorkCredits, workCreditReport, documentUploadReport, docReminderEnabled, docReminderDays, allowContractorDocs, allowCreatingContractors,
      showWorkReport, showMyDocuments, showWorkCredit, showMyContractors } = req.body;

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
  }, upload.single("photo"), (req: any, res) => {
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
      rentManagerIssue: parsed.data.rentManagerIssue || null,
      receiptType: req.body.receiptType || "expense",
      syncedToDrive: 0,
      syncedToSheets: 0,
      createdAt: new Date().toISOString(),
    });

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

  // Helper: returns invoices a non-admin user is allowed to see —
  // their own submissions + any invoices for properties they manage.
  async function getVisibleInvoicesForUser(userId: number) {
    const ownInvoices = await storage.getInvoicesByUser(userId);
    const assignedProps = await storage.getPropertiesForUser(userId);
    const assignedPropNames = new Set(assignedProps.map(p => p.name));
    if (assignedPropNames.size === 0) return ownInvoices;
    const allInvoices = await storage.getAllInvoices();
    const propertyInvoices = allInvoices.filter(inv => assignedPropNames.has(inv.property));
    const byId = new Map<number, typeof allInvoices[number]>();
    for (const inv of ownInvoices) byId.set(inv.id, inv);
    for (const inv of propertyInvoices) byId.set(inv.id, inv);
    return Array.from(byId.values()).sort((a, b) => b.id - a.id);
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
    // Append doc status to transaction report HTML
    html = html.replace('</div>', docStatusHtml + '</div>');

    // Send transaction report to dailyTransactionReport subscribers
    const txSubscribers = allUsers.filter((u: any) => u.dailyTransactionReport && u.email);
    // Fallback: also include old dailyReport subscribers for backward compat
    const oldSubscribers = allUsers.filter((u: any) => u.dailyReport && u.email && !u.dailyTransactionReport);
    const txRecipients = [...txSubscribers, ...oldSubscribers].map(u => ({ name: u.displayName, email: u.email! }));
    const sentTo: string[] = [];

    if (txRecipients.length > 0) {
      await sendEmailToRecipients(txRecipients, `Daily Transaction Summary - ${date}`, html);
      sentTo.push(...txRecipients.map(r => r.email));
    }

    // Send time report to dailyTimeReport subscribers
    const timeSubscribers = allUsers.filter((u: any) => u.dailyTimeReport && u.email);
    const timeRecipients = timeSubscribers.map(u => ({ name: u.displayName, email: u.email! }));
    if (timeRecipients.length > 0 && todayTimeReports.length > 0) {
      await sendEmailToRecipients(timeRecipients, `Daily Work Report - ${date}`, timeHtml);
      sentTo.push(...timeRecipients.map(r => r.email));
    }

    // Forward both reports to jetsettercapitalllc@gmail.com via email + Drive folders
    const companyEmail = "jetsettercapitalllc@gmail.com";
    try {
      // Save reports as HTML files
      const txFilePath = path.resolve(dataDir, `daily-tx-summary-${date}.html`);
      const wrFilePath = path.resolve(dataDir, `daily-work-report-${date}.html`);
      fs.writeFileSync(txFilePath, html);
      fs.writeFileSync(wrFilePath, timeHtml);

      // Send emails with attachments
      await sendEmailToRecipients(
        [{ name: "Jetsetter Capital", email: companyEmail }],
        `Daily Transaction Summary - ${date}`,
        html,
        [{ filename: `Daily_Transaction_Summary_${date}.html`, path: txFilePath }]
      );
      if (todayTimeReports.length > 0 || todayWorkCreditsForReport.length > 0) {
        await sendEmailToRecipients(
          [{ name: "Jetsetter Capital", email: companyEmail }],
          `Daily Work Report - ${date}`,
          timeHtml,
          [{ filename: `Daily_Work_Report_${date}.html`, path: wrFilePath }]
        );
      }
      sentTo.push(companyEmail);

      // Upload report files to shared Drive folders for company access
      if (isGoogleEnabled()) {
        try {
          // Create "Daily Transaction Summary" folder, share with company, upload
          const txFolder = await ensureDriveFolder("Daily Transaction Summary");
          if (txFolder) {
            await shareFolderWithEmail(txFolder, companyEmail);
            await uploadToDrive(txFilePath, `Daily_Transaction_Summary_${date}.html`, txFolder);
          }
          // Create "Daily Work Report" folder, share with company, upload
          const wrFolder = await ensureDriveFolder("Daily Work Report");
          if (wrFolder) {
            await shareFolderWithEmail(wrFolder, companyEmail);
            await uploadToDrive(wrFilePath, `Daily_Work_Report_${date}.html`, wrFolder);
          }
        } catch (e) { console.error("[daily-report] Drive folder upload failed:", e); }
      }

      // Clean up temp files
      try { fs.unlinkSync(txFilePath); } catch {}
      try { fs.unlinkSync(wrFilePath); } catch {}
    } catch (e) { console.error("[daily-report] Failed to send to company email:", e); }

    // Send work credits report to workCreditReport subscribers
    const wcSubscribers = allUsers.filter((u: any) => u.workCreditReport && u.email);
    const wcRecipients = wcSubscribers.map(u => ({ name: u.displayName, email: u.email! }));
    if (wcRecipients.length > 0 && todayWorkCredits.length > 0) {
      await sendEmailToRecipients(wcRecipients, `Daily Work Credits Report - ${date}`, wcHtml);
      sentTo.push(...wcRecipients.map(r => r.email));
    }

    // Update document tracking spreadsheet
    try { await updateDocTrackingSheet(); } catch (e) { console.error("[doc-tracking] Daily update failed:", e); }

    // Save report to Google Drive "Daily Reports" folder
    if (isGoogleEnabled()) {
      try {
        const reportsFolder = await ensureDriveFolder("Daily Reports");
        if (reportsFolder) {
          const reportPath = path.resolve(dataDir, `report-${date}.html`);
          fs.writeFileSync(reportPath, html);
          await uploadToDrive(reportPath, `Daily Report - ${date}.html`, reportsFolder);
          try { fs.unlinkSync(reportPath); } catch {}
          console.log(`[daily-report] Saved to Drive: Daily Report - ${date}.html`);
          // Share Daily Reports folder with company email
          await shareFolderWithEmail(reportsFolder, "jetsettercapitalllc@gmail.com");
        }
      } catch (e: any) { console.error("[daily-report] Drive save failed:", e.message?.slice(0, 200)); }
    }

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

    const { property, type, category, amount, date, unitLotNumber, tenantName, bankName, description, photoPath, photoPaths } = req.body;
    if (!property || !type || !category || !amount || !date) {
      return res.status(400).json({ error: "property, type, category, amount, and date are required" });
    }
    if (!["income", "spent"].includes(type)) {
      return res.status(400).json({ error: "type must be 'income' or 'spent'" });
    }

    const user = await storage.getUser(session.userId);
    const recordNumber = await storage.getNextCashRecordNumber(property);
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
      photoPath: photoPath || null,
      photoPaths: photoPaths || null,
      recordNumber,
      syncedToSheets: 0,
      syncedToDrive: 0,
      createdAt: new Date().toISOString(),
    });

    res.json(tx);

    // Background sync and email notification
    setImmediate(async () => {
      const submittedByName = user?.displayName || "Unknown";
      // Sync to Cash Sheets
      if (isGoogleEnabled() && cashSheetsConfig && cashSheetsConfig.tabs[property]) {
        try {
          const balance = await storage.getCashBalanceByProperty(property);
          const row = [date, type, category, amount, unitLotNumber || "", tenantName || "", bankName || "", description || "", submittedByName, new Date().toISOString(), String(recordNumber), String(balance.toFixed(2))];
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
              const mainReceiptsFolder = await ensureDriveFolder("Credit Card and Cash Receipts");
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
            const driveFileName = `Cash ${typeLabel}_${property}_${date}.${ext}`;
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

  app.post("/api/admin/upload-statement", upload.single("statement"), async (req: any, res) => {
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
    const { property, date, startTime, endTime, timeBlocks, accomplishments, miles, mileageAmount, specialTerms, specialTermsAmount, notes } = req.body;
    if (!property || !date || !startTime || !endTime || !accomplishments) {
      return res.status(400).json({ error: "Missing required fields" });
    }

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

          // Update Time Reporting tracking spreadsheet
          try {
            // Use the shared time tracking config (spreadsheet at Drive root)
            const trConfigPath = path.resolve(dataDir, "time-tracking-config.json");
            let trConfig: any = null;
            if (fs.existsSync(trConfigPath)) {
              trConfig = JSON.parse(fs.readFileSync(trConfigPath, "utf-8"));
            }
            // If no spreadsheet config, trigger a full sync which creates it
            if (!trConfig?.spreadsheetId) {
              console.log("[time-report] No time tracking spreadsheet yet, will be created on next sync");
            }
            if (trConfig?.spreadsheetId) {
              const tabName = displayName;
              await createSheetTab(trConfig.spreadsheetId, tabName, [
                "Date", "Property", "Time Blocks", "Total Hours", "Rate",
                "Labor", "Miles", "Mileage Pay", "Special Terms",
                "Total", "Accomplishments", "Notes", "Submitted At",
              ]);
              // Write one row per time block (split shifts get separate rows)
              if (blocks.length > 1) {
                for (let bi = 0; bi < blocks.length; bi++) {
                  const blk = blocks[bi];
                  const [bsh, bsm] = blk.start.split(":").map(Number);
                  const [beh, bem] = blk.end.split(":").map(Number);
                  const blockHours = ((beh * 60 + bem) - (bsh * 60 + bsm)) / 60;
                  const blockLabor = blockHours * rate;
                  await appendSheetRow(trConfig.spreadsheetId, tabName, [
                    date,
                    property,
                    `${blk.start} - ${blk.end}`,
                    blockHours.toFixed(1),
                    `$${rate.toFixed(2)}`,
                    `$${blockLabor.toFixed(2)}`,
                    bi === 0 ? `${milesVal}` : "0",
                    bi === 0 ? `$${mileageVal.toFixed(2)}` : "$0.00",
                    bi === 0 ? `$${specialVal.toFixed(2)}` : "$0.00",
                    bi === 0 ? `$${totalCost.toFixed(2)}` : `$${blockLabor.toFixed(2)}`,
                    bi === 0 ? accList.join("; ") : "(continued)",
                    bi === 0 ? (notes || "") : "",
                    new Date().toISOString(),
                  ]);
                }
              } else {
                await appendSheetRow(trConfig.spreadsheetId, tabName, [
                  date,
                  property,
                  timeDisplay,
                  totalHours.toFixed(1),
                  `$${rate.toFixed(2)}`,
                  `$${laborCost.toFixed(2)}`,
                  `${milesVal}`,
                  `$${mileageVal.toFixed(2)}`,
                  `$${specialVal.toFixed(2)}`,
                  `$${totalCost.toFixed(2)}`,
                  accList.join("; "),
                  notes || "",
                  new Date().toISOString(),
                ]);
              }
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
      const ownReports = await storage.getTimeReportsByUser(session.userId);
      // Property managers with allowCreatingContractors see time reports for their assigned properties too
      const pmUser = await storage.getUser(session.userId);
      if ((pmUser as any)?.allowCreatingContractors) {
        const pmPropIds = new Set(await storage.getUserPropertyIds(session.userId));
        if (pmPropIds.size > 0) {
          const allProps = await storage.getAllProperties();
          const pmPropNames = new Set(allProps.filter(p => pmPropIds.has(p.id)).map(p => p.name));
          const allReports = await storage.getAllTimeReports();
          const propertyReports = allReports.filter(r => pmPropNames.has(r.property));
          const byId = new Map<number, typeof allReports[number]>();
          for (const r of ownReports) byId.set(r.id, r);
          for (const r of propertyReports) byId.set(r.id, r);
          reports = Array.from(byId.values()).sort((a, b) => b.id - a.id);
        } else {
          reports = ownReports;
        }
      } else {
        reports = ownReports;
      }
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
    await storage.deleteTimeReport(parseInt(req.params.id));
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
      // Non-admins see their own submissions AND any work credits for properties they manage
      const ownCredits = await storage.getWorkCreditsByUser(session.userId);
      const assignedProps = await storage.getPropertiesForUser(session.userId);
      const assignedPropNames = new Set(assignedProps.map(p => p.name));
      credits = ownCredits;
      if (assignedPropNames.size > 0) {
        const allCredits = await storage.getAllWorkCredits();
        const propertyCredits = allCredits.filter(c => assignedPropNames.has(c.property));
        const byId = new Map<number, typeof allCredits[number]>();
        for (const c of ownCredits) byId.set(c.id, c);
        for (const c of propertyCredits) byId.set(c.id, c);
        credits = Array.from(byId.values()).sort((a, b) => b.id - a.id);
      }
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

  // ---- User Documents ----
  app.post("/api/user-documents", upload.single("document"), async (req, res) => {
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
  app.post("/api/contractor-documents", upload.single("document"), async (req, res) => {
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
          // Upload to Contractor Documents > {ContractorName} folder
          const mainFolder = await ensureDriveFolder("Contractor Documents");
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

    let totalHours = 0;
    let totalMiles = 0;
    let totalMileagePay = 0;
    let totalSpecialTerms = 0;
    const daysWorked = new Set<string>();

    for (const r of reports) {
      let blocks: { start: string; end: string }[] = [];
      try { blocks = r.timeBlocks ? JSON.parse(r.timeBlocks) : []; } catch {}
      if (blocks.length > 0) {
        totalHours += blocks.reduce((sum, b) => {
          const [bsh, bsm] = b.start.split(":").map(Number);
          const [beh, bem] = b.end.split(":").map(Number);
          return sum + ((beh * 60 + bem) - (bsh * 60 + bsm)) / 60;
        }, 0);
      } else {
        const [sh, sm] = (r.startTime || "0:0").split(":").map(Number);
        const [eh, em] = (r.endTime || "0:0").split(":").map(Number);
        totalHours += ((eh * 60 + em) - (sh * 60 + sm)) / 60;
      }
      totalMiles += parseFloat(r.miles || "0");
      totalMileagePay += parseFloat(r.mileageAmount || "0");
      if (r.specialTerms) totalSpecialTerms += parseFloat(r.specialTermsAmount || "0");
      daysWorked.add(r.date);
    }

    const baseRate = parseFloat((userObj as any)?.baseRate || "0");
    const offSiteRate = parseFloat((userObj as any)?.offSiteRate || "0");
    const homeProperty = (userObj as any)?.homeProperty || "";
    const mileageRate = parseFloat((userObj as any)?.mileageRate || "0.50");
    const laborCost = totalHours * baseRate;
    const grandTotal = laborCost + totalMileagePay + totalSpecialTerms;

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
      const rate = isOffSite ? offSiteRate : baseRate;
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
        laborCost: parseFloat(laborCost.toFixed(2)),
        grandTotal: parseFloat(grandTotal.toFixed(2)),
        baseRate,
      },
      reports: enrichedReports,
    };
  }

  // Helper: determine which user IDs a given viewer may run workforce reports for.
  async function getWorkforceViewableUserIds(viewerId: number, viewerRole: string): Promise<Set<number>> {
    const allowed = new Set<number>([viewerId]);
    if (isAdminRole(viewerRole)) {
      const all = await storage.getAllUsers();
      for (const u of all) allowed.add(u.id);
      return allowed;
    }
    // Managers with allowCreatingContractors can see CONTRACTORS whose
    // assigned properties overlap with theirs. Other managers on the same
    // property are intentionally excluded — pay is only visible for the
    // viewer themselves and the contractors they oversee.
    const viewer = await storage.getUser(viewerId);
    if ((viewer as any)?.allowCreatingContractors) {
      const viewerPropIds = new Set(await storage.getUserPropertyIds(viewerId));
      if (viewerPropIds.size > 0) {
        const all = await storage.getAllUsers();
        for (const u of all) {
          if (u.id === viewerId) continue;
          if (u.role !== "contractor") continue;
          const uPropIds = await storage.getUserPropertyIds(u.id);
          if (uPropIds.some(pid => viewerPropIds.has(pid))) allowed.add(u.id);
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
    const reports = await storage.getTimeReportsByUserAndDateRange(parseInt(userId), startDate, endDate);
    const userObj = await storage.getUser(parseInt(userId));

    let totalHours = 0;
    let totalMiles = 0;
    let totalMileagePay = 0;
    let totalSpecialTerms = 0;
    const daysWorked = new Set<string>();

    for (const r of reports) {
      // Calculate hours from timeBlocks if available, fallback to startTime/endTime
      let blocks: { start: string; end: string }[] = [];
      try { blocks = r.timeBlocks ? JSON.parse(r.timeBlocks) : []; } catch {}
      if (blocks.length > 0) {
        totalHours += blocks.reduce((sum, b) => {
          const [bsh, bsm] = b.start.split(":").map(Number);
          const [beh, bem] = b.end.split(":").map(Number);
          return sum + ((beh * 60 + bem) - (bsh * 60 + bsm)) / 60;
        }, 0);
      } else {
        const [sh, sm] = (r.startTime || "0:0").split(":").map(Number);
        const [eh, em] = (r.endTime || "0:0").split(":").map(Number);
        totalHours += ((eh * 60 + em) - (sh * 60 + sm)) / 60;
      }
      totalMiles += parseFloat(r.miles || "0");
      totalMileagePay += parseFloat(r.mileageAmount || "0");
      if (r.specialTerms) totalSpecialTerms += parseFloat(r.specialTermsAmount || "0");
      daysWorked.add(r.date);
    }

    // Calculate labor cost
    const baseRate = parseFloat((userObj as any)?.baseRate || "0");
    const offSiteRate = parseFloat((userObj as any)?.offSiteRate || "0");
    const homeProperty = (userObj as any)?.homeProperty || "";
    const mileageRate = parseFloat((userObj as any)?.mileageRate || "0.50");
    const laborCost = totalHours * baseRate;
    const grandTotal = laborCost + totalMileagePay + totalSpecialTerms;

    // Enrich each report with per-entry calculations
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
      const rate = isOffSite ? offSiteRate : baseRate;
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

      const headers = [
        "Date", "Property", "Time Blocks", "Total Hours", "Rate ($/hr)",
        "Labor ($)", "Miles", "Mileage Pay ($)", "Special Terms ($)",
        "Total ($)", "Accomplishments", "Notes", "Submitted At",
      ];

      for (const [userId, reports] of reportsByUser) {
        const user = userMap.get(userId);
        if (!user) continue;
        const tabName = user.displayName || `User ${userId}`;

        // Create tab with headers (will skip if already exists)
        const created = await createSheetTab(trConfig.spreadsheetId, tabName, headers);
        if (created && created > 0) tabsCreated++;

        // Clear existing data (keep headers) and rewrite all rows
        await clearSheet(trConfig.spreadsheetId, `'${tabName}'!A2:Z`);

        const homeProperty = (user as any)?.homeProperty || "";
        const baseRate = parseFloat((user as any)?.baseRate || "0");
        const offSiteRate = parseFloat((user as any)?.offSiteRate || "0");

        // Sort reports by date
        const sorted = [...reports].sort((a, b) => a.date.localeCompare(b.date));

        const rows: string[][] = [];
        for (const r of sorted) {
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

          const isOffSite = r.property !== homeProperty && (user as any)?.allowOffSite;
          const rate = isOffSite ? offSiteRate : baseRate;
          const laborCost = hours * rate;
          const milesVal = parseFloat(r.miles || "0");
          const mileageVal = parseFloat(r.mileageAmount || "0");
          const specialVal = r.specialTerms ? parseFloat(r.specialTermsAmount || "0") : 0;
          const totalCost = laborCost + mileageVal + specialVal;

          let accs: string[] = [];
          try { accs = JSON.parse(r.accomplishments || "[]"); } catch {}

          // If split shifts, write one row per block
          if (blocks.length > 1) {
            for (let bi = 0; bi < blocks.length; bi++) {
              const blk = blocks[bi];
              const [bsh, bsm] = blk.start.split(":").map(Number);
              const [beh, bem] = blk.end.split(":").map(Number);
              const blockHours = ((beh * 60 + bem) - (bsh * 60 + bsm)) / 60;
              const blockLabor = blockHours * rate;
              rows.push([
                r.date,
                r.property + (isOffSite ? " (off-site)" : ""),
                `${blk.start} - ${blk.end}`,
                blockHours.toFixed(1),
                `$${rate.toFixed(2)}`,
                `$${blockLabor.toFixed(2)}`,
                bi === 0 ? milesVal.toString() : "0",
                bi === 0 ? `$${mileageVal.toFixed(2)}` : "$0.00",
                bi === 0 ? `$${specialVal.toFixed(2)}` : "$0.00",
                bi === 0 ? `$${totalCost.toFixed(2)}` : `$${blockLabor.toFixed(2)}`,
                bi === 0 ? accs.join("; ") : "(continued)",
                bi === 0 ? (r.notes || "") : "",
                r.createdAt,
              ]);
            }
          } else {
            rows.push([
              r.date,
              r.property + (isOffSite ? " (off-site)" : ""),
              timeDisplay,
              hours.toFixed(1),
              `$${rate.toFixed(2)}`,
              `$${laborCost.toFixed(2)}`,
              milesVal.toString(),
              `$${mileageVal.toFixed(2)}`,
              `$${specialVal.toFixed(2)}`,
              `$${totalCost.toFixed(2)}`,
              accs.join("; "),
              r.notes || "",
              r.createdAt,
            ]);
          }
          rowsWritten += rows.length;
        }

        if (rows.length > 0) {
          await updateSheetRange(trConfig.spreadsheetId, `'${tabName}'!A2`, rows);
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
