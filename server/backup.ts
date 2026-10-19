// ---- Nightly database backup to Google Drive ----
// Every night the app takes a consistent snapshot of data.db, compresses it,
// ENCRYPTS it, and uploads it to the "Jetsetter Reporting Backups" folder in
// the app's own Google Drive. The newest 30 backups are kept; older ones go
// to Drive's trash (recoverable there for 30 more days).
//
// Why encrypted: the database holds personal data and user passwords, so a
// readable copy must never sit in Drive. The key is the Railway variable
// BACKUP_ENCRYPTION_KEY (keep a copy in Bitwarden — without it a backup
// cannot be restored). To restore: script/decrypt-backup.ts (see OPERATIONS.md).
//
// Free: uses the Drive account and Gmail sender the app already has.
// Receipt photos are not included; they are already uploaded to Drive as
// they are submitted, and Railway keeps daily volume snapshots.

import fs from "fs";
import os from "os";
import path from "path";
import { backupDatabaseTo, getAppSetting, setAppSetting } from "./storage";
import {
  isGoogleEnabled,
  ensureDriveFolder,
  driveFolderExists,
  uploadFileToDrive,
  listDriveFolderChildren,
  trashDriveFile,
} from "./google-api";
import { reportAppError, flushAlerts } from "./alerts";
import { encryptBackup } from "./backup-crypto";

export const BACKUP_FOLDER_NAME = "Jetsetter Reporting Backups";
export const BACKUP_FILE_PREFIX = "jetsetter-db-";
export const BACKUP_FILE_SUFFIX = ".db.gz.enc";
const KEEP_NEWEST = 30;

export interface BackupResult {
  ok: boolean;
  fileName?: string;
  sizeBytes?: number;
  removedOld?: number;
  error?: string;
}

let running = false;

export async function runNightlyBackup(): Promise<BackupResult> {
  if (running) return { ok: false, error: "A backup is already running" };
  running = true;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsr-backup-"));
  try {
    const passphrase = process.env.BACKUP_ENCRYPTION_KEY || "";
    if (passphrase.length < 16) {
      throw new Error(
        "BACKUP_ENCRYPTION_KEY is not set in Railway (or is shorter than 16 characters), so no backup was made.",
      );
    }
    if (!isGoogleEnabled()) {
      throw new Error("Google is not connected, so the backup could not be uploaded. Reconnect Google in the Admin Panel.");
    }

    // 1. Consistent snapshot of the live DB, then compress + encrypt.
    const snapshotPath = path.join(tmpDir, "snapshot.db");
    await backupDatabaseTo(snapshotPath);
    const encrypted = encryptBackup(fs.readFileSync(snapshotPath), passphrase);
    const stamp = new Date().toISOString().replace(/[:]/g, "-").slice(0, 16); // 2026-10-20T07-30
    const fileName = `${BACKUP_FILE_PREFIX}${stamp}Z${BACKUP_FILE_SUFFIX}`;
    const encPath = path.join(tmpDir, fileName);
    fs.writeFileSync(encPath, encrypted);

    // 2. Find (or create) the backup folder; the ID is cached in app settings.
    let folderId = getAppSetting("backup_drive_folder_id");
    if (!folderId || !(await driveFolderExists(folderId))) {
      folderId = await ensureDriveFolder(BACKUP_FOLDER_NAME);
      if (!folderId) throw new Error(`Could not find or create the "${BACKUP_FOLDER_NAME}" folder in Google Drive.`);
      setAppSetting("backup_drive_folder_id", folderId);
    }

    // 3. Upload.
    const fileId = await uploadFileToDrive(encPath, fileName, folderId, "application/octet-stream");
    if (!fileId) throw new Error("Uploading the backup to Google Drive failed.");

    // 4. Retention: keep the newest KEEP_NEWEST backups (names sort by date).
    let removedOld = 0;
    const existing = (await listDriveFolderChildren(folderId))
      .filter((f) => f.name.startsWith(BACKUP_FILE_PREFIX) && f.name.endsWith(BACKUP_FILE_SUFFIX))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const old of existing.slice(KEEP_NEWEST)) {
      if (await trashDriveFile(old.id)) removedOld++;
    }

    setAppSetting("backup_last_success_at", new Date().toISOString());
    setAppSetting("backup_last_error", "");
    console.log(`[backup] Uploaded ${fileName} (${encrypted.length} bytes), removed ${removedOld} old backup(s)`);
    return { ok: true, fileName, sizeBytes: encrypted.length, removedOld };
  } catch (e: any) {
    const error = e?.message || String(e);
    console.error("[backup] failed:", error);
    try { setAppSetting("backup_last_error", error); } catch {}
    reportAppError("Nightly backup failed", error);
    flushAlerts().catch(() => {});
    return { ok: false, error };
  } finally {
    running = false;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
