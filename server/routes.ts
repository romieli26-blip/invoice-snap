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
import nodemailer from "nodemailer";

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

// Lazy-initialized email transporter
let _emailTransporter: any = null;
function getEmailTransporter() {
  if (_emailTransporter) return _emailTransporter;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!pass) {
    console.log("[email] GMAIL_APP_PASSWORD not set");
    return null;
  }
  _emailTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: "jetsetterinvoices1@gmail.com", pass },
  });
  console.log("[email] Transporter initialized");
  return _emailTransporter;
}

async function sendNotificationEmails(subject: string, htmlBody: string, attachments?: any[]) {
  const transporter = getEmailTransporter();
  if (!transporter) {
    console.log("[email] Skipping — no GMAIL_APP_PASSWORD configured");
    return;
  }
  for (const recipient of EMAIL_RECIPIENTS) {
    try {
      await transporter.sendMail({
        from: '"Receipt App" <jetsetterinvoices1@gmail.com>',
        to: `${recipient.name} <${recipient.email}>`,
        subject,
        html: htmlBody,
        attachments: attachments || [],
      });
      console.log(`[email] Sent to ${recipient.email}`);
    } catch (err: any) {
      console.error(`[email] Failed to send to ${recipient.email}:`, err.message?.slice(0, 200));
    }
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

async function requireAdmin(req: Request, res: Response): Promise<{ userId: number; role: string } | null> {
  const session = await requireAuth(req, res);
  if (!session) return null;
  if (session.role !== "admin") {
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
      if (!mainFolderId) mainFolderId = await ensureDriveFolder("Main App Invoices");
      // Receipts subfolder: Main App Invoices > Receipts > Property
      const receiptsFolder = await ensureDriveFolder("Receipts", mainFolderId || undefined);
      let propertyFolderId = propertyFolderCache.get("receipts_" + invoice.property) || null;
      if (!propertyFolderId && receiptsFolder) {
        propertyFolderId = await ensureDriveFolder(invoice.property, receiptsFolder);
        if (propertyFolderId) propertyFolderCache.set("receipts_" + invoice.property, propertyFolderId);
      }
      for (let i = 0; i < allPaths.length; i++) {
        const p = allPaths[i];
        const filePath = path.resolve(dataDir, "uploads", p.replace(/^\/api\/uploads\//, ""));
        if (!fs.existsSync(filePath)) continue;
        const ext = path.extname(filePath).slice(1) || "jpg";
        const suffix = allPaths.length > 1 ? ` (${i + 1} of ${allPaths.length})` : "";
        const fileName = `${invoice.property} - ${invoice.purchaseDate} ${safeDesc}${suffix}.${ext}`;
        await uploadToDrive(filePath, fileName, propertyFolderId || receiptsFolder || mainFolderId || undefined);
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

    res.json({ token, user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } });
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
    res.json({ id: user.id, username: user.username, displayName: user.displayName, role: user.role });
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
        assignedProperties: propIds.map(pid => propMap.get(pid)).filter(Boolean) as string[],
      };
    }));
    res.json(enriched);
  });

  app.post("/api/users", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;

    const { username, password, displayName, role } = req.body;
    if (!username || !password || !displayName) {
      return res.status(400).json({ error: "Username, password, and display name are required" });
    }

    const existing = await storage.getUserByUsername(username);
    if (existing) return res.status(409).json({ error: "Username already taken" });

    const user = await storage.createUser({
      username,
      password,
      displayName,
      role: role || "manager",
    });

    res.json({ id: user.id, username: user.username, displayName: user.displayName, role: user.role });
  });

  app.delete("/api/users/:id", async (req, res) => {
    const session = await requireAdmin(req, res);
    if (!session) return;

    const id = parseInt(req.params.id);
    if (id === session.userId) return res.status(400).json({ error: "Cannot delete yourself" });

    await storage.deleteUser(id);
    res.json({ ok: true });
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
    if (session.role === "admin") {
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
          `New Receipt: ${typeLabel} $${invoice.amount} — ${invoice.property}`,
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
    if (session.role === "admin") {
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
    if (session.role !== "admin" && existing.userId !== session.userId) {
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
            `Receipt EDITED: ${existing.property} #${existing.recordNumber || ""} — $${updated.amount}`,
            `<h3>Receipt Edited</h3>
             <p><strong>Property:</strong> ${existing.property}</p>
             <p><strong>Record #:</strong> ${existing.recordNumber || "N/A"}</p>
             <p><strong>Edited by:</strong> ${editEntry.by}</p>
             <p><strong>Changes:</strong></p>
             <ul>${editEntry.changes.map((c: string) => `<li>${c}</li>`).join("")}</ul>
             <p><strong>New Amount:</strong> $${updated.amount}</p>
             <p style="color:#888;font-size:12px;margin-top:16px;">— Receipt App</p>`,
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
    if (session.role !== "admin" && invoice.userId !== session.userId) {
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

  app.get("/api/invoices/export", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;

    let invoicesList;
    if (session.role === "admin") {
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
            if (!mainFolderId) mainFolderId = await ensureDriveFolder("Main App Invoices");
            let cashFolder = await ensureDriveFolder("Cash Transactions", mainFolderId || undefined);
            let propFolder = cashFolder ? await ensureDriveFolder(property, cashFolder) : null;
            const ext = path.extname(filePath).slice(1) || "jpg";
            const driveFileName = `Cash ${typeLabel}_${property}_${date}.${ext}`;
            await uploadToDrive(filePath, driveFileName, propFolder || cashFolder || mainFolderId || undefined);
            await storage.updateCashTransactionSyncStatus(tx.id, "drive", true);
          }
        } catch (e) { console.error("[cash-drive] Sync error:", e); }
      }
      try {
        const typeLabel = type === "income" ? "Income" : "Spent";
        await sendNotificationEmails(
          `Cash ${typeLabel}: $${amount} — ${property}`,
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
           <p><strong>Record #:</strong> ${recordNumber}</p>`
        );
      } catch (e) { console.error("[email] Cash tx notification error:", e); }
    });
  });

  app.get("/api/cash-transactions", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;

    let txList;
    if (session.role === "admin") {
      txList = await storage.getAllCashTransactions();
    } else {
      txList = await storage.getCashTransactionsByUser(session.userId);
    }

    const allUsers = await storage.getAllUsers();
    const userMap = new Map(allUsers.map(u => [u.id, u.displayName]));
    const enriched = txList.map(tx => ({
      ...tx,
      submittedBy: userMap.get(tx.userId) || "Unknown",
    }));

    res.json(enriched);
  });

  app.get("/api/cash-transactions/export", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    if (session.role !== "admin") return res.status(403).json({ error: "Admin only" });

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

    if (session.role !== "admin" && tx.userId !== session.userId) {
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
    if (session.role !== "admin" && existing.userId !== session.userId) {
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
    if (session.role === "admin") {
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

  return httpServer;
}
