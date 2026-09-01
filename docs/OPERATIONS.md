# Jetsetter Reporting - Operations Runbook

> **Purpose.** Every routine and non-routine ops task, step-by-step, so that
> anyone with admin access can perform it without a developer on call.
> Ordered by how often you'll need it - most common tasks first.

**Last updated:** September 2026
**Production URL:** https://invoice-snap-production.up.railway.app
**Repo:** https://github.com/romieli26-blip/invoice-snap
**Hosting:** Railway Pro plan
**Companion docs:** `ARCHITECTURE.md`, `DATABASE.md`

---

## Cheat-sheet: top 10 tasks

| Task                              | Where you go                        | Time |
| --------------------------------- | ----------------------------------- | ---- |
| Reconnect Google (weekly)         | Admin Panel → Sheet Sync Status     | 20 s |
| Fix All (backfill sheets)         | Admin Panel → Sheet Sync Status     | 30 s |
| Resize the Railway volume         | Railway → Volume → Settings         | 30 s |
| Change your password              | Header → key icon                   | 30 s |
| Reset a user's password           | (No admin path - user self-serves)  | -    |
| Archive a user                    | Admin Panel → Users → archive icon  | 20 s |
| Grant a manager a second property | Admin Panel → Users → gear icon     | 60 s |
| Set a property's URL              | Admin Panel → Properties → expand   | 60 s |
| Publish a new PM Manual PDF       | Admin Panel → Manuals → upload      | 30 s |
| Deploy a code change              | `git push origin main`              | 2 m  |

---

## 1. Reconnect Google (the weekly ritual)

### When
- You receive the `[Jetsetter Reporting] Google sync is broken - reconnect needed` email.
- Or the red "Google sync is broken" pill shows in Sheet Sync Status.
- Or someone reports the Sheets not updating.

### Steps
1. Open the admin panel: [production URL]/#/admin.
2. Click **Reconnect Google** in the red pill under Sheet Sync Status.
3. A new tab opens Google's consent screen.
4. Sign in as `jetsetterinvoices1@gmail.com`.
5. If Google warns about an unverified app: click **Advanced** → **Go to
   Invoice Snap (unsafe)**. Safe because you own the app.
6. Click **Allow** on the consent screen.
7. You see a green "Google reconnected" page. Close that tab.
8. In the admin panel (within 60 s) the pill turns green.
9. Click **Fix All** in the same panel to push any queued rows to Sheets.
10. Wait for the summary toast. You're done.

### If it fails

- **"Access blocked: This app's request is invalid" (redirect_uri_mismatch)**
  → The redirect URI is missing from the OAuth client. Add
  `https://invoice-snap-production.up.railway.app/api/admin/google-oauth-callback`
  to the client's Authorized redirect URIs at
  https://console.cloud.google.com/auth/clients.
- **"Access blocked: Invoice Snap can only be used within its organization" (org_internal)**
  → OAuth consent screen is set to Internal but `jetsetterinvoices1@gmail.com`
  is a personal Gmail, not part of the Workspace org. Flip Audience to
  External + Testing, add the Gmail as a test user, retry. Full walkthrough
  in past session context.
- **"unauthorized_client"** → Scopes are missing from the OAuth consent
  screen's Data Access page. Add `spreadsheets`, `drive`, `gmail.send`.
- **The pill stays red for more than 5 minutes after successful reconnect**
  → Hard-refresh the admin page (Cmd/Ctrl+Shift+R). The 60 s poll cache
  needs to flush.

### Why this exists
The Google OAuth consent screen is in External + Testing mode. Google
invalidates refresh tokens after 7 days in that mode. Permanent fix
requires migrating to a Google Workspace account inside a Jetsetter
Capital-owned org, which is a large project.

---

## 2. Fix All (backfill unsynced rows to Sheets)

### When
- After a reconnect (item 1 above).
- Any time Sheet Sync Status shows drift ("N rows unsynced").
- After you migrate the DB from a backup.
- Whenever an accountant reports a missing spreadsheet row that the app
  clearly has.

