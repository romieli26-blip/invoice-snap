import { type User, type InsertUser, type Invoice, type InsertInvoice, type Property, type InsertProperty, type CashTransaction, type InsertCashTransaction, type CcStatement, type TimeReport, type UserDocument, type WorkCredit, type ContractorDocument, users, invoices, properties, sessions, userProperties, cashTransactions, ccStatements, timeReports, userDocuments, workCredits, contractorDocuments } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, inArray, and, gte, lte } from "drizzle-orm";

import path from "path";

// Use DATA_DIR env var for persistent storage on Railway (mount a volume at /data)
const dataDir = process.env.DATA_DIR || ".";
const dbPath = path.join(dataDir, "data.db");
console.log(`[storage] Database path: ${dbPath}`);

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");

// Auto-create tables if they don't exist (needed for fresh deployments like Railway)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sheets_tab_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'manager'
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    property_id INTEGER NOT NULL,
    UNIQUE(user_id, property_id)
  );
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    photo_path TEXT NOT NULL,
    property TEXT NOT NULL,
    purchase_date TEXT NOT NULL,
    description TEXT NOT NULL,
    purpose TEXT NOT NULL,
    amount TEXT NOT NULL,
    bought_by TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    last_four_digits TEXT,
    synced_to_drive INTEGER NOT NULL DEFAULT 0,
    synced_to_sheets INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

// Migration: add new columns
try { sqlite.exec("ALTER TABLE invoices ADD COLUMN record_number INTEGER"); } catch {}
try { sqlite.exec("ALTER TABLE invoices ADD COLUMN rent_manager_issue TEXT"); } catch {}
try { sqlite.exec("ALTER TABLE invoices ADD COLUMN photo_paths TEXT"); } catch {}
try { sqlite.exec("ALTER TABLE invoices ADD COLUMN receipt_type TEXT DEFAULT 'expense'"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN email TEXT"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN daily_report INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN statement_reports INTEGER DEFAULT 0"); } catch {}
// Update ben to super_admin
try { sqlite.exec("UPDATE users SET role = 'super_admin' WHERE username = 'ben' AND role = 'admin'"); } catch {}

// User profile columns
try { sqlite.exec("ALTER TABLE users ADD COLUMN first_name TEXT"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN last_name TEXT"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN base_rate TEXT"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN off_site_rate TEXT"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN home_property TEXT"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN allow_off_site INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN mileage_rate TEXT DEFAULT '0.50'"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN allow_special_terms INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN special_terms_amount TEXT"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN w9_or_w4 TEXT"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN docs_complete INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN daily_time_report INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN daily_transaction_report INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN reconciliation_report INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN require_financial_confirm INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN allow_past_dates INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN receive_transaction_emails INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN allow_work_credits INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN document_upload_report INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN allow_contractor_docs INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN allow_creating_contractors INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN show_work_report INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN show_my_documents INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN show_work_credit INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN show_my_contractors INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN created_by_user_id INTEGER"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN allow_miles INTEGER DEFAULT 1"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN daily_reminder_enabled INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN work_credit_report INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN doc_reminder_enabled INTEGER DEFAULT 0"); } catch {}
try { sqlite.exec("ALTER TABLE users ADD COLUMN doc_reminder_days INTEGER DEFAULT 3"); } catch {}

// Time reports table
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS time_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    property TEXT NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    time_blocks TEXT,
    accomplishments TEXT NOT NULL,
    miles TEXT,
    mileage_amount TEXT,
    special_terms INTEGER DEFAULT 0,
    special_terms_amount TEXT,
    notes TEXT,
    synced_to_sheets INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

// Contractor Documents table (for non-users)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS contractor_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_by_user_id INTEGER NOT NULL,
    contractor_first_name TEXT NOT NULL,
    contractor_last_name TEXT NOT NULL,
    contractor_email TEXT,
    contractor_phone TEXT,
    doc_type TEXT NOT NULL,
    file_path TEXT,
    bank_name TEXT,
    routing_number TEXT,
    account_number TEXT,
    created_at TEXT NOT NULL
  );
