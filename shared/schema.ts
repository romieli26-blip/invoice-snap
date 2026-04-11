import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ---- Default properties (used to seed DB on first run) ----
export const DEFAULT_PROPERTIES = [
  "Bonifay",
  "Trails End",
  "Sunchase",
  "MSE",
  "Gardenia Hill",
  "Cedar Ridge",
  "Pop's Grill",
  "Magnolia Farms",
  "Testing Property",
] as const;

// ---- Tables ----
export const properties = sqliteTable("properties", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  sheetsTabId: integer("sheets_tab_id"), // Google Sheets worksheet ID for this property
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull().default("manager"), // "admin" or "manager"
});

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userId: integer("user_id").notNull(),
  role: text("role").notNull(),
  createdAt: text("created_at").notNull(),
});

export const userProperties = sqliteTable("user_properties", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  propertyId: integer("property_id").notNull(),
});

export const invoices = sqliteTable("invoices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  photoPath: text("photo_path").notNull(),
  property: text("property").notNull(),
  purchaseDate: text("purchase_date").notNull(),
  description: text("description").notNull(),
  purpose: text("purpose").notNull(),
  amount: text("amount").notNull(),
  boughtBy: text("bought_by").notNull(),
  paymentMethod: text("payment_method").notNull(), // "cash" or "cc"
  lastFourDigits: text("last_four_digits"),
  recordNumber: integer("record_number"),
  rentManagerIssue: text("rent_manager_issue"),
  photoPaths: text("photo_paths"), // JSON array of photo paths for multi-photo receipts
  receiptType: text("receipt_type").default("expense"), // "expense" or "refund"
  editHistory: text("edit_history"), // JSON array of edits: [{by, at, changes}]
  syncedToDrive: integer("synced_to_drive").notNull().default(0),
  syncedToSheets: integer("synced_to_sheets").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

// ---- Cash Transactions ----
export const cashTransactions = sqliteTable("cash_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  property: text("property").notNull(),
  type: text("type").notNull(), // "income" or "spent"
  category: text("category").notNull(), // income: rental_income, washer, dryer, vending, store_items, other. spent: bank_deposit, item_purchased, contractor_pay, other
  amount: text("amount").notNull(),
  date: text("date").notNull(),
  // Income-specific fields
  unitLotNumber: text("unit_lot_number"),
  tenantName: text("tenant_name"),
  // Spent-specific fields
  bankName: text("bank_name"),
  description: text("description"),
  // Photo (for deposit slips etc)
  photoPath: text("photo_path"),
  photoPaths: text("photo_paths"),
  // Record tracking
  recordNumber: integer("record_number"),
  editHistory: text("edit_history"), // JSON array of edits: [{by, at, changes}]
  syncedToSheets: integer("synced_to_sheets").notNull().default(0),
  syncedToDrive: integer("synced_to_drive").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const insertCashTransactionSchema = createInsertSchema(cashTransactions).omit({ id: true });
export type CashTransaction = typeof cashTransactions.$inferSelect;
export type InsertCashTransaction = z.infer<typeof insertCashTransactionSchema>;

export const insertUserSchema = createInsertSchema(users).omit({ id: true });
export const insertInvoiceSchema = createInsertSchema(invoices).omit({ id: true });
export const insertPropertySchema = createInsertSchema(properties).omit({ id: true });

export const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

export const invoiceFormSchema = z.object({
  property: z.string().min(1, "Property is required"),
  purchaseDate: z.string().min(1, "Date is required"),
  description: z.string().min(1, "Description is required"),
  purpose: z.string().min(1, "Purpose / use is required"),
  amount: z.string().min(1, "Amount is required"),
  boughtBy: z.string().min(1, "Bought by is required"),
  paymentMethod: z.enum(["cash", "cc"]),
  lastFourDigits: z.string().optional(),
  rentManagerIssue: z.string().optional(),
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoices.$inferSelect;
export type Property = typeof properties.$inferSelect;
export type InsertProperty = z.infer<typeof insertPropertySchema>;