### Steps
1. Admin Panel → Sheet Sync Status.
2. Click the refresh icon in the top-right of the panel to run a Deep
   verify (reads back actual sheet counts).
3. If drift is reported, click **Fix All**.
4. Watch the summary that appears - one line per property tab, showing
   how many rows were written or an error message.
5. Re-run Deep verify; drift should now be zero.

### What it does under the hood
For each property tab in CC / Cash / Check / Time Reports spreadsheets:
- Clears the tab's data area (rows 2 onwards).
- Reads every relevant row from the DB, ordered chronologically.
- Rewrites the header row.
- Writes all rows back, including a freshly-computed running balance
  column L for the Cash Transactions sheet.
- Marks each row's `syncedToSheets = 1`.

Idempotent - running twice in a row is safe.

### Warning
Fix All rewrites the running-balance column. If someone was mid-typing a
manual note in that column when Fix All fires, they'll lose it. Column L
is server-owned; never edit it manually.

---

## 3. Resize the Railway volume

### When
- Volume usage hits 80% or higher (Railway shows a yellow banner).
- You're about to add a large batch of receipts and want headroom.

### Steps
1. https://railway.app → invoice-snap project.
2. Click on the `invoice-snap-volume` node in the canvas.
3. Click the **Settings** tab.
4. Under **Volume Size**, drag the slider (or type a value).
5. Click **Update**.
6. Railway resizes in place; no downtime.

### Sizing recommendation
- Current usage: ~458 MB.
- Recommended: 5 GB (10× headroom, negligible cost on Pro plan).
- Cost: $0.15/GB/month on top of the base $20 Pro plan fee. 5 GB = $0.75/mo extra.

### If you're on Hobby plan
You cannot resize past 500 MB. Either:
- Upgrade to Pro ($20/mo base + usage), OR
- Ask the developer to build the "direct-to-Drive photo storage" change
  which reduces volume usage to ~10 MB permanently.

---

## 4. Manage users (create, archive, reset password)

### Create a new user
1. Admin Panel → Users tab.
2. Click **+ Add User**.
3. Fill: Username (unique), Display Name, Role, Email, Home Property.
4. Save. The user is created with a temporary password and
   `mustChangePassword = 1`.
5. If email is set, a welcome email is sent automatically (with the
   temporary password inline). If not, tell them the temporary password
   verbally.

### Archive a user
1. Admin Panel → Users tab → find the user.
2. Click the archive icon (looks like a box with a down arrow).
3. Confirm.
4. All their sessions are kicked. They can no longer log in. Their
   historic rows in every table stay intact. Their tab on the Time
   Reports sheet is hidden (not deleted).

### Unarchive
1. Same location, click the unarchive icon.
2. On unarchive, a fresh temporary password is generated and emailed to
   the user. They must change it on next login.

### The user forgot their password
Do NOT try to reset it as admin. There's no admin-reset endpoint on
purpose (deliberate design: users own their credentials end-to-end).
Instead:
1. Tell them to click **Forgot your login details?** on the sign-in
   screen.
2. Enter their email address.
3. The app emails them a fresh temporary password.
4. They log in with it and are forced to set a new password.

### Grant a manager access to a second property
1. Admin Panel → Users → find the user.
2. Click the **gear icon** (not the pencil).
3. In the "Assign Properties" dialog, tick every property they should
   see. Home property is always ticked.
4. Save.

Result: on the manager's dashboard, the Marketing / Master Sheet /
Vending / Meter Reading buttons will show a picker whenever more than
one of their assigned properties has that URL set.

---

## 5. Manage properties

### Add a property
1. Admin Panel → Properties tab.
2. Click **+ Add Property**.
3. Enter name. Save.
4. Expand the newly-created row and set:
   - **Short code** (2-4 letters, e.g. `TP`).
   - **Marketing URL, PM Master Sheet URL, Vending / Washer / Dryer URL,
     Meter Reading URL** - one at a time, save.

