// ---- Operator alerts ----
// Emails Ben when the server hits an error, so problems surface within
// minutes instead of when a PM complains. Free: it sends through the same
// Gmail account the app already uses.
//
// Noise control:
//  - Errors are collected and sent as ONE digest email every 10 minutes.
//  - The same error (same place + same message) is emailed at most once
//    every 6 hours; repeats in between are counted and reported next time.
//  - Request bodies are never included (they can hold passwords).
//
// routes.ts registers the actual email sender via setAlertSender(), because
// the Gmail sending code lives there.

type AlertSender = (subject: string, htmlBody: string) => Promise<void>;

let sender: AlertSender | null = null;

const FLUSH_INTERVAL_MS = 10 * 60 * 1000;
const REPEAT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MAX_ITEMS_PER_EMAIL = 20;

interface PendingError {
  where: string;
  message: string;
  count: number;
  firstAt: Date;
  lastAt: Date;
}

const pending = new Map<string, PendingError>();
const lastEmailedAt = new Map<string, number>();

export function setAlertSender(fn: AlertSender): void {
  sender = fn;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Record an error for the next alert digest. Never throws.
 * @param where   short description of where it happened, e.g. "POST /api/invoices"
 * @param message the error message (truncated; no request data)
 */
export function reportAppError(where: string, message: unknown): void {
  try {
    const text = String((message as any)?.message ?? message ?? "Unknown error")
      .replace(/\s+/g, " ")
      .slice(0, 300);
    const key = `${where}|${text.slice(0, 120)}`;
    const now = new Date();
    const existing = pending.get(key);
    if (existing) {
      existing.count++;
      existing.lastAt = now;
    } else {
      pending.set(key, { where, message: text, count: 1, firstAt: now, lastAt: now });
    }
  } catch {
    // Alerting must never break the app.
  }
}

/** Send any due errors as one email. Exported so it can be triggered in tests. */
export async function flushAlerts(): Promise<number> {
  if (!sender || pending.size === 0) return 0;
  const now = Date.now();
  const due: PendingError[] = [];
  for (const [key, item] of Array.from(pending.entries())) {
    const last = lastEmailedAt.get(key) || 0;
    if (now - last >= REPEAT_COOLDOWN_MS) {
      due.push(item);
      pending.delete(key);
      lastEmailedAt.set(key, now);
    }
    // Otherwise keep counting until the cooldown passes.
  }
  if (due.length === 0) return 0;

  due.sort((a, b) => b.count - a.count);
  const shown = due.slice(0, MAX_ITEMS_PER_EMAIL);
  const total = due.reduce((n, d) => n + d.count, 0);

  const rows = shown
    .map(
      (d) =>
        `<tr><td style="padding:6px;border:1px solid #ddd;">${escapeHtml(d.where)}</td>` +
        `<td style="padding:6px;border:1px solid #ddd;">${escapeHtml(d.message)}</td>` +
        `<td style="padding:6px;border:1px solid #ddd;text-align:right;">${d.count}</td>` +
        `<td style="padding:6px;border:1px solid #ddd;">${d.firstAt.toISOString().replace("T", " ").slice(0, 16)} UTC</td></tr>`,
    )
    .join("");
  const more = due.length > shown.length ? `<p>...and ${due.length - shown.length} more kinds of error.</p>` : "";

  const onlyBackup = due.every((d) => d.where === "Nightly backup failed");
  const subject = onlyBackup
    ? "[Jetsetter Reporting] Nightly backup failed"
    : `[Jetsetter Reporting] App error: ${total} error${total === 1 ? "" : "s"} (${shown[0].where})`;
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;">` +
    `<p>The app hit ${total} error${total === 1 ? "" : "s"} recently. Users may have seen a failure on these screens.</p>` +
    `<table style="border-collapse:collapse;width:100%;">` +
    `<tr style="background:#fdecea;"><th style="padding:6px;border:1px solid #ddd;text-align:left;">Where</th>` +
    `<th style="padding:6px;border:1px solid #ddd;text-align:left;">Error</th>` +
    `<th style="padding:6px;border:1px solid #ddd;">Count</th>` +
    `<th style="padding:6px;border:1px solid #ddd;text-align:left;">First seen</th></tr>` +
    rows +
    `</table>${more}` +
    `<p style="color:#666;font-size:12px;">The same error is emailed at most once every 6 hours. ` +
    `Forward this email to Claude to get it diagnosed and fixed.</p></div>`;

  try {
    await sender(subject, html);
  } catch (e: any) {
    console.error("[alerts] failed to send alert email:", e?.message);
  }
  return total;
}

let started = false;
/** Start the periodic flush and catch process-level crashes. Call once at boot. */
export function startAlerting(): void {
  if (started) return;
  started = true;
  const timer = setInterval(() => {
    flushAlerts().catch(() => {});
  }, FLUSH_INTERVAL_MS);
  timer.unref?.();

  // Node's default for both of these is to crash; Railway then restarts the
  // app. We keep that behavior and only add a last-gasp alert email first.
  const crash = (where: string, err: any) => {
    console.error(`[alerts] ${where}:`, err);
    reportAppError(where, err);
    setTimeout(() => process.exit(1), 15000).unref?.();
    flushAlerts()
      .catch(() => {})
      .finally(() => process.exit(1));
  };
  process.on("unhandledRejection", (reason: any) => crash("Server crash (unhandled promise)", reason));
  process.on("uncaughtException", (err: any) => crash("Server crash (uncaught exception)", err));
}
