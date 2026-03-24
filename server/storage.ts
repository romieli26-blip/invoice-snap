import { type User, type InsertUser, type Invoice, type InsertInvoice, type Property, type InsertProperty, users, invoices, properties } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc } from "drizzle-orm";

const sqlite = new Database("data.db");
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
  updateInvoiceSyncStatus(id: number, target: "drive" | "sheets", synced: boolean): Promise<void>;
  // Property methods
  getAllProperties(): Promise<Property[]>;
  getPropertyByName(name: string): Promise<Property | undefined>;
  createProperty(property: InsertProperty): Promise<Property>;
  deleteProperty(id: number): Promise<void>;
  updatePropertySheetsTabId(id: number, tabId: number): Promise<void>;
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

  async updateInvoiceSyncStatus(id: number, target: "drive" | "sheets", synced: boolean): Promise<void> {
    const val = synced ? 1 : 0;
    if (target === "drive") {
      db.update(invoices).set({ syncedToDrive: val }).where(eq(invoices.id, id)).run();
    } else {
      db.update(invoices).set({ syncedToSheets: val }).where(eq(invoices.id, id)).run();
    }
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
}

export const storage = new DatabaseStorage();
