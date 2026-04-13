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
  role: text("role").notNull().default("manager"), // super_admin, admin, manager, contractor
  email: text("email"),
  dailyReport: integer("daily_report").default(0),
  statementReports: integer("statement_reports").default(0),
  firstName: text("first_name"),
  lastName: text("last_name"),
  baseRate: text("base_rate"), // hourly rate at home property
  offSiteRate: text("off_site_rate"),
  homeProperty: text("home_property"),
  allowOffSite: integer("allow_off_site").default(0),
  mileageRate: text("mileage_rate").default("0.50"),
  allowSpecialTerms: integer("allow_special_terms").default(0),
  specialTermsAmount: text("special_terms_amount"),
  w9OrW4: text("w9_or_w4"), // "w9" only
  docsComplete: integer("docs_complete").default(0),
  mustChangePassword: integer("must_change_password").default(0),
  dailyTimeReport: integer("daily_time_report").default(0),
  dailyTransactionReport: integer("daily_transaction_report").default(0),
  reconciliationReport: integer("reconciliation_report").default(0),
  requireFinancialConfirm: integer("require_financial_confirm").default(0),
  allowPastDates: integer("allow_past_dates").default(0),
  receiveTransactionEmails: integer("receive_transaction_emails").default(0),
  allowWorkCredits: integer("allow_work_credits").default(0),
  workCreditReport: integer("work_credit_report").default(0),
});

export const workCredits = sqliteTable("work_credits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  property: text("property").notNull(),
  date: text("date").notNull(),
  tenantFirstName: text("tenant_first_name").notNull(),
  tenantLastName: text("tenant_last_name").notNull(),
  lotOrUnit: text("lot_or_unit").notNull(),
  workDescriptions: text("work_descriptions").notNull(), // JSON array of strings
  creditType: text("credit_type").notNull(), // 'fixed' or 'hourly'
  fixedAmount: text("fixed_amount"), // for fixed type
  hoursWorked: text("hours_worked"), // for hourly type (decimal)
  hourlyRate: text("hourly_rate"), // for hourly type
  timeBlocks: text("time_blocks"), // JSON array of {start, end} for hourly
  totalAmount: text("total_amount").notNull(),
  syncedToSheets: integer("synced_to_sheets").default(0),
  createdAt: text("created_at").notNull(),
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

// ---- CC Statement Reconciliation ----
export const ccStatements = sqliteTable("cc_statements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  property: text("property").notNull(),
  ccLastDigits: text("cc_last_digits").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  filePath: text("file_path").notNull(),
  parsedData: text("parsed_data"), // JSON array of {date, description, amount}
  reportHtml: text("report_html"),
  matched: integer("matched").default(0),
  unmatched: integer("unmatched").default(0),
  total: integer("total").default(0),
  uploadedBy: integer("uploaded_by").notNull(),
  createdAt: text("created_at").notNull(),
});

export type CcStatement = typeof ccStatements.$inferSelect;

// ---- Time Reports ----
export const timeReports = sqliteTable("time_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  property: text("property").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD
  startTime: text("start_time").notNull(), // HH:MM (first block start, backward compat)
  endTime: text("end_time").notNull(), // HH:MM (last block end, backward compat)
  timeBlocks: text("time_blocks"), // JSON array of {start, end} for split shifts
  accomplishments: text("accomplishments").notNull(), // JSON array of strings
  miles: text("miles"), // number as string
  mileageAmount: text("mileage_amount"), // calculated: miles * rate
  specialTerms: integer("special_terms").default(0),
  specialTermsAmount: text("special_terms_amount"),
  notes: text("notes"),
  syncedToSheets: integer("synced_to_sheets").default(0),
  createdAt: text("created_at").notNull(),
});

export type TimeReport = typeof timeReports.$inferSelect;

// ---- User Documents ----
export const userDocuments = sqliteTable("user_documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  docType: text("doc_type").notNull(), // "photo_id", "banking", "w9"
  filePath: text("file_path"),
  bankName: text("bank_name"),
  routingNumber: text("routing_number"),
  accountNumber: text("account_number"),
  createdAt: text("created_at").notNull(),
});

export type UserDocument = typeof userDocuments.$inferSelect;

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
export type WorkCredit = typeof workCredits.$inferSelect;
