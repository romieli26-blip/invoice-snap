# Jetsetter Reporting - Database Reference

> **Purpose.** Every table, every column, why it's there, and how the tables
> relate. If ARCHITECTURE.md is the map, this is the census.

**Last updated:** September 2026
**Schema definition:** `shared/schema.ts` (Drizzle ORM)
**Database engine:** SQLite (better-sqlite3) - single file at
`$DATA_DIR/data.db` on the Railway persistent volume.

---

## 1. Why SQLite

The dataset is small (rows on the order of thousands per table, not millions),
writes are moderate (dozens per day, peaks maybe hundreds), and there's a
single application server. SQLite handles this trivially, backs up as one
file copy, needs no separate service, and Drizzle ORM's SQLite dialect
supports everything the app needs. If you ever hit 10 GB of DB rows or 100+
concurrent writers, migrate to Postgres. Not before.

## 2. Migrations

There are no formal migration files. Schema changes land as:
- A change in `shared/schema.ts` (the Drizzle definition), and
- A defensive `ALTER TABLE ... ADD COLUMN` at server boot in `server/storage.ts`
  wrapped in try/catch so it's idempotent.

This keeps the schema story simple: any developer can read the boot section
of `storage.ts` and see every column that's been added over time.

## 3. Tables at a glance

| Table                     | Rows scale | Purpose |
| ------------------------- | ---------- | ------- |
| `properties`              | ~10        | The real-estate properties |
| `users`                   | ~30        | Everyone who logs in |
| `user_properties`         | ~40        | Which properties each manager covers |
| `sessions`                | ~30        | Active bearer tokens |
| `app_settings`            | ~5         | Runtime key/value store (Google refresh token, health status) |
| `invoices`                | 1,000s     | Credit-card receipts |
| `cash_transactions`       | 1,000s     | Cash in + out |
| `check_transactions`      | 100s       | Incoming checks with deposit lifecycle |
| `time_reports`            | 100s       | Hourly work reports |
| `work_credits`            | 10s        | Fixed / hourly bonus tasks |
| `flat_rate_assignments`   | 10s        | One-off fixed-amount tasks |
| `user_documents`          | ~90        | Per-user ID / W-9 / banking uploads |
| `contractor_documents`    | ~50        | Same but for contractors managed by PMs |
| `cc_statements`           | 10s        | Uploaded CC statements + reconciliation report |

## 4. Relationships

```
properties        (name)
  ↑
  ├─ user_properties (userId, propertyId)   ─→   users
  ├─ invoices (property text ref by name)
  ├─ cash_transactions (property text ref by name)
  ├─ check_transactions (property text ref by name)
  ├─ time_reports (property text ref by name)
  ├─ work_credits (property text ref by name)
  └─ flat_rate_assignments (property text ref by name)

users
  ├─ sessions (userId)
  ├─ user_properties (userId)
  ├─ user_documents (userId)
  ├─ contractor_documents (submittedByUserId)
  ├─ invoices, cash_transactions, check_transactions,
  │  time_reports, work_credits, flat_rate_assignments  (userId)
  └─ cc_statements (uploadedBy)
```

**Deliberate design note:** relations to `properties` are by NAME (a text
column), not by foreign key ID. This is intentional. Properties rarely change
name, and dropping the FK simplifies the sheet-sync path where the property
name is what gets written into the sheet's Property column anyway. Trade-off:
renaming a property requires a small backfill script.

## 5. Table-by-table walkthrough

### 5.1 `properties`