`);

// Work Credits table
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS work_credits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    property TEXT NOT NULL,
    date TEXT NOT NULL,
    tenant_first_name TEXT NOT NULL,
    tenant_last_name TEXT NOT NULL,
    lot_or_unit TEXT NOT NULL,
    work_descriptions TEXT NOT NULL,
    credit_type TEXT NOT NULL,
    fixed_amount TEXT,
    hours_worked TEXT,
    hourly_rate TEXT,
    time_blocks TEXT,
    total_amount TEXT NOT NULL,
    synced_to_sheets INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

// Migration: add time_blocks column to existing time_reports tables
try {
  sqlite.exec(`ALTER TABLE time_reports ADD COLUMN time_blocks TEXT`);
} catch (e: any) {
  // Column already exists - ignore
}

// User documents table
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS user_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    doc_type TEXT NOT NULL,
    file_path TEXT,
    bank_name TEXT,
    routing_number TEXT,
    account_number TEXT,
    created_at TEXT NOT NULL
  );
`);

// CC Statements table
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS cc_statements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property TEXT NOT NULL,
    cc_last_digits TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    file_path TEXT NOT NULL,
    parsed_data TEXT,
    report_html TEXT,
    matched INTEGER DEFAULT 0,
    unmatched INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    uploaded_by INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);
try { sqlite.exec("ALTER TABLE invoices ADD COLUMN edit_history TEXT"); } catch {}
try { sqlite.exec("ALTER TABLE cash_transactions ADD COLUMN edit_history TEXT"); } catch {}

// Cash transactions table
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS cash_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    property TEXT NOT NULL,
    type TEXT NOT NULL,
    category TEXT NOT NULL,
    amount TEXT NOT NULL,
    date TEXT NOT NULL,
    unit_lot_number TEXT,
    tenant_name TEXT,
    bank_name TEXT,
    description TEXT,
    photo_path TEXT,
    photo_paths TEXT,
    record_number INTEGER,
    synced_to_sheets INTEGER NOT NULL DEFAULT 0,
    synced_to_drive INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

