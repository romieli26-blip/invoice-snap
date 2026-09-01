# Jetsetter Reporting - System Architecture

> **Purpose of this document.** A single reference a new developer (or auditor,
> or manager) can read in 20 minutes to understand what the app is, where every
> piece lives, and how the pieces talk to each other. Written for someone who
> can read code but has never seen this codebase.

**Last updated:** September 2026 (kept in sync with `main` branch)
**Author of the app:** external contractor engaged by Jetsetter Capital LLC.
**Audience of this doc:** any future developer, admin, or auditor.

---

## 1. What the app is, in one sentence

A private, mobile-first web application (PWA) that Jetsetter Capital property
managers use to log every credit-card receipt, cash transaction, check, work
report, and personal / contractor document, with automatic synchronisation to
Google Sheets and Google Drive so accountants and admins can audit any dollar
end-to-end.

## 2. What it is NOT

- Not an app-store app (no Apple / Google review, no fees).
- Not a SaaS product with multiple customers - it serves one company.
- Not a data warehouse - Google Sheets is the durable spreadsheet layer;
  Drive is the durable photo layer; the app's SQLite DB is authoritative
  for computation but Sheets + Drive are what an accountant will audit.
- Not a payment processor - it records that money moved, it doesn't move it.

## 3. High-level component diagram

```
                        ┌────────────────────────────┐
                        │      Property Manager      │
                        │  (iPhone / Android PWA)    │
                        │  Kay, Annette, Megan, ...  │
                        └──────────────┬─────────────┘
                                       │  HTTPS (public)
                                       ▼
     ┌──────────────────────────────────────────────────────────────┐
     │  Railway VM   invoice-snap-production.up.railway.app         │
     │  (San Jose, US West)                                         │
     │                                                              │
     │  ┌────────────────────────────────────────────────────────┐  │
     │  │  Node.js / Express server   (server/index.ts + routes) │  │
     │  │  - 101 REST endpoints                                  │  │
     │  │  - Session auth via bearer token                       │  │
     │  │  - 5 node-cron schedulers                              │  │
     │  │  - Serves the compiled React SPA in production         │  │
     │  └───────────┬────────────────────────────────────────────┘  │
     │              │                                               │
     │              │  reads / writes                               │
     │              ▼                                               │
     │  ┌────────────────────────────────────────────────────────┐  │
     │  │  SQLite database   /data/data.db  (persistent volume)  │  │
     │  │  Drizzle ORM on better-sqlite3                         │  │
     │  │  - 14 tables (users, invoices, cash, check, ...)       │  │
     │  │  - See DATABASE.md for schema walkthrough              │  │
     │  └────────────────────────────────────────────────────────┘  │
     │                                                              │
     │  ┌────────────────────────────────────────────────────────┐  │
     │  │  Persistent volume  /data                              │  │
     │  │  - data.db          (SQLite)                           │  │
     │  │  - uploads/         (receipt / doc photos)             │  │
     │  │  - sheets-config.json, check-sheets-config.json        │  │
     │  │  - reminder-heartbeat.json                             │  │
     │  │  - jetsetter-tutorial-cache.mp4                        │  │
     │  └────────────────────────────────────────────────────────┘  │
     │                                                              │
     └──────────────────┬───────────────────────────────────────────┘
                        │  Google APIs (Sheets v4, Drive v3, Gmail v1)
                        │  OAuth2 refresh-token flow
                        ▼
     ┌──────────────────────────────────────────────────────────────┐
     │  Google Workspace ecosystem                                  │
     │  Account: jetsetterinvoices1@gmail.com (personal Gmail)      │
     │                                                              │
     │  ┌───── Sheets ─────┐   ┌───── Drive ─────┐   ┌── Gmail ──┐  │
     │  │ CC Invoices      │   │ Root: Receipts  │   │ Sends     │  │
     │  │ Cash Trans       │   │  ├─ CC Receipts │   │ transactn │  │
     │  │ Check Trans      │   │  ├─ Cash Rcpts  │   │ alerts +  │  │
     │  │ Time Reports     │   │  ├─ Checks      │   │ password  │  │
     │  │                  │   │  ├─ Docs        │   │ resets +  │  │
     │  │                  │   │  └─ Contractor  │   │ daily rpt │  │
     │  └──────────────────┘   └─────────────────┘   └───────────┘  │
     └──────────────────────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────────────────────┐
     │  GitHub  (github.com/romieli26-blip/invoice-snap)            │
     │  - Source of truth for code                                  │
     │  - Push to main → Railway auto-deploys                       │
     └──────────────────────────────────────────────────────────────┘
```

