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
| **Restore from backup** (rare)    | See section 8 - read WHOLE section  | 10 m |
| **Manual DB backup** (before risky ops) | Railway → service → Console  | 60 s |

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

> **Read the whole section before starting.** A restore is a destructive
> operation - the current state of the database gets replaced. Once done
> it cannot be undone without ANOTHER restore. Ten minutes of reading now
> is cheaper than an hour of panic in the middle.

### 8.1 When to restore (and when NOT to)

**Restore is the right answer when:**
- A property manager reports that data they can see clearly submitted
  yesterday is missing from the app today.
- The Cash on Hand card shows a wildly wrong number that Fix All cannot
  reconcile.
- The admin panel shows zero users or zero properties (catastrophic
  data loss).
- The database file is corrupted and the server won't boot (you'd see
  Railway showing the service as "crashed" repeatedly).

**Restore is NOT the right answer when:**
- Sheets or Drive are out of sync with the app - that's a **Reconnect
  Google + Fix All** problem (section 1 and 2), not a restore.
- A single user complains they can't see a specific receipt - that's
  either a permissions issue (section 4) or the user is looking at the
  wrong property filter.
- The app is slow or unreachable but data appears intact - that's a
  Railway problem, try section 9's restart lever first.
- Someone accidentally deleted one transaction - a full restore would
  wipe out every OTHER transaction submitted since the snapshot. Have
  the user or admin re-enter the deleted one instead.

**Rule of thumb:** if you're not sure, DON'T restore yet. Take a manual
backup (section 8.5) first, so if you make things worse you can get
back to the current state.

### 8.2 Before you start - do these three things

1. **Screenshot everything you can see right now.**
   - Admin Panel main page.
   - Sheet Sync Status pill (green / red / rows unsynced count).
   - Users list.
   - Properties list.
   - Cash on Hand + Checks on Hand values.
   - The specific evidence of data loss (the missing receipt, the wrong
     total, whatever prompted this).

   You will need these to know when the restore worked and what still
   needs manual fixing.

2. **Take a fresh manual backup of the CURRENT (broken) state.**
   See section 8.5. This lets you roll BACK if the restore makes things
   worse or you accidentally restore the wrong snapshot.

3. **Announce a brief maintenance window.**
   Send a WhatsApp or SMS to Kay, Annette, Megan, and every active PM:
   > "Reporting app is going into maintenance for 10 minutes. Don't
   > submit any new receipts or transactions until I message back."

   This prevents users from submitting between the snapshot restore
   (which happens instantly) and the accountant-visible sheets being
   reconciled (which takes another minute). Those submissions would be
   confusing to reconcile after the fact.

### 8.3 The actual restore (Railway automatic snapshots)

Railway takes an automatic snapshot of the `invoice-snap-volume` every
24 hours and retains **7 days** of history. Snapshots include
everything on the volume: `data.db`, `uploads/`, config files - the
lot.

**Steps:**

1. Sign in to Railway: https://railway.app.
2. Open the **truthful-enchantment** workspace (or whatever your
   workspace is called - only one is used for Jetsetter).
3. Click the **invoice-snap** project.
4. In the canvas that appears, click the **invoice-snap-volume** node.
   (Node, not the Deployments tab. The volume node is the one with a
   little disk icon; the service node is the one with a GitHub icon.)
5. Click the **Backups** tab.
6. You'll see a list of snapshots, each with:
   - A date and time in your local timezone.
   - The total size on disk at that moment.
7. Pick the most recent snapshot from BEFORE the problem started. If
   you're not sure, pick yesterday's - one lost day is better than
   restoring a broken state. Do NOT pick anything older than 3 days
   ago unless you're sure - you'll lose too much intermediate data.
8. Click the three-dot menu next to the snapshot -> **Restore**.
9. A confirmation dialog appears. **Read the warning text carefully**
   - it will explicitly tell you that the current volume contents will
   be replaced. Type the confirmation word / click Confirm.
10. Railway now:
    - Spins the invoice-snap service DOWN (~30 s).
    - Replaces the volume contents with the snapshot (~30-60 s
      depending on volume size).
    - Spins the service back UP (~60 s).
    - Total: ~2-3 minutes of downtime.
11. Watch the **Deployments** tab of the invoice-snap service. You'll
    see the deployment briefly go into a "Deploying" state. When it
    returns to green **Active**, the restore is done.

### 8.4 After the restore - verification and reconciliation

DO NOT skip these steps. A restore that isn't verified is a restore
that isn't complete.

**Step 1 - Confirm the app is up.**
1. Open https://invoice-snap-production.up.railway.app in a browser.
2. Log in as `ben`.
3. If the login page appears and you can sign in, the app is up.
4. If the login page throws an error, wait 60 more seconds and try
   again. If it still fails, see section 9 (Emergency levers).

**Step 2 - Compare what you see now to your pre-restore screenshots.**
- Users list: same people? Same number?
- Properties: all present?
- Cash on Hand: does it match what it was BEFORE the incident? (Not
  "before the restore" - "before whatever broke it in the first place.")
- Recent Receipts: earliest visible receipt is now dated the snapshot
  time, roughly. Anything submitted after that timestamp is gone.

