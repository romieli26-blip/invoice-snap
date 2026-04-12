import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { loginSchema, invoiceFormSchema, DEFAULT_PROPERTIES } from "@shared/schema";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import { initGoogleApis, isGoogleEnabled, appendSheetRow, createSheetTab, uploadToDrive, ensureDriveFolder, deleteSheetRow, deleteFromDrive, highlightLastRow } from "./google-api";
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
const EMAIL_RECIPIENTS = [
  { name: "Ben", email: "Ben@Jetsettercapital.com" },
  { name: "Jared", email: "Jared@Jetsettercapital.com" },
  { name: "Dustin", email: "Dustin@Jetsettercapital.com" },
];

// Email via Gmail API (SMTP is blocked on Railway)
import { google } from "googleapis";

async function sendNotificationEmails(subject: string, htmlBody: string, attachments?: { filename: string; path: string }[]) {
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

    for (const recipient of EMAIL_RECIPIENTS) {
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
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB max
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "application/pdf"];
    cb(null, allowed.includes(file.mimetype));
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
      // Folder structure: Credit Card Receipts > Property
      let ccReceiptsFolder = propertyFolderCache.get("__cc_receipts_root") || null;
      if (!ccReceiptsFolder) {
        ccReceiptsFolder = await ensureDriveFolder("Credit Card Receipts");
        if (ccReceiptsFolder) propertyFolderCache.set("__cc_receipts_root", ccReceiptsFolder);
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
    res.json({
      id: user.id, username: user.username, displayName: user.displayName, role: user.role,
      firstName: (user as any).firstName, lastName: (user as any).lastName,
      mileageRate: (user as any).mileageRate, allowOffSite: (user as any).allowOffSite,
      allowSpecialTerms: (user as any).allowSpecialTerms, specialTermsAmount: (user as any).specialTermsAmount,
      homeProperty: (user as any).homeProperty, baseRate: (user as any).baseRate, offSiteRate: (user as any).offSiteRate,
      mustChangePassword: (user as any).mustChangePassword || 0,
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
    } as any);

    res.json({ id: user.id, username: user.username, displayName: user.displayName, role: user.role, email: user.email });
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
      requireFinancialConfirm } = req.body;

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

    await storage.deleteProperty(id);
    res.json({ ok: true });
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
           <p><strong>Submitted By:</strong> ${submittedByName}</p>
           <p><strong>Date:</strong> ${invoice.purchaseDate}</p>
           <p><strong>Record #:</strong> ${invoice.recordNumber || "N/A"}</p>`,
          attachments
        );
      } catch (e) { console.error("[email] Notification error:", e); }
    });
  });

  app.get("/api/invoices", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;

    let invoicesList;
    if (isAdminRole(session.role)) {
      invoicesList = await storage.getAllInvoices();
    } else {
      invoicesList = await storage.getInvoicesByUser(session.userId);
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
    const session = await requireAdmin(req, res);
    if (!session) return;

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

    // Build separate Time Report HTML
    const todayTimeReports = await storage.getTimeReportsByDate(date);
    let timeHtml = `<div style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;">`;
    timeHtml += `<h1 style="color:#3b82f6;">Daily Work Report - ${date}</h1>`;
    timeHtml += `<p style="color:#666;">Generated on ${new Date().toISOString().replace("T", " ").slice(0, 19)}</p>`;
    if (todayTimeReports.length > 0) {
      const allUsersMap = new Map(allUsers.map(u => [u.id, u]));
      for (const tr of todayTimeReports) {
        const trUser = allUsersMap.get(tr.userId);
        const name = trUser?.displayName || "Unknown";
        let accomplishmentsList: string[] = [];
        try { accomplishmentsList = JSON.parse(tr.accomplishments || "[]"); } catch {}
        // Calculate hours from timeBlocks if available, fallback to startTime/endTime
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
        timeHtml += `<div style="background:#f0f4ff;padding:10px;border-radius:5px;margin:8px 0;">`;
        timeHtml += `<p><strong>${name}</strong> - ${tr.property} (${timeDisplay}, ${hours.toFixed(1)}h)</p>`;
        if (accomplishmentsList.length > 0) {
          timeHtml += `<ul style="margin:4px 0;">${accomplishmentsList.map((a: string) => `<li>${a}</li>`).join("")}</ul>`;
        }
        if (tr.miles) timeHtml += `<p>Miles: ${tr.miles} ($${tr.mileageAmount || "0.00"})</p>`;
        if (tr.specialTerms) timeHtml += `<p>Travel Expenses: $${tr.specialTermsAmount || "0.00"}</p>`;
        if (tr.notes) timeHtml += `<p style="color:#666;">Notes: ${tr.notes}</p>`;
        timeHtml += `</div>`;
      }
    } else {
      timeHtml += `<p style="color:#888;">No work reports today.</p>`;
    }
    timeHtml += `<p style="color:#888;font-size:12px;margin-top:20px;">- Receipt App Work Report</p></div>`;

    // Send transaction report to dailyTransactionReport subscribers
    const txSubscribers = allUsers.filter((u: any) => u.dailyTransactionReport && u.email);
    // Fallback: also include old dailyReport subscribers for backward compat
    const oldSubscribers = allUsers.filter((u: any) => u.dailyReport && u.email && !u.dailyTransactionReport);
    const txRecipients = [...txSubscribers, ...oldSubscribers].map(u => ({ name: u.displayName, email: u.email! }));
    const sentTo: string[] = [];

    if (txRecipients.length > 0) {
      const origRecipients = [...EMAIL_RECIPIENTS];
      (EMAIL_RECIPIENTS as any).length = 0;
      txRecipients.forEach(r => (EMAIL_RECIPIENTS as any).push(r));
      await sendNotificationEmails(`Daily Transaction Summary - ${date}`, html);
      (EMAIL_RECIPIENTS as any).length = 0;
      origRecipients.forEach(r => (EMAIL_RECIPIENTS as any).push(r));
      sentTo.push(...txRecipients.map(r => r.email));
    }

    // Send time report to dailyTimeReport subscribers
    const timeSubscribers = allUsers.filter((u: any) => u.dailyTimeReport && u.email);
    const timeRecipients = timeSubscribers.map(u => ({ name: u.displayName, email: u.email! }));
    if (timeRecipients.length > 0 && todayTimeReports.length > 0) {
      const origRecipients = [...EMAIL_RECIPIENTS];
      (EMAIL_RECIPIENTS as any).length = 0;
      timeRecipients.forEach(r => (EMAIL_RECIPIENTS as any).push(r));
      await sendNotificationEmails(`Daily Work Report - ${date}`, timeHtml);
      (EMAIL_RECIPIENTS as any).length = 0;
      origRecipients.forEach(r => (EMAIL_RECIPIENTS as any).push(r));
      sentTo.push(...timeRecipients.map(r => r.email));
    }

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
        }
      } catch (e: any) { console.error("[daily-report] Drive save failed:", e.message?.slice(0, 200)); }
    }

    res.json({ ok: true, date, receipts: todayInvoices.length, cashTx: todayCash.length, timeReports: todayTimeReports.length, sentTo: [...new Set(sentTo)] });
  });

  app.get("/api/invoices/export", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;

    let invoicesList;
    if (isAdminRole(session.role)) {
      invoicesList = await storage.getAllInvoices();
    } else {
      invoicesList = await storage.getInvoicesByUser(session.userId);
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
            // Folder structure: Cash Transactions > Property
            let cashFolder = propertyFolderCache.get("__cash_root") || null;
            if (!cashFolder) {
              cashFolder = await ensureDriveFolder("Cash Transactions");
              if (cashFolder) propertyFolderCache.set("__cash_root", cashFolder);
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

    const transactions = parseStatementCsv(fullPath);

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
                await uploadToDrive(fullPath, `Statement_${property}_${startDate}_to_${endDate}.csv`, propFolder);
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
        const origRecipients = [...EMAIL_RECIPIENTS];
        EMAIL_RECIPIENTS.length = 0;
        subscribers.forEach((u: any) => EMAIL_RECIPIENTS.push({ name: u.displayName, email: u.email }));
        await sendNotificationEmails(subject, html);
        EMAIL_RECIPIENTS.length = 0;
        origRecipients.forEach(r => EMAIL_RECIPIENTS.push(r));
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

    // Drive sync in background
    setImmediate(async () => {
      try {
        if (isGoogleEnabled()) {
          const user = await storage.getUser(session.userId);
          const userName = (user as any)?.firstName && (user as any)?.lastName
            ? `${(user as any).firstName}_${(user as any).lastName}`
            : user?.displayName || "Unknown";
          const folderName = `${property}_${userName}`;

          const mainFolder = await ensureDriveFolder("Time Reporting");
          if (mainFolder) {
            const userFolder = await ensureDriveFolder(folderName, mainFolder);
            if (userFolder) {
              const reportsFolder = await ensureDriveFolder("Time Reports", userFolder);
              if (reportsFolder) {
                const accList = Array.isArray(accomplishments) ? accomplishments : JSON.parse(accomplishments);
                // Build time display for Drive report
                let driveTimeDisplay = `${startTime} - ${endTime}`;
                if (timeBlocks && Array.isArray(timeBlocks) && timeBlocks.length > 1) {
                  driveTimeDisplay = timeBlocks.map((b: any) => `${b.start} - ${b.end}`).join(", ");
                }
                const reportHtml = `<html><body style="font-family:Arial;">
                  <h2>Time Report - ${date}</h2>
                  <p><strong>Employee:</strong> ${user?.displayName}</p>
                  <p><strong>Property:</strong> ${property}</p>
                  <p><strong>Hours:</strong> ${driveTimeDisplay}</p>
                  <p><strong>Accomplishments:</strong></p>
                  <ul>${accList.map((a: string) => `<li>${a}</li>`).join("")}</ul>
                  ${miles ? `<p><strong>Miles:</strong> ${miles} ($${mileageAmount})</p>` : ""}
                  ${specialTerms ? `<p><strong>Travel Expenses:</strong> $${specialTermsAmount}</p>` : ""}
                  ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ""}
                </body></html>`;
                const reportPath = path.resolve(dataDir, `time-report-${report.id}.html`);
                fs.writeFileSync(reportPath, reportHtml);
                await uploadToDrive(reportPath, `Time_Report_${date}.html`, reportsFolder);
                try { fs.unlinkSync(reportPath); } catch {}
              }
            }
          }
        }
      } catch (e) { console.error("[time-report] Drive sync error:", e); }
    });
  });

  app.get("/api/time-reports", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    let reports;
    if (isAdminRole(session.role)) {
      reports = await storage.getAllTimeReports();
    } else {
      reports = await storage.getTimeReportsByUser(session.userId);
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

  // ---- User Documents ----
  app.post("/api/user-documents", upload.single("file"), async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const { docType, bankName, routingNumber, accountNumber } = req.body;
    if (!docType) return res.status(400).json({ error: "docType is required" });
    const filePath = req.file ? `/uploads/${req.file.filename}` : null;
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
    if (req.file) {
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
                  const fullPath = path.resolve(dataDir, "uploads", req.file!.filename);
                  if (fs.existsSync(fullPath)) {
                    const ext = path.extname(req.file!.filename).slice(1);
                    const docName = `${docType}_${docUser?.displayName || "user"}_${Date.now()}.${ext}`;
                    await uploadToDrive(fullPath, docName, docsFolder);
                  }
                }
              }
            }
          }
        } catch (e) { console.error("[docs] Drive sync error:", e); }
      });
    }
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
  });

  // ---- Admin Workforce Report ----
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

    res.json({
      user: {
        id: userObj?.id,
        displayName: userObj?.displayName,
        firstName: (userObj as any)?.firstName,
        lastName: (userObj as any)?.lastName,
        baseRate: (userObj as any)?.baseRate,
        offSiteRate: (userObj as any)?.offSiteRate,
      },
      period: { startDate, endDate },
      summary: {
        daysWorked: daysWorked.size,
        totalHours: totalHours.toFixed(1),
        totalMiles: totalMiles.toFixed(1),
        totalMileagePay: totalMileagePay.toFixed(2),
        totalSpecialTerms: totalSpecialTerms.toFixed(2),
      },
      reports,
    });
  });

  return httpServer;
}