## 4. Stack summary

| Layer                | Technology                       | Notes |
| -------------------- | -------------------------------- | ----- |
| Frontend (SPA)       | TypeScript + React 18 + Vite     | Compiled to static assets at build time |
| Frontend UI kit      | shadcn/ui on Radix + Tailwind    | Every input, dialog, dropdown |
| Frontend routing     | wouter with **hash routing**     | URLs look like `/#/admin`, `/#/cash` |
| Frontend state       | React Query (TanStack)           | Every API call goes through it |
| Backend runtime      | Node.js 22 + Express             | 4 GB RAM allocated on Railway Pro |
| Backend language     | TypeScript, run directly via tsx | No separate build for the server |
| Backend ORM          | Drizzle ORM on better-sqlite3    | Schema at `shared/schema.ts` |
| Database             | SQLite (single file)             | Simplicity > distributed correctness for this scale |
| Persistent storage   | Railway attached volume          | Mounted at `/data`, survives redeploys |
| Auth                 | Custom bearer token (`sessions` table) | No third-party session provider |
| Password hashing     | Node.js `crypto.scrypt`          | Salt per user, stored in `users.password` |
| External integration | Google Workspace                 | OAuth2 refresh token, single account owner |
| PDF generation       | ReportLab (Python) - offline     | Manuals generated locally, uploaded to Drive |
| Scheduler            | node-cron (in-process)           | 5 recurring jobs |
| Deployment platform  | Railway Pro plan                 | Auto-deploys from GitHub main |
| Source control       | GitHub private repo              | `romieli26-blip/invoice-snap` |

## 5. The five kinds of data flowing through the system

The whole app is basically five near-parallel flows that share auth, UI, and
sync patterns. If you understand one, you understand all five with variations.

### 5.1 Credit-card receipt (CC Invoice)

**Trigger:** PM taps "New Credit Card Receipt" and photographs a receipt.

1. Client uploads photo bytes → `POST /api/upload` → server saves to
   `/data/uploads/<uuid>.<ext>`, returns the path.
2. Client submits form data → `POST /api/invoices` including that photo path.
3. Server inserts row into `invoices`, computes `propertyCode` (e.g. `TE-42`).
4. Server responds `200 OK` immediately.
5. Background (via `setImmediate`):
   - Uploads photo to Google Drive under the property's `CC Receipts/<prop>` folder.
   - Appends a row to the CC Invoices Google Sheet, correct property tab.
   - Sends transaction-notification emails to subscribed admins.
6. If Google API is down, `syncedToDrive` / `syncedToSheets` stay 0. The Admin
   Panel's Sheet Sync Status detects the drift and offers a "Fix All" retry.

### 5.2 Cash transaction (income or spent)

Same shape as 5.1 with these differences:
- Table is `cash_transactions`.
- No CC digits; instead has `category`, `tenantName`, `bankName`, `payerName`.
- Server writes 12-column rows to the Cash Transactions Sheet with a running
  balance in column L (recomputed from DB during Fix All).
- For **CC Tips** category, the server enriches the sheet's Description
  column with `Tips - <server name>`. See DATABASE.md for the reasoning.

### 5.3 Check transaction (incoming check with deposit lifecycle)

- Table is `check_transactions`.
- Adds `deposited` flag + `depositedAt` timestamp + `depositPhotoPath`.
- The Checks-on-Hand dashboard card sums undeposited checks.
- When a check is marked deposited, another photo is captured and the row
  is re-synced to the sheet.

### 5.4 Work report (time tracking)

- Table is `time_reports`. One or more `timeBlocks` per report.
- Rate resolution: position rate (multi-rate users) → off-site rate (if the
  property is not their home base) → base rate.
- Synced to the **Time Reports** spreadsheet, one tab per user, and a
  summary "Daily Reporting" doc/email daily at midnight ET.
- Same-day rule: users can only submit for today in Central Time, unless
  the admin has flipped their `allowPastDates` flag.

### 5.5 Work credit and flat-rate assignment (fixed / hourly pay tasks)

- Two tables (`work_credits`, `flat_rate_assignments`) for one-off tasks
  that contribute to payroll independent of time-based hours.
- Same sync pattern to Sheets.

### 5.6 Documents (personal + contractor)

Two similar flows:
- `user_documents` (`docType` = photo_id, banking, w9). Every PM must
  complete their three on install day.
- `contractor_documents` (same three types, tied to a contractor identity
  a PM created on their behalf).

Documents upload to Drive under `Documents/<user>/`, no Sheet write.

## 6. Authentication and authorisation