**Step 3 - Reconcile with Google Sheets.**
1. In the admin panel, open the **Sheet Sync Status** section.
2. Click the refresh icon top-right to run **Deep verify**.
3. This compares the (restored) database against what's actually in
   the Google Sheets. Expect **big** drift - transactions that were in
   Sheets but not the snapshot will show as "more in sheet than in DB."
   The reverse is also possible.
4. **Do NOT click Fix All yet.** Fix All rewrites Sheets from the DB.
   If the DB is missing rows that Sheets still has, Fix All would
   DELETE those rows from Sheets. That's usually the wrong outcome.
5. Instead, decide with your accountant which of the two is the
   source of truth for the drift period:
   - **DB is right (Sheets was corrupted or edited manually)** ->
     click Fix All.
   - **Sheets is right (DB was corrupted, Sheets was healthy)** ->
     DO NOT click Fix All. Instead, use Sheets as the source and
     ask a developer to re-import the missing transactions from
     Sheets back into the DB. This is a manual scripting job.

**Step 4 - Announce the outage is over.**
Message the same PMs you announced to in section 8.2:
> "Reporting app is back online. If you submitted anything between
> [start-of-outage-time] and now, please re-submit it. Everything
> after that is fine."

Give them a specific cutoff time. Vague messages produce duplicates.

**Step 5 - Document what happened.**
Write a one-page note (or add to this Perplexity thread) covering:
- What broke (data loss, corruption, wrong entry, etc.).
- What snapshot you restored to (date + time).
- What was lost (roughly how many transactions, from what time range).
- Whether Fix All was run or not.
- Which users had to re-submit.

This becomes the audit record if anyone asks later.

### 8.5 Manual backup (do this BEFORE any risky action)

Railway takes automatic snapshots, but they're on a 24-hour schedule.
Before any restore, schema change, or migration, take a fresh manual
backup so you have a rollback point closer than yesterday.

**Via Railway shell (built into the dashboard):**

1. Railway dashboard -> invoice-snap service -> **Console** tab.
2. In the terminal that opens, run:
   ```bash
   mkdir -p /data/backups
   sqlite3 /data/data.db ".backup /data/backups/pre-restore-$(date +%Y%m%d-%H%M).db"
   ls -lh /data/backups/
   ```
3. You should see a `.db` file with the current timestamp and roughly
   the same size as `/data/data.db`. If the size is 0 bytes or hugely
   different, the backup failed - try again.

That file lives on the same volume, so it survives redeploys but NOT
a volume wipe. If you're doing something that might affect the volume
itself, also do a **download**:

1. In the same Console, run:
   ```bash
   base64 /data/backups/pre-restore-*.db | head -c 100
   ```
   (just to prove the file exists and is readable.)
2. Then use `railway volume download` from your local machine, OR ask
   the developer to `scp` the file off. There's no built-in "download"
   button in the Railway UI as of writing.

### 8.6 Manual restore from a `.db` file you have on disk

If someone hands you a `data.db` file (from an old backup, a developer's
local copy, etc.) and you need to make the production app use it:

1. In the Railway service Console:
   ```bash
   # 1. Snapshot the current DB as a safety net.
   cp /data/data.db /data/data.db.replaced-$(date +%Y%m%d-%H%M)

   # 2. Copy the new file into place.
   #    (upload the file to /data/ first via Railway file transfer or
   #     `railway run` from your local machine.)
   cp /data/incoming.db /data/data.db

   # 3. Restart the service so it opens the new DB.
   ```
2. Restart via the Railway dashboard: three-dot menu on the active
   deployment -> Restart.
3. Verify (section 8.4).

### 8.7 What CAN'T be restored

Some things live outside the Railway volume and are NOT part of any
snapshot:

- **Google Sheets rows.** These live in Google's cloud, not on your
  volume. If someone accidentally deletes a sheet tab, use Google
  Sheets' own version history (File -> Version History -> See version
  history) to restore. Google keeps unlimited edit history.
- **Google Drive photos.** Same as above. Use Drive's file-level
  version history or the Trash (which retains files for 30 days).
- **Environment variables on Railway.** Anything under Variables tab
  is not part of the volume. If someone accidentally deletes
  `GOOGLE_CLIENT_ID`, look at 1Password / Bitwarden or re-derive it
  from Google Cloud Console.
- **The GitHub code repo.** If someone force-pushes over the repo,
  every developer's local machine still has a full copy. `git reflog`
  can also recover.

### 8.8 Nightly off-Railway backup (roadmap item)

Railway's 7-day snapshot retention lives on the same infrastructure as
the running app. If Railway itself has a catastrophic multi-day outage
or the account is compromised, snapshots go with it.

On the roadmap: a nightly cron that dumps `data.db` as an encrypted file
to a dedicated backup folder on Google Drive owned by
`jetsetterinvoices1@gmail.com`. Estimated 3 hours of build work. Ask the
developer to prioritise this if the manager audit ever flags it.

Until that ships, the practical mitigation is to run section 8.5's
manual backup command WEEKLY and download the resulting file to a
laptop or personal Drive. That gives you a copy outside Railway.

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