### Renaming a property
Currently no UI for this. If you truly need to, do it in two steps:
1. Ask the developer to run a rename script that updates every
   `property` text column across all tables.
2. Rename the tab in each Google Sheet manually.

---

## 6. Publish a new PDF manual

The app attaches PM / Admin / Contractor manual PDFs to specific emails
(e.g. new-PM welcome).

### Steps
1. Admin Panel → Manuals section.
2. Locate the target slot (PM Manual, Admin Manual, Contractor Manual).
3. Click the upload button and select the new PDF.
4. Confirm. The new version is now active. Every subsequent welcome
   email attaches the new file.

### To regenerate the PM Manual with new content
Load the `jetsetter-pm-manual` skill (in the user's Perplexity skill
library). It has the ReportLab script, style checklist, and
capture-dashboard automation. Full instructions in that skill.

---

## 7. Deploy a code change

### Automatic
1. Any push to `main` on GitHub triggers a Railway build and deploy.
2. Build takes ~90 s.
3. Verify by hitting production URL and checking the hashed bundle name
   in the HTML (`index-XXXX.js`) changed.

### If Railway build fails
1. Railway dashboard → Deployments → click the failed one → View logs.
2. Fix the reported error locally, push again.
3. If Railway itself is degraded (their status page shows an incident),
   push an empty commit later: `git commit --allow-empty -m "retry" && git push`.

### Manual redeploy (if push isn't picked up)
1. Railway dashboard → Deployments → latest one → three-dot menu →
   **Redeploy**.

---

## 8. Restore from backup

### From Railway automatic snapshots
1. Railway dashboard → your service → Volumes → invoice-snap-volume.
2. Click the **Backups** tab.
3. Pick a snapshot (up to 7 days old).
4. Click **Restore**. Railway spins the service down, restores the
   volume, and starts it back up.
5. Log in and verify - Cash on Hand cards, latest transactions, etc.
6. Run Fix All to reconcile the Sheets against the restored DB.

**Expect data loss** from any transactions submitted after the snapshot
was taken. Users will need to re-submit those.

### Manual backup you can run any time
```bash
# On the Railway VM (via Railway shell):
sqlite3 /data/data.db ".backup /data/backups/backup-$(date +%F-%H%M).db"
```

Not currently automated. Building a nightly encrypted-to-Drive backup
is on the roadmap.

---

## 9. Emergency: production is down

### Diagnose
1. Load the production URL. Does it load at all?
   - **No** → Railway is down or the service crashed. Check
     https://status.railway.com. If Railway is healthy, check Railway's
     deployment tab for a red "crashed" state.
   - **Yes** but broken → check the browser console for errors.
2. Log in. Do the dashboard cards load?
   - **No, blank** → the SQLite DB might be corrupted. See item 8.
   - **Yes but sync appears broken** → see item 1 (Reconnect Google).

### Quick recovery levers
- **Restart the service:** Railway dashboard → Deployments → three-dot
  menu on the active deployment → **Restart**. Takes 30 s.
- **Roll back:** Railway dashboard → Deployments → find the last known
  good deploy → three-dot menu → **Redeploy**. This brings the previous
  version back live in 60 s.
- **Nuclear option (data intact):** ask the developer to spin up a
  second Railway service pointed at the same volume, verify the second
  one works, cut DNS.

### Communicate
Silence during a production issue erodes trust. Even a "we're aware and
looking" Slack / WhatsApp to the property managers goes a long way.

---

## 10. Migrate to a new Google account (the big project)

**Estimated effort:** one-day project with the developer.

### Why you'd do it
- To move from personal Gmail to a Google Workspace account inside a
  jetsettercapital.com Workspace, which:
  - Eliminates the 7-day token expiry.
  - Aligns ownership with the company legally.
  - Enables scoped user permissions on the Sheets.