- **Sign-in:** `POST /api/login` with username/password. Server verifies
  scrypt hash, inserts a row in `sessions`, returns the token in the JSON
  response. The client stores it in `localStorage["auth_token"]`.
- **Every subsequent request** carries `Authorization: Bearer <token>`.
  The server reads the `sessions` row, joins to `users`, and attaches the
  session object to the request.
- **Role check:** `session.role` is one of `super_admin`, `admin`,
  `manager`, `contractor`. Endpoints call `requireAuth` for any logged-in
  user or `requireAdmin` for admin+.
- **Property scoping:** managers can only see rows tied to the properties
  in their `user_properties` list. Server enforces this on every read.
- **Password reset:** self-service via `POST /api/forgot-password`.
  Server generates a temporary password, sets `mustChangePassword=1`,
  emails the user. On next login they're forced to change it.
- **Impersonation:** `POST /api/admin/impersonate/:id` lets a super_admin
  log in as any other user for troubleshooting. Session is marked so
  the impersonated user can still be identified in audit logs.
- **Archive:** `POST /api/users/:id/archive` sets `archived=1`, blocks
  login, but preserves every row of history. Unarchive rotates password
  and emails the user.

## 7. Google integration (the fragile-but-critical part)

The app talks to Google as `jetsetterinvoices1@gmail.com` via a single
OAuth2 client (Client ID `766687828943-dvb1...`). One refresh token is
stored in `app_settings.google_refresh_token` (falls back to the
`GOOGLE_REFRESH_TOKEN` env var if the DB row is missing).

**Why it breaks every 7 days:** the OAuth consent screen is in
**External + Testing** mode with `jetsetterinvoices1@gmail.com` as a
test user. Google intentionally invalidates refresh tokens after 7 days
in this mode. Fully fixed only by migrating to a Google Workspace
account inside the Jetsetter Capital org (large project, see roadmap).

**Recovery flow (already shipped):**
1. Health-check cron (every 30 min) hits `/api/admin/google-diagnose`.
2. If it detects `invalid_grant`, sends `[Jetsetter Reporting] Google sync is broken` email to Ben.
3. Ben clicks **Reconnect Google** in the admin panel.
4. Browser redirects to Google consent, Ben signs in as
   `jetsetterinvoices1@gmail.com`, clicks Allow.
5. Server exchanges the returned code for a fresh refresh token, saves it
   to `app_settings`, hot-reloads the Sheets/Drive/Gmail clients.
6. Ben clicks **Fix All** in Sheet Sync Status to backfill anything queued
   during the outage.

Full walkthrough: `docs/OPERATIONS.md#reconnect-google`.

## 8. Sync architecture (DB vs. Sheets / Drive)

**Rule:** the DB is the source of truth for computation (Cash on Hand,
Checks on Hand, running balances, payroll math). Sheets + Drive are the
audit surface accountants use.

Every row that produces a sheet entry has two flags: `syncedToSheets` and
(where applicable) `syncedToDrive`. On successful append, both flip to 1.
On failure, they stay 0.

**Fix All** (via `POST /api/admin/resync-sheets`) walks every unsynced row,
appends to the correct property tab, and rewrites the running-balance
column. It's idempotent; safe to run any time. See OPERATIONS.md.

**Deep verify** (`GET /api/admin/sync-status?deep=1`) reads back the actual
sheet row counts per property and compares to DB counts. Surfaces drift
that would otherwise be invisible.

## 9. Background jobs (all node-cron, in-process)

| Cron       | Schedule (UTC)         | What it does |
| ---------- | ---------------------- | ------------ |
| Daily report | `0 4 * * *`          | Emails admins the previous day's transaction summary |
| Time reports sync | `5 4 * * *`     | Rebuilds the time-reports spreadsheet from DB |
| Doc reminders | `0 14 * * *`        | Emails users missing W-9/ID/banking |
| Google health check | `*/30 * * * *`| Emails Ben on ok↔broken transitions |
| Daily 7pm reminders | `0 19 * * 1-6` (ET) | Reminds PMs to file their work report |

Boot-time catch-up: on server start, if it's past 7 PM ET on a Mon-Sat
and no reminder heartbeat exists for today, fire the reminder immediately.

## 10. Hosting details

- **Platform:** Railway Pro plan
- **Public URL:** https://invoice-snap-production.up.railway.app
- **Region:** US West (San Jose)
- **Volume:** attached persistent volume mounted at `/data` (currently 5 GB, ~458 MB used)
- **Auto-deploy:** every push to `main` on GitHub triggers a build and
  deploy. Zero manual intervention.