export const db = drizzle(sqlite);

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getAllUsers(): Promise<User[]>;
  deleteUser(id: number): Promise<void>;
  updateUser(id: number, data: Partial<InsertUser>): Promise<User | undefined>;
  createInvoice(invoice: InsertInvoice): Promise<Invoice>;
  getInvoicesByUser(userId: number): Promise<Invoice[]>;
  getAllInvoices(): Promise<Invoice[]>;
  getInvoice(id: number): Promise<Invoice | undefined>;
  deleteInvoice(id: number): Promise<void>;
  updateInvoice(id: number, data: any): Promise<Invoice | undefined>;
  getNextRecordNumber(property: string): Promise<number>;
  updateInvoiceSyncStatus(id: number, target: "drive" | "sheets", synced: boolean): Promise<void>;
  // Session methods
  createSession(token: string, userId: number, role: string): Promise<void>;
  getSession(token: string): Promise<{ userId: number; role: string } | undefined>;
  deleteSession(token: string): Promise<void>;
  // Property methods
  getAllProperties(): Promise<Property[]>;
  getPropertyByName(name: string): Promise<Property | undefined>;
  createProperty(property: InsertProperty): Promise<Property>;
  deleteProperty(id: number): Promise<void>;
  updatePropertySheetsTabId(id: number, tabId: number): Promise<void>;
  // User-property assignment methods
  getPropertiesForUser(userId: number): Promise<Property[]>;
  setUserProperties(userId: number, propertyIds: number[]): Promise<void>;
  getUserPropertyIds(userId: number): Promise<number[]>;
  // Cash transaction methods
  createCashTransaction(tx: InsertCashTransaction): Promise<CashTransaction>;
  getCashTransactionsByProperty(property: string): Promise<CashTransaction[]>;
  getAllCashTransactions(): Promise<CashTransaction[]>;
  getCashTransactionsByUser(userId: number): Promise<CashTransaction[]>;
  deleteCashTransaction(id: number): Promise<void>;
  getCashTransaction(id: number): Promise<CashTransaction | undefined>;
  getNextCashRecordNumber(property: string): Promise<number>;
  updateCashTransaction(id: number, data: any): Promise<CashTransaction | undefined>;
  updateCashTransactionSyncStatus(id: number, target: "drive" | "sheets", synced: boolean): Promise<void>;
  getCashBalanceByProperty(property: string): Promise<number>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    return db.select().from(users).where(eq(users.id, id)).get();
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return db.select().from(users).where(eq(users.username, username)).get();
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    return db.insert(users).values(insertUser).returning().get();
  }

  async getAllUsers(): Promise<User[]> {
    return db.select().from(users).all();
  }

  async deleteUser(id: number): Promise<void> {
    db.delete(users).where(eq(users.id, id)).run();
  }

  async updateUser(id: number, data: Partial<InsertUser>): Promise<User | undefined> {
    return db.update(users).set(data).where(eq(users.id, id)).returning().get();
  }

  async createInvoice(invoice: InsertInvoice): Promise<Invoice> {
    return db.insert(invoices).values(invoice).returning().get();
  }

  async getInvoicesByUser(userId: number): Promise<Invoice[]> {
    return db.select().from(invoices).where(eq(invoices.userId, userId)).orderBy(desc(invoices.createdAt)).all();
  }

  async getAllInvoices(): Promise<Invoice[]> {
    return db.select().from(invoices).orderBy(desc(invoices.createdAt)).all();
  }

  async getInvoice(id: number): Promise<Invoice | undefined> {
    return db.select().from(invoices).where(eq(invoices.id, id)).get();
  }

  async deleteInvoice(id: number): Promise<void> {
    db.delete(invoices).where(eq(invoices.id, id)).run();
  }

  async updateInvoice(id: number, data: any): Promise<Invoice | undefined> {
    return db.update(invoices).set(data).where(eq(invoices.id, id)).returning().get();
  }

  async getNextRecordNumber(property: string): Promise<number> {
    const result = sqlite.prepare("SELECT MAX(record_number) as maxNum FROM invoices WHERE property = ?").get(property) as any;
    return (result?.maxNum || 0) + 1;
  }

  async updateInvoiceSyncStatus(id: number, target: "drive" | "sheets", synced: boolean): Promise<void> {
    const val = synced ? 1 : 0;
    if (target === "drive") {
      db.update(invoices).set({ syncedToDrive: val }).where(eq(invoices.id, id)).run();
    } else {
      db.update(invoices).set({ syncedToSheets: val }).where(eq(invoices.id, id)).run();
    }
  }

  // ---- Sessions ----
  async createSession(token: string, userId: number, role: string): Promise<void> {
    db.insert(sessions).values({ token, userId, role, createdAt: new Date().toISOString() }).run();
  }

  async getSession(token: string): Promise<{ userId: number; role: string } | undefined> {
    const row = db.select().from(sessions).where(eq(sessions.token, token)).get();
    if (!row) return undefined;
    return { userId: row.userId, role: row.role };
  }

  async deleteSession(token: string): Promise<void> {
    db.delete(sessions).where(eq(sessions.token, token)).run();
  }

  // ---- Properties ----
  async getAllProperties(): Promise<Property[]> {
    return db.select().from(properties).all();
  }

  async getPropertyByName(name: string): Promise<Property | undefined> {
    return db.select().from(properties).where(eq(properties.name, name)).get();
  }

  async createProperty(property: InsertProperty): Promise<Property> {
    return db.insert(properties).values(property).returning().get();
  }

  async deleteProperty(id: number): Promise<void> {
    db.delete(properties).where(eq(properties.id, id)).run();
  }

  async updatePropertySheetsTabId(id: number, tabId: number): Promise<void> {
    db.update(properties).set({ sheetsTabId: tabId }).where(eq(properties.id, id)).run();
  }

  // ---- User-Property assignments ----
  async getPropertiesForUser(userId: number): Promise<Property[]> {
    const rows = db.select().from(userProperties).where(eq(userProperties.userId, userId)).all();
    const propertyIds = rows.map(r => r.propertyId);
    if (propertyIds.length === 0) return [];
    return db.select().from(properties).where(inArray(properties.id, propertyIds)).all();
  }

  async setUserProperties(userId: number, propertyIds: number[]): Promise<void> {
    db.delete(userProperties).where(eq(userProperties.userId, userId)).run();
    for (const propertyId of propertyIds) {
      db.insert(userProperties).values({ userId, propertyId }).run();
    }
  }

  async getUserPropertyIds(userId: number): Promise<number[]> {
    const rows = db.select().from(userProperties).where(eq(userProperties.userId, userId)).all();
    return rows.map(r => r.propertyId);
  }

  // ---- Cash Transactions ----
  async createCashTransaction(tx: InsertCashTransaction): Promise<CashTransaction> {
    return db.insert(cashTransactions).values(tx).returning().get();
  }
  async getCashTransactionsByProperty(property: string): Promise<CashTransaction[]> {
    return db.select().from(cashTransactions).where(eq(cashTransactions.property, property)).orderBy(desc(cashTransactions.id)).all();
  }
  async getAllCashTransactions(): Promise<CashTransaction[]> {
    return db.select().from(cashTransactions).orderBy(desc(cashTransactions.id)).all();
  }
  async getCashTransactionsByUser(userId: number): Promise<CashTransaction[]> {
    return db.select().from(cashTransactions).where(eq(cashTransactions.userId, userId)).orderBy(desc(cashTransactions.id)).all();
  }
  async deleteCashTransaction(id: number): Promise<void> {
    db.delete(cashTransactions).where(eq(cashTransactions.id, id)).run();
  }
  async getCashTransaction(id: number): Promise<CashTransaction | undefined> {
    return db.select().from(cashTransactions).where(eq(cashTransactions.id, id)).get();
  }
  async getNextCashRecordNumber(property: string): Promise<number> {
    const result = sqlite.prepare("SELECT MAX(record_number) as maxNum FROM cash_transactions WHERE property = ?").get(property) as any;
    return (result?.maxNum || 0) + 1;
  }
  async updateCashTransaction(id: number, data: any): Promise<CashTransaction | undefined> {
    return db.update(cashTransactions).set(data).where(eq(cashTransactions.id, id)).returning().get();
  }
  async updateCashTransactionSyncStatus(id: number, target: "drive" | "sheets", synced: boolean): Promise<void> {
    const val = synced ? 1 : 0;
    if (target === "drive") {
      db.update(cashTransactions).set({ syncedToDrive: val }).where(eq(cashTransactions.id, id)).run();
    } else {
      db.update(cashTransactions).set({ syncedToSheets: val }).where(eq(cashTransactions.id, id)).run();
    }
  }
  async getDailyReportSubscribers(): Promise<User[]> {
    return db.select().from(users).where(eq(users.dailyReport, 1)).all();
  }

  async getInvoicesByDate(date: string): Promise<Invoice[]> {
    return db.select().from(invoices).where(eq(invoices.purchaseDate, date)).all();
  }

  async getCashTransactionsByDate(date: string): Promise<CashTransaction[]> {
    return db.select().from(cashTransactions).where(eq(cashTransactions.date, date)).all();
  }

  // ---- CC Statements ----
  async createCcStatement(data: any): Promise<CcStatement> {
    return db.insert(ccStatements).values(data).returning().get();
  }
  async getCcStatement(id: number): Promise<CcStatement | undefined> {
    return db.select().from(ccStatements).where(eq(ccStatements.id, id)).get();
  }
  async getAllCcStatements(): Promise<CcStatement[]> {
    return db.select().from(ccStatements).orderBy(desc(ccStatements.id)).all();
  }
  async updateCcStatement(id: number, data: any): Promise<CcStatement | undefined> {
    return db.update(ccStatements).set(data).where(eq(ccStatements.id, id)).returning().get();
  }
  async getInvoicesByPropertyAndDateRange(property: string, startDate: string, endDate: string): Promise<Invoice[]> {
    return db.select().from(invoices)
      .where(
        and(
          eq(invoices.property, property),
          gte(invoices.purchaseDate, startDate),
          lte(invoices.purchaseDate, endDate)
        )
      )
      .orderBy(invoices.purchaseDate)
      .all();
  }

  // ---- Time Reports ----
  async createTimeReport(data: any): Promise<TimeReport> {
    return db.insert(timeReports).values(data).returning().get();
  }
  async getTimeReportsByUser(userId: number): Promise<TimeReport[]> {
    return db.select().from(timeReports).where(eq(timeReports.userId, userId)).orderBy(desc(timeReports.id)).all();
  }
  async getTimeReportsByDate(date: string): Promise<TimeReport[]> {
    return db.select().from(timeReports).where(eq(timeReports.date, date)).all();
  }
  // ---- Work Credits ----
  async createWorkCredit(data: any): Promise<WorkCredit> {
    return db.insert(workCredits).values(data).returning().get();
  }
  async getWorkCreditsByUser(userId: number): Promise<WorkCredit[]> {
    return db.select().from(workCredits).where(eq(workCredits.userId, userId)).orderBy(desc(workCredits.id)).all();
  }
  async getWorkCreditsByDate(date: string): Promise<WorkCredit[]> {
    return db.select().from(workCredits).where(eq(workCredits.date, date)).all();
  }
  async getWorkCreditsByProperty(property: string): Promise<WorkCredit[]> {
    return db.select().from(workCredits).where(eq(workCredits.property, property)).orderBy(desc(workCredits.id)).all();
  }
  async getAllWorkCredits(): Promise<WorkCredit[]> {
    return db.select().from(workCredits).orderBy(desc(workCredits.id)).all();
  }
  async deleteWorkCredit(id: number): Promise<void> {
    db.delete(workCredits).where(eq(workCredits.id, id)).run();
  }

  async getTimeReportsByUserAndDate(userId: number, date: string): Promise<TimeReport[]> {
    return db.select().from(timeReports).where(and(eq(timeReports.userId, userId), eq(timeReports.date, date))).all();
  }
  async getAllTimeReports(): Promise<TimeReport[]> {
    return db.select().from(timeReports).orderBy(desc(timeReports.id)).all();
  }
  async getTimeReportsByUserAndDateRange(userId: number, startDate: string, endDate: string): Promise<TimeReport[]> {
    return db.select().from(timeReports)
      .where(
        and(
          eq(timeReports.userId, userId),
          gte(timeReports.date, startDate),
          lte(timeReports.date, endDate)
        )
      )
      .orderBy(timeReports.date)
      .all();
  }
  async deleteTimeReport(id: number): Promise<void> {
    db.delete(timeReports).where(eq(timeReports.id, id)).run();
  }

  // ---- User Documents ----
  async createUserDocument(data: any): Promise<UserDocument> {
    return db.insert(userDocuments).values(data).returning().get();
  }
  async getUserDocuments(userId: number): Promise<UserDocument[]> {
    return db.select().from(userDocuments).where(eq(userDocuments.userId, userId)).all();
  }
  async deleteUserDocument(id: number): Promise<void> {
    db.delete(userDocuments).where(eq(userDocuments.id, id)).run();
  }

  // ---- Contractor Documents ----
  async createContractorDocument(data: any): Promise<ContractorDocument> {
    return db.insert(contractorDocuments).values(data).returning().get();
  }
  async getContractorDocumentsByUser(userId: number): Promise<ContractorDocument[]> {
    return db.select().from(contractorDocuments).where(eq(contractorDocuments.submittedByUserId, userId)).orderBy(desc(contractorDocuments.id)).all();
  }
  async getAllContractorDocuments(): Promise<ContractorDocument[]> {
    return db.select().from(contractorDocuments).orderBy(desc(contractorDocuments.id)).all();
  }
  async getContractorDocument(id: number): Promise<ContractorDocument | undefined> {
    return db.select().from(contractorDocuments).where(eq(contractorDocuments.id, id)).get();
  }
  async deleteContractorDocument(id: number): Promise<void> {
    db.delete(contractorDocuments).where(eq(contractorDocuments.id, id)).run();
  }

  async getCashBalanceByProperty(property: string): Promise<number> {
    const rows = db.select().from(cashTransactions).where(eq(cashTransactions.property, property)).all();
    let balance = 0;
    for (const row of rows) {
      const amt = parseFloat(row.amount) || 0;
      if (row.type === "income") balance += amt;
      else if (row.type === "spent") balance -= amt;
    }
    return balance;
  }
}

export const storage = new DatabaseStorage();
