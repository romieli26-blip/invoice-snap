import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { loginSchema, invoiceFormSchema, DEFAULT_PROPERTIES } from "@shared/schema";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import { initGoogleApis, isGoogleEnabled, appendSheetRow, createSheetTab, uploadToDrive, ensureDriveFolder } from "./google-api";

// Ensure uploads directory exists
const uploadsDir = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ---- Google Sheets config ----
const SHEETS_CONFIG_PATH = path.resolve(process.cwd(), "sheets-config.json");
let sheetsConfig: { spreadsheetId: string; spreadsheetUrl?: string; tabs: Record<string, number> } | null = null;
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
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
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
  const filePath = path.resolve(process.cwd(), invoice.photoPath.replace(/^\/api\/uploads\//, "uploads/"));
  if (!fs.existsSync(filePath)) {
    console.error("[drive] File not found:", filePath);
    return false;
  }
  const ext = path.extname(filePath).slice(1) || "jpg";
  const safeDesc = (invoice.description || "invoice").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 40);
  const fileName = `${invoice.property} - ${invoice.purchaseDate} ${safeDesc}.${ext}`;

  // Try Google API first (works on Railway)
  if (isGoogleEnabled()) {
    try {
      // Ensure "Main App Invoices" folder exists
      if (!mainFolderId) {
        mainFolderId = await ensureDriveFolder("Main App Invoices");
      }
      // Ensure property subfolder exists
      let propertyFolderId = propertyFolderCache.get(invoice.property) || null;
      if (!propertyFolderId && mainFolderId) {
        propertyFolderId = await ensureDriveFolder(invoice.property, mainFolderId);
        if (propertyFolderId) propertyFolderCache.set(invoice.property, propertyFolderId);
      }
      return await uploadToDrive(filePath, fileName, propertyFolderId || mainFolderId || undefined);
    } catch (err: any) {
      console.error("[drive] Google API upload failed:", err.message?.slice(0, 200));
      return false;
    }
  }

  // Fallback to external-tool CLI (Perplexity sandbox)
  try {
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

    const { photoPath } = req.body;
    if (!photoPath) return res.status(400).json({ error: "Photo is required" });

    const user = await storage.getUser(session.userId);
    const invoice = await storage.createInvoice({
      userId: session.userId,
      photoPath,
      property: parsed.data.property,
      purchaseDate: parsed.data.purchaseDate,
      description: parsed.data.description,
      purpose: parsed.data.purpose,
      amount: parsed.data.amount,
      boughtBy: parsed.data.boughtBy || user?.displayName || "Unknown",
      paymentMethod: parsed.data.paymentMethod,
      lastFourDigits: parsed.data.paymentMethod === "cc" ? (parsed.data.lastFourDigits || null) : null,
      syncedToDrive: 0,
      syncedToSheets: 0,
      createdAt: new Date().toISOString(),
    });

    res.json(invoice);

    // Background sync to Google Drive & Sheets (non-blocking)
    setImmediate(async () => {
      const submittedByName = user?.displayName || "Unknown";
      try {
        const sheetsOk = syncToSheets(invoice, submittedByName);
        if (sheetsOk) {
          await storage.updateInvoiceSyncStatus(invoice.id, "sheets", true);
        }
      } catch (e) { /* ignore sync errors */ }
      try {
        const driveOk = syncToDrive(invoice);
        if (driveOk) {
          await storage.updateInvoiceSyncStatus(invoice.id, "drive", true);
        }
      } catch (e) { /* ignore sync errors */ }
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
    }));

    res.json(enriched);
  });

  app.delete("/api/invoices/:id", async (req, res) => {
    const session = await requireAuth(req, res);
    if (!session) return;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    // Managers can only delete their own invoices
    if (session.role !== "admin") {
      const invoice = await storage.getInvoice(id);
      if (!invoice || invoice.userId !== session.userId) {
        return res.status(403).json({ error: "Not authorized to delete this invoice" });
      }
    }

    await storage.deleteInvoice(id);
    res.json({ ok: true });
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

  return httpServer;
}
