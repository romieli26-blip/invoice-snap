# CLAUDE.md - invoice-snap (Jetsetter Reporting)

Claude reads this file automatically at the start of every session on this repo.

## Project
Production web app for Jetsetter Capital property managers: credit-card receipts, cash, checks, work reports, documents, and credit-card statement reconciliation. It syncs to Google Sheets and Drive through the account jetsetterinvoices1@gmail.com.
- Production: https://invoice-snap-production.up.railway.app (Railway). **Merging to `main` deploys to production**; a deploy takes about 4-5 minutes.
- Owner: Ben (ben@jetsettercapital.com). He is not a developer. Explain things in plain English, briefly, and say what you verified and what you assumed.
- Built with Perplexity Computer (Mar-Sep 2026), maintained with Claude since Oct 2026.

## Commands
- `npm ci`: install
- `npm run dev`: local dev server (set DATA_DIR=./local-data; never use production data)
- `npm run check`: TypeScript. **31 errors already existed at handover (Oct 2026)**, all type-strictness noise that does not affect runtime. Don't add new ones.
- `npm run build`: builds dist/index.cjs. Railway runs `npm ci && npm run build`, then `node dist/index.cjs`. The repo also commits dist/index.cjs by convention.

## Layout
- server/routes.ts: all API routes, plus seeding and migrations at startup
- server/google-api.ts: Drive/Sheets helpers and the OAuth client
- server/index.ts: startup and cron jobs (daily report 04:00 UTC, time-report sync, doc reminders, Google health check every 30 min, 7 PM ET reminders, 3:30 AM ET backup)
- server/storage.ts: DB access layer (SQLite via better-sqlite3 + Drizzle, `$DATA_DIR/data.db`)
- server/alerts.ts: emails Ben on 5xx errors and crashes (10-minute digest, same error at most every 6 hours)
- server/backup.ts + server/backup-crypto.ts: nightly encrypted DB backup to the Drive folder "Jetsetter Reporting Backups" (keeps 30). Restore with script/decrypt-backup.ts.
- shared/schema.ts: Drizzle tables (source of truth for fields)
- shared/tz.ts: property-aware time helpers (ALWAYS use these)
- client/src/pages/*.tsx: screens
- docs/ARCHITECTURE.md, docs/DATABASE.md, docs/OPERATIONS.md: read before structural changes

## Rules
- `main` = production. Work on a branch, open a PR, show Ben the change in plain words, and merge only after his explicit OK. After merging, confirm the Railway deploy succeeded (GitHub deployment status) and that the site responds.
- Never ask for, paste, or echo secrets. Ben keeps them in Bitwarden. Railway variables: DATA_DIR, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, BACKUP_ENCRYPTION_KEY. Optional: ALERT_EMAIL, GOOGLE_OAUTH_REDIRECT_URI, APP_ORIGIN. GMAIL_APP_PASSWORD is a leftover; the code doesn't use it.
- Time zones: Trails End and Pop's Grill = America/New_York; all others = America/Chicago. The `new Date(new Date().toLocaleString(...))` pattern is banned.
- The DB is the source of truth for calculations; Sheets and Drive are the audit layer. The resync ("Fix All") must stay idempotent.
- Keep the property-manager UI simple: no extra fields or labels unless Ben asks for them.
- Before risky migrations, make sure a fresh backup exists (`POST /api/admin/backup-now`, or docs/OPERATIONS.md 8.5).
- PM manual edits follow the jetsetter-pm-manual style (ASCII hyphens, no [NEW] chips). Never publish the manual without Ben's approval.
- Don't take actions inside the live app (as a logged-in user) without Ben's explicit go-ahead for that specific action.

## Monitoring (all free, inside the app)
- Ben's inbox receives: "Jetsetter Daily Report" (about 04:00 UTC daily), "[Jetsetter Reporting] Google sync is broken / recovered", "[Jetsetter Reporting] App error: ...", "[Jetsetter Reporting] Nightly backup failed".
- The Google OAuth client is in "Testing" mode, so the refresh token expires every 7 days and Ben clicks Reconnect Google, then Fix All. Publishing the OAuth app to "In production" would end this (Ben's decision, in Google Cloud Console).

## Open items (as of 19 Oct 2026)
Security, in priority order:
1. **Passwords are stored in plain text** in the users table and compared directly at login. Move to salted hashes (e.g. crypto.scrypt), migrating existing users transparently on their next login. Nobody should have to reset their password.
2. **The `Bearer internal-cron` header is a fixed string in a repo that was public**, and it is accepted from anyone by /api/admin/daily-report, doc-reminders, daily-7pm-reminders, sync-time-reports-sheet and google-health-check. Accept it only from loopback (the cron jobs call localhost).
3. Seed passwords for `admin` and `ben` are still hard-coded in server/routes.ts. They only run on an empty DB, but they should come from env or random-at-first-boot.
4. Ben was to change the `admin` account password (or archive it) and make the GitHub repo private.

Roadmap: duplicate-submission warning (same property + amount + date + last 4 within N days; warn, don't block), rate limiting on /api/login and /api/forgot-password, 2FA for admins, soft-delete, direct-to-Drive photos, moving to a Google Workspace account.

## History
- Oct 2026: removed the `romi` test-account seed (#2); added error alerts and the nightly encrypted Drive backup (#3); added this file; corrected docs (passwords are plain text, not hashed; removed the default admin password from OPERATIONS.md).
