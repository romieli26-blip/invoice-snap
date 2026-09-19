// Central-Time helpers.
//
// WHY THIS FILE EXISTS
// -------------------
// The codebase previously computed "now in Central Time" like this:
//
//     const nowCentral = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
//     const todayCentral = nowCentral.toISOString().split("T")[0];
//
// That is the classic double-conversion bug and it is genuinely broken:
//
//   1. `toLocaleString(...)` produces a *wall-clock string* in Central, e.g.
//      "9/19/2026, 7:30:00 PM".
//   2. `new Date("9/19/2026, 7:30:00 PM")` re-parses that string as if those
//      digits were in the RUNTIME's OWN timezone, not Central.
//   3. `.toISOString()` then converts to UTC, shifting the value a second
//      time by the runtime's UTC offset.
//
// `getHours()` survives step 2 (the wall-clock digits round-trip), which is
// why the bug hid for so long. But `.toISOString()` does not: once Central
// wall-clock time is late enough in the evening, the derived date rolls over
// to TOMORROW. The exact hour it breaks depends on the browser's timezone:
//
//     browser on Central   -> breaks after  7:00 PM Central
//     browser on Eastern   -> breaks after  8:00 PM Central
//     browser on Pacific   -> breaks after  5:00 PM Central
//     browser on UTC+      -> never breaks (masks the bug in dev/server)
//
// That 5-8 PM window is exactly where the "my hours jump to the next day"
// and "it won't let me clock out in the evening" reports clustered.
//
// Everything here goes through Intl.DateTimeFormat().formatToParts() instead,
// which reads calendar fields directly out of the target zone and never
// round-trips through a Date parse. `hourCycle: "h23"` avoids the separate
// ICU quirk where `hour12: false` can render midnight as "24".

export const CENTRAL_TZ = "America/Chicago";

export interface ZonedNow {
  /** Calendar date in the target zone, YYYY-MM-DD. */
  isoDate: string;
  /** Hour 0-23 in the target zone. */
  hour: number;
  /** Minute 0-59 in the target zone. */
  minute: number;
  /** Minutes past midnight in the target zone (hour * 60 + minute). */
  minutes: number;
}

function partsIn(timeZone: string, at: Date): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const out: Record<string, string> = {};
  for (const part of fmt.formatToParts(at)) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return out;
}

/** Wall-clock fields for `at` as observed in `timeZone`. Never parses a Date. */
export function zonedNow(timeZone: string, at: Date = new Date()): ZonedNow {
  const p = partsIn(timeZone, at);
  // % 24 is belt-and-braces against an h24-style "24" slipping through.
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  return {
    isoDate: `${p.year}-${p.month}-${p.day}`,
    hour,
    minute,
    minutes: hour * 60 + minute,
  };
}

/** Wall-clock fields for `at` in Central Time (Jetsetter's anchor zone). */
export function centralNow(at: Date = new Date()): ZonedNow {
  return zonedNow(CENTRAL_TZ, at);
}

/** Today's date in Central Time as YYYY-MM-DD. */
export function centralTodayISO(at: Date = new Date()): string {
  return centralNow(at).isoDate;
}

/** Central Time now as minutes past midnight. */
export function centralNowMinutes(at: Date = new Date()): number {
  return centralNow(at).minutes;
}

/** "Saturday, September 19" in Central Time, for user-facing copy. */
export function centralTodayHuman(at: Date = new Date()): string {
  return at.toLocaleDateString("en-US", {
    timeZone: CENTRAL_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** Render minutes-past-midnight as "7:30 PM". */
export function formatMinutes12(totalMinutes: number): string {
  const m = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const min = m % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}

/** Render an "HH:MM" 24h string as "7:30 PM". */
export function formatHHMM12(t: string): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return t;
  return formatMinutes12(h * 60 + m);
}

/**
 * How far the *device's* wall clock is ahead of Central, in minutes.
 * Eastern -> +60. Pacific -> -120. Central -> 0. Madrid -> +420 (CEST).
 *
 * Used to explain the picker to a PM whose phone or laptop is not on Central:
 * the dropdown lists Central times, so someone on Eastern who finished at
 * 7:30 PM by their own clock needs to select 6:30 PM here. Without that
 * explanation the time they are looking for simply appears to be missing.
 */
export function deviceMinutesAheadOfCentral(at: Date = new Date()): number {
  const central = centralNow(at);
  const deviceMinutes = at.getHours() * 60 + at.getMinutes();
  let diff = deviceMinutes - central.minutes;
  // Normalise across a midnight boundary into [-720, 720].
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  return diff;
}

/** The device's IANA timezone name, or "" when unavailable. */
export function deviceTimeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/** Human phrasing for an offset, e.g. "1 hour ahead of", "45 minutes behind". */
export function describeOffset(minutesAhead: number): string {
  if (minutesAhead === 0) return "the same as";
  const abs = Math.abs(minutesAhead);
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  const bits: string[] = [];
  if (hours) bits.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (mins) bits.push(`${mins} minute${mins === 1 ? "" : "s"}`);
  return `${bits.join(" ")} ${minutesAhead > 0 ? "ahead of" : "behind"}`;
}

/**
 * Grace window, in minutes, allowed past "now in Central" when validating or
 * capping a work-report time picker.
 *
 * Both the browser picker and the server gate MUST use this same value. When
 * they disagree the dropdown offers a time the server then rejects, which to
 * the PM looks like the app silently eating their hours.
 */
export const TIME_REPORT_CAP_GRACE_MINUTES = 15;