The list of properties the company manages. Seeded on first boot with
`DEFAULT_PROPERTIES` (Bonifay, Trails End, Sunchase, MSE, Gardenia Hill,
Cedar Ridge, Pop's Grill, Magnolia Farms, Testing Property).

Key columns:
- `name` - unique. This is the foreign key used elsewhere (as text).
- `code` - 2-4 letter prefix on receipt IDs (`TE`, `BO`, `SU`, ...).
- `sheetsTabId` - the numeric worksheet ID inside the CC Invoices Google
  Sheet where this property's rows live.
- `marketingUrl`, `masterSheetUrl`, `vendingUrl`, `meterReadingUrl` - the
  four per-property quick-link URLs surfaced on the dashboard.

### 5.2 `users`

Every account that logs in. Includes managers, contractors, admins, and
super-admins.

Highlights:
- `role` - one of `super_admin`, `admin`, `manager`, `contractor`.
- `password` - `crypto.scrypt` hash, salt embedded.
- `homeProperty` - the property this user is primarily assigned to
  (dropdown default on forms, some cron dispatches).
- `positions` - JSON array of `{name, rate}` for users who work multiple
  positions. When set, the Work Report form prompts them to pick one.
- `allowOffSite`, `allowSpecialTerms`, `allowPastDates`, `allowWorkCredits`,
  `allowContractorDocs`, `allowCreatingContractors`, `allowMiles`,
  `allowFlatRate` - fine-grained per-user permission flags. All default 0.
- `showWorkReport`, `showMyDocuments`, `showWorkCredit`, `showMyContractors`
  - which dashboard buttons render (admin escape hatch on top of the
  role default).
- `dailyReport`, `dailyTimeReport`, `dailyTransactionReport`,
  `reconciliationReport`, `receiveTransactionEmails`, `workCreditReport`,
  `documentUploadReport`, `docReminderEnabled`, `dailyReminderEnabled` -
  per-user email subscription flags.
- `docReminderDays` - how often the doc-reminder cron nags this user.
- `mustChangePassword` - set to 1 after admin-triggered password reset;
  cleared on next self-service change.
- `archived` - 1 means the user is disabled but their historic rows stay.
- `lastDailyReminderAt` - ISO timestamp of the most recent successful
  7pm reminder to this user (audit trail visible in the Admin Panel).

**Contractors specifically** (`role = "contractor"`) are created by a PM
via the PM Contractors flow, or by an admin. They can log in and submit
their own work reports and receipts.

### 5.3 `user_properties`

Join table. Each row says "this user has visibility on this property."

- Managers see rows only for properties they're in this table for.
- Admins ignore this table (see everything).
- On user create, the user's `homeProperty` is automatically added here.

### 5.4 `sessions`

Auth token store.

- `token` - the bearer token the client sends on every request.
- `userId` - who it belongs to.
- `role` - denormalised for quick reads without joining `users`.
- `createdAt` - never expires currently. If needed later, a cron could
  prune stale rows.

### 5.5 `app_settings`

Simple key/value store for runtime-mutable config that must survive
redeploys.

Currently used for:
- `google_refresh_token` - the current Google OAuth refresh token.
  Preferred over the env-var version so the in-app Reconnect Google
  button can rotate it without a Railway redeploy.
- `google_refresh_token_saved_at` - timestamp of last save.
- `google_last_known_status` - `ok` or `broken`. Used by the health-check
  cron to detect transitions and email once, not repeatedly.
- `google_last_alert_at`, `google_last_health_check_at` - audit stamps.

### 5.6 `invoices` (Credit-card receipts)

The biggest table by row count. Every CC receipt PMs photograph lives here.

- `photoPath` - relative path under `/data/uploads/`.
- `photoPaths` - JSON array for multi-photo receipts (uncommon but supported).
- `property`, `amount`, `purchaseDate`, `description`, `purpose`, `boughtBy`
  - the fields on the submission form.
- `paymentMethod` - always "cc" in practice (historically also "cash",
  now separated into `cash_transactions`).
- `lastFourDigits` - 4 or 5 digits of the card used.
- `recordNumber` - internal auto-increment counter (legacy - kept for
  order preservation).
- `propertyCode` - the customer-facing receipt ID (e.g. `TE-42`). This
  is what's written to Sheets, embedded in the Drive filename, and shown
  on the dashboard.
- `receiptType` - "expense" or "refund" (refunds are negative-signed).
- `editHistory` - JSON array of edit audit entries `{by, at, changes[]}`.
- `syncedToDrive`, `syncedToSheets` - background sync markers.

### 5.7 `cash_transactions`

Cash flow, income OR spent.

- `type` - `"income"` or `"spent"`.
- `category` - depends on type. Income: `rental_income`, `washer`, `dryer`,
  `vending`, `store_items`, `eod_cash_on_hand`, `other`. Spent:
  `bank_deposit`, `item_purchased`, `contractor_pay`, `cc_tips`, `other`.
- `unitLotNumber`, `tenantName` - present for rental_income.
- `bankName` - present for bank_deposit.
- `payerName` - reused for two things:
  - When category is `check` (legacy - now in `check_transactions`) or
    `cc_tips`, it's the payer / server name.
  - For `cc_tips`, this is the server / staff member the tips are paid to.
    The server writes "Tips - <name>" into the Sheets Description column
    for readability without adding a new sheet header.

### 5.8 `check_transactions`

Incoming checks. Split from `cash_transactions` because checks have a
distinct deposit lifecycle.

- `deposited` - 0 while the check is in a PM's drawer; 1 after they mark it
  deposited.
- `depositedAt`, `depositPhotoPath` - captured at the moment the PM taps
  "Mark Deposited" and provides a slip photo.

Checks-on-Hand dashboard card sums `deposited = 0` rows.

### 5.9 `time_reports`

Hourly work reports. One row per submission; a submission can contain
multiple `timeBlocks` (split shift) as a JSON array of `{start, end}`.

- `date` - YYYY-MM-DD, anchored to Central Time (`America/Chicago`).
- `startTime`, `endTime` - HH:MM. First-block start and last-block end
  respectively (kept as flat columns for backward compat).
- `timeBlocks` - JSON authoritative list.
- `accomplishments` - JSON array of strings.
- `miles`, `mileageAmount` - optional; only for users with `allowMiles=1`.
- `specialTerms`, `specialTermsAmount` - one-off bonuses.
- `positionName`, `positionRate` - which position the user chose (when
  `users.positions` is set).

### 5.10 `work_credits`

Fixed or hourly one-off pay tasks (mail organising, tenant assistance
bonuses, etc.). Similar shape to time reports but with a `creditType`
of `fixed` or `hourly`.

### 5.11 `flat_rate_assignments`

Even simpler than work credits: a single fixed-dollar task associated
with a property and date. Used for admins to add ad-hoc payouts.

### 5.12 `user_documents`

Per-user compliance docs.

- `docType` - `photo_id`, `banking`, `w9`.
- `bankName`, `routingNumber`, `accountNumber` - only for `docType=banking`.
- `filePath` - upload under `/data/uploads/`.

Every user is expected to have all three. The doc-reminder cron nags
users who don't after `docReminderDays` without submission.

### 5.13 `contractor_documents`

Same shape as `user_documents` but represents a contractor's docs
uploaded on their behalf by a PM. `contractorFirstName`, `contractorLastName`,
`contractorEmail`, `contractorPhone` identify the contractor (they may
or may not have a corresponding row in `users`).

### 5.14 `cc_statements`

Uploaded CC statement PDFs plus their reconciliation report.

- `filePath` - path to the uploaded PDF.
- `parsedData` - JSON of transactions extracted from the PDF via `pdf-parse`.
- `reportHtml` - the rendered reconciliation report shown in the UI.
- `matched`, `unmatched`, `total` - reconciliation counts.

## 6. Photo storage

Photos are NOT stored in the DB. Only `photoPath` strings live in rows.
The files themselves are on the Railway volume under `/data/uploads/`.

Consequences:
- Backing up the DB alone is insufficient - `uploads/` must be backed
  up separately (or Drive treated as the durable copy - it already is).
- File size on disk grows with usage. Currently around 458 MB.
- Deleting a DB row does NOT delete the file on disk. The delete
  endpoint issues both a DB delete and a `fs.unlink`.

## 7. Running-balance computation

The Cash Transactions Google Sheet has a column L "Balance" that shows a
per-property running total. It is NOT a spreadsheet formula. It's
computed by the server at write time (`getCashBalanceByProperty`) and
rewritten during Fix All.

Never edit column L manually in the sheet - the next resync will
overwrite it.

## 8. Sync markers vs. actual sheet state

Two levels of truth-checking exist:

**Shallow:** `syncedToSheets` = 1 means "I called `appendSheetRow` and it
returned OK." Fast, but doesn't guarantee the row is actually there
(quota errors and race conditions can lie).

**Deep:** `GET /api/admin/sync-status?deep=1` actually reads back the
sheet row counts per property and compares to DB counts. Slow (one API
call per property), but authoritative. Use this after Fix All to be sure.

## 9. Backup and recovery

**Automatic:** Railway takes daily snapshots of the persistent volume,
retained for 7 days. To restore, use Railway's volume snapshot UI. This
brings back both `data.db` and `uploads/`.

**Manual dump (recommended addition):**

```bash
sqlite3 /data/data.db ".backup /data/backups/$(date +%F).db"
tar czf /data/backups/$(date +%F)-uploads.tgz /data/uploads
```

Not currently automated. Adding a nightly backup-to-Drive job is on the
roadmap (see OPERATIONS.md).

## 10. Query patterns you'll see in the code

**Everything goes through Drizzle:**
```ts
await db.select().from(invoices).where(eq(invoices.userId, u.id));
await db.update(users).set({ email: newEmail }).where(eq(users.id, id));
await db.insert(cashTransactions).values({...});
```

**Never use raw SQL with camelCase / snake_case interpolation.** The DB
columns are snake_case (SQLite convention) but Drizzle's TypeScript
handles the mapping. Raw SQL bypasses that and can cause silent
key-not-found bugs. Historical note: an early version of this app had
raw SQL sprinkled through several places and it took two weeks to hunt
down all the snake_case leaks.

## 11. Adding a new column - checklist

1. Add the column to the correct `sqliteTable` in `shared/schema.ts`.
2. Add a defensive `ALTER TABLE ... ADD COLUMN` in `server/storage.ts`
   inside a `try {} catch {}`.
3. If the column is filled at creation time, update the `insert` path.
4. If it needs to flow to Sheets, update BOTH:
   - The per-row `appendSheetRow` call in the create endpoint.
   - The Fix All rebuild path in `POST /api/admin/resync-sheets`.
5. If it needs to appear in the dashboard detail modal, add it to the
   `lines` array in `history.tsx`.
6. If admins edit it, add the field to the edit dialog in `admin.tsx`
   or `history.tsx`, plus the PUT endpoint's body destructure.

Missing any one of these usually surfaces as "why does the sheet not
show my new field after resync." Check the rebuild path first.

## 12. Deleting a user or property safely

Never `DELETE FROM users WHERE ...` directly. Use the app's archive
flow (`POST /api/users/:id/archive`) which:
- Sets `archived = 1`.
- Kicks all their `sessions` rows.
- Hides their tab on the Time Reports sheet (doesn't delete - preserves
  audit trail).
- Leaves all their historic rows in `invoices`, `cash_transactions`, etc.
  untouched so financial history stays intact.

Deleting a property is similarly delicate - the property name is
referenced by dozens of rows across many tables. Currently there's no
"delete property" flow. If you need one, add a merge / rename utility.
