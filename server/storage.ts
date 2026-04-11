import { type User, type InsertUser, type Invoice, type InsertInvoice, type Property, type InsertProperty, type CashTransaction, type InsertCashTransaction, users, invoices, properties, sessions, userProperties, cashTransactions } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, inArray } from "drizzle-orm";

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
  async updateCashTransactionSyncStatus(id: number, target: "drive" | "sheets", synced: boolean): Promise<void> {
    const val = synced ? 1 : 0;
    if (target === "drive") {
      db.update(cashTransactions).set({ syncedToDrive: val }).where(eq(cashTransactions.id, id)).run();
    } else {
      db.update(cashTransactions).set({ syncedToSheets: val }).where(eq(cashTransactions.id, id)).run();
    }
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