- **Build command:** `npm ci && npm run build` (bundles server + client
  via `script/build.ts`).
- **Start command:** `node dist/index.cjs` (compiled server).
- **Restart policy:** Railway auto-restarts on crash and re-runs any
  pending cron catch-up.

## 11. Environment variables

Non-secret variable names (values live in Railway Variables tab):

| Name | Purpose |
| ---- | ------- |
| `DATA_DIR` | Path to the persistent volume (`/data`). Used for DB, uploads, config files. |
| `GOOGLE_CLIENT_ID` | OAuth2 client ID for the Invoice Snap Server Google app |
| `GOOGLE_CLIENT_SECRET` | Matching secret |
| `GOOGLE_REFRESH_TOKEN` | Refresh token fallback (superseded by the DB-stored one) |
| `GMAIL_APP_PASSWORD` | Legacy - not used since Gmail API took over |
| `PORT` | Set by Railway automatically |

## 12. Where each concern lives in the codebase

| Concern | File(s) |
| ------- | ------- |
| DB schema | `shared/schema.ts` |
| Storage layer (Drizzle queries) | `server/storage.ts` |
| REST API + business logic | `server/routes.ts` (7,000+ lines) |
| Google API client | `server/google-api.ts` |
| Server entrypoint + cron setup | `server/index.ts` |
| Static file serving (production) | `server/static.ts` |
| Vite dev server hookup (development) | `server/vite.ts` |
| Client entrypoint | `client/src/main.tsx`, `client/src/App.tsx` |
| Client screens | `client/src/pages/*.tsx` |
| Client UI kit | `client/src/components/ui/*` (shadcn) |
| Client auth hook | `client/src/hooks/use-auth.tsx` |
| Fetch wrapper (adds bearer token) | `client/src/lib/queryClient.ts` |
| Design tokens + styles | `client/src/index.css`, Tailwind config |
| Runtime PDFs (manuals) | Generated externally, uploaded via admin endpoints |

## 13. Trust boundaries and threat model

**Trusted:**
- Railway (hosting, network, disk).
- Google (identity provider, storage of long-term photos + spreadsheets).
- GitHub (source integrity).

**Semi-trusted:**
- The user's phone browser (must supply a valid bearer token; nothing else
  is trusted about client-side state; server re-validates every request).

**Attack surface:**
- Public login endpoint - rate-limiting is minimal; recommend adding
  per-IP throttle if abuse ever appears.
- Password reset endpoint - could be used to enumerate emails; response
  is identical whether the address exists or not.
- Uploaded files - stored under UUIDs, served via authenticated
  `/api/uploads/*` endpoint that re-checks the session. Not publicly
  guessable.

**Known limitations to accept for now:**
- Single-account Google ownership (`jetsetterinvoices1@gmail.com`).
- No 2FA on in-app admin accounts (only Google + Railway + GitHub).
- SQLite is not clustered - if the Railway VM dies mid-write, in-flight
  request is lost; the DB itself is fine.

## 14. Design decisions worth knowing

1. **Custom auth instead of Passport / NextAuth.** The app has 4 roles
   and simple property scoping. A DB-backed token table with `crypto.scrypt`
   is 40 lines of code. Any pluggable library would add complexity, not
   remove it, for this scale.

2. **SQLite instead of PostgreSQL.** Volume is small (~458 MB, mostly
   photos not DB rows). SQLite is a single file, backs up in one `cp`
   command, doesn't need a separate service. If you ever hit 10 GB of DB
   rows or 100+ concurrent writers, revisit.

3. **Hash routing (`/#/admin`) instead of history-mode.** Railway serves
   `index.html` for `/` and static assets from a subdirectory. Hash
   routing means every path resolves to `index.html` without special
   Express catch-alls. Trade-off: URLs are slightly uglier. Trade-off
   worth it for a simple deploy story.

4. **Comments over docs, where possible.** Non-obvious code decisions
   have a paragraph of prose above the function. Reduces "why is it like
   this" archaeology later. Documentation like this file complements the
   in-code comments; it doesn't replace them.

5. **Backend and frontend TypeScript share `shared/schema.ts`.** Drizzle
   types flow into both, so an API response is typed end-to-end.

## 15. Where to go next

- **`docs/DATABASE.md`** - schema walkthrough, table-by-table.
- **`docs/OPERATIONS.md`** - day-to-day runbook (reconnect Google, restore
  from backup, upgrade the volume, migrate to a new Google account).
- **In-code comments** - virtually every non-obvious function has a
  header comment explaining why it's shaped the way it is.
- **`git log`** - each commit message is deliberately explanatory. The
  history is the design log.