### Steps in order
1. Create a Google Workspace user under `jetsettercapital.com` (or
   whatever your Workspace domain is). Example: `sync@jetsettercapital.com`.
2. Log in to that account, create a Google Cloud project, create an
   OAuth 2.0 client of type Web application.
3. Copy the new `Client ID` and `Client Secret`. Update the Railway
   env vars accordingly.
4. Share the existing Sheets and Drive folders from
   `jetsetterinvoices1@gmail.com` with the new account with **Editor**
   access.
5. Change ownership of each shared resource to the new account.
6. Update the OAuth consent screen: set User Type to **Internal**
   (Workspace-only, no test users needed, no 7-day expiry).
7. Reconnect from the app using the new client.
8. Once verified, revoke the personal Gmail's access.

This is deliberately not automated. It's a one-way move and worth doing
carefully with the developer.

---

## 11. Credential rotation

### Every 6 months
- Rotate the Railway account password.
- Rotate the GitHub account password.
- Rotate the `jetsetterinvoices1@gmail.com` password.
- Rotate the in-app `admin` account password (currently `admin123` -
  should be changed on first login).

### Every 12 months
- Rotate the `GOOGLE_CLIENT_SECRET` in Cloud Console (regenerate,
  update Railway env, redeploy).

### Immediately, on any suspected compromise
- Revoke all sessions in the app: no admin UI for this yet; developer
  runs `DELETE FROM sessions` on the DB.
- Rotate the Google refresh token (in-app Reconnect Google button
  suffices - previous token is discarded).
- Rotate whatever password was compromised.

Store every credential in a 1Password / Bitwarden vault owned by the
company. Never in email or plain files.

---

## 12. Monitoring and health

### What you should watch weekly
- **Volume usage** at Railway → invoice-snap-volume → Metrics. Should
  stay below 80% of capacity. Alert threshold currently at 92%.
- **Health-check emails** to Ben. If you're getting more than one
  `Google sync is broken` per 7 days, the OAuth setup drifted; check
  the Reconnect Google flow.
- **Sheet Sync Status pill** in the admin panel. Should be green
  99% of the time.

### What you should watch monthly
- **Railway usage bill** at Railway → your workspace → Usage. Currently
  ~$22/mo. Anything over $50 suggests something's wrong (runaway logs,
  photo storage explosion, etc.).
- **Number of unarchived users** vs. actual active PMs. Archive
  anyone who's left.
- **Doc completeness** at Admin Panel → Users. Every user should have
  photo_id + banking + W-9. Missing docs indicate the doc-reminder cron
  is being ignored - follow up personally.

---

## 13. Roadmap (nice-to-haves not yet built)

- **Nightly encrypted DB backup to Drive.** Complements Railway's 7-day
  snapshot chain with an off-Railway copy.
- **In-app 2FA for admin accounts.** Currently only Google + Railway +
  GitHub have 2FA available.
- **Rate limiting on `/api/login` and `/api/forgot-password`.** To
  prevent enumeration and brute-force.
- **Soft-delete on properties + user history.** Currently deleting a
  property is manual and error-prone.
- **Direct-to-Drive photo storage.** Skip Railway disk for photos,
  cutting volume usage 95%.
- **Migration to Google Workspace account.** Big project; see item 10.

---

## 14. Escalation path

**When a normal admin can handle it:** any item in this document.

**When you need the developer:**
- Database schema change.
- New endpoint or business rule.
- Data migration script.
- Anything involving the Railway CLI or SSH.
- Anything involving reading raw SQL or JSON blobs.

**When you need to escalate beyond the developer** (e.g. developer
unreachable for 48+ hours):
- Contact any developer familiar with Node.js + SQLite + Google APIs.
- Point them at `docs/ARCHITECTURE.md` and this file.
- Give them repo access on GitHub, Railway team access, Google Cloud
  Console project access.
- Estimated onboarding: 4-8 hours before they can safely make changes.
