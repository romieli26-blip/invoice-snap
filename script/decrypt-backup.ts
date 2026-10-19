// Restore helper for the nightly Drive backups made by server/backup.ts.
//
// Usage (on your own computer, in the repo folder, after `npm ci`):
//   BACKUP_ENCRYPTION_KEY='<from Bitwarden>' npx tsx script/decrypt-backup.ts \
//       jetsetter-db-2026-10-20T07-30Z.db.gz.enc  restored.db
//
// The output is a normal SQLite file (open it with DB Browser for SQLite, or
// follow OPERATIONS.md to put it back on the Railway volume).
import fs from "fs";
import { decryptBackup } from "../server/backup-crypto";

const [input, output] = process.argv.slice(2);
const key = process.env.BACKUP_ENCRYPTION_KEY || "";
if (!input || !output || !key) {
  console.error("Usage: BACKUP_ENCRYPTION_KEY=... npx tsx script/decrypt-backup.ts <backup-file> <output.db>");
  process.exit(1);
}
const db = decryptBackup(fs.readFileSync(input), key);
fs.writeFileSync(output, db);
console.log(`Restored ${output} (${db.length} bytes)`);
