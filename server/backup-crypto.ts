// Encryption format for the nightly backups (see server/backup.ts).
// Kept free of app imports so script/decrypt-backup.ts can use it without
// opening the database or connecting to Google.
import crypto from "crypto";
import zlib from "zlib";

// File layout: MAGIC | salt(16) | iv(12) | authTag(16) | AES-256-GCM(gzip(db))
export const BACKUP_MAGIC = Buffer.from("JSRBAK1\n", "ascii");

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32);
}

export function encryptBackup(plain: Buffer, passphrase: string): Buffer {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(plain)), cipher.final()]);
  return Buffer.concat([BACKUP_MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function decryptBackup(file: Buffer, passphrase: string): Buffer {
  if (!file.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    throw new Error("Not a Jetsetter backup file");
  }
  let o = BACKUP_MAGIC.length;
  const salt = file.subarray(o, (o += 16));
  const iv = file.subarray(o, (o += 12));
  const tag = file.subarray(o, (o += 16));
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  const gz = Buffer.concat([decipher.update(file.subarray(o)), decipher.final()]);
  return zlib.gunzipSync(gz);
}
