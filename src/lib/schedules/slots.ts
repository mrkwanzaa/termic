// Slot math and the per-pass decision for recurring schedules (GH #300).
//
// Pure: no store, no IPC, no clock of its own. Everything takes `now`, which
// is what lets the runner's tests (and the e2e seam) drive a pass at any
// moment without waiting for 09:00.
//
// Local wall-clock time throughout, the same clock scheduled queue messages
// use (`localDateValue` in lib/scheduledQueue.ts). A slot is built with the
// `Date(y, m, d, h, min)` constructor, which is also the whole DST story:
//   - the hour that does not exist when clocks go forward is rolled forward
//     by `Date` (02:30 becomes 03:30), with no special code;
//   - the hour that repeats when clocks go back cannot fire twice, because a
//     day has ONE slot and a pass only acts on a slot later than `last_slot`.

import type { ScheduleCadence, TaskSchedule } from "@/lib/types";

/** A slot the runner first notices within this long still fires. The ticker
 *  runs once a minute and no timer runs while the Mac sleeps, so a Mac that
 *  wakes at 09:03 must still get its 09:00 run; later than this it is missed.
 *  The window trades a late wake against a 09:00 check arriving at 09:14. */
export const GRACE_MS = 15 * 60_000;

/** How far a walk over calendar days may go. A weekly cadence repeats within
 *  7 days; counting a missed streak walks further, and a schedule left
 *  unopened for over a year reports "missed" as at least this many. */
const MAX_WALK_DAYS = 400;

export function parseTime(t: string): { h: number; m: number } | null {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? { h, m: min } : null;
}

/** The slot on one local calendar day, or null when the cadence skips that
 *  day. The weekday test reads the CALENDAR day, not the rolled-forward
 *  time, so a DST gap can never move a slot onto another day's rule. */
export function slotOnDay(c: ScheduleCadence, y: number, mo: number, d: number): number | null {
  const t = parseTime(c.time);
  if (!t) return null;
  const dow = new Date(y, mo, d).getDay();
  if (c.kind === "weekdays" && (dow === 0 || dow === 6)) return null;
  if (c.kind === "weekly" && dow !== c.weekday) return null;
  return new Date(y, mo, d, t.h, t.m, 0, 0).getTime();
}

/** Calendar day `offset` days from the day `ms` falls on, as y/m/d. */
function dayAt(ms: number, offset: number): [number, number, number] {
  const base = new Date(ms);
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
  return [d.getFullYear(), d.getMonth(), d.getDate()];
}

/** The latest slot at or before `now`, or null when the cadence is broken. */
export function latestSlotAtOrBefore(c: ScheduleCadence, now: number): number | null {
  for (let i = 0; i <= 8; i++) {
    const s = slotOnDay(c, ...dayAt(now, -i));
    if (s != null && s <= now) return s;
  }
  return null;
}

/** The first slot strictly after `after`. */
export function nextSlotAfter(c: ScheduleCadence, after: number): number | null {
  for (let i = 0; i <= 8; i++) {
    const s = slotOnDay(c, ...dayAt(after, i));
    if (s != null && s > after) return s;
  }
  return null;
}

/** How many slots fall in `(after, upTo]`, capped by the walk. */
export function slotsBetween(c: ScheduleCadence, after: number, upTo: number): number {
  if (upTo <= after) return 0;
  let n = 0;
  for (let i = 0; i <= MAX_WALK_DAYS; i++) {
    const day = dayAt(after, i);
    const s = slotOnDay(c, ...day);
    if (s != null && s > after && s <= upTo) n++;
    if (new Date(day[0], day[1], day[2]).getTime() > upTo) break;
  }
  return n;
}

/** What `last_slot` starts as when a schedule is created, re-enabled or has
 *  its cadence edited: the latest slot that has already passed. So a schedule
 *  made at 10:00 for "daily 09:00" neither fires nor logs a miss for today. */
export function initialLastSlot(c: ScheduleCadence, now: number): number | null {
  return latestSlotAtOrBefore(c, now);
}

/** The local `YYYY-MM-DD` a report must be dated on or after to be kept for
 *  `days`, the cutoff `schedule_prune_reports` takes. Calendar arithmetic, so
 *  a DST day is still one day. Retention is local time like every slot. */
export function reportCutoff(now: number, days: number): string {
  const d = new Date(now);
  const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() - days);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${c.getFullYear()}-${p2(c.getMonth() + 1)}-${p2(c.getDate())}`;
}

/** What one pass does with one schedule. */
export type PassAction =
  | { kind: "none" }
  /** Run now. `missedBefore` is how many earlier slots a catch-up stands in
   *  for (they get a "missed" entry of their own). */
  | { kind: "fire"; slot: number; catchUp: boolean; missedBefore: number }
  /** The previous run is still going: record the slot as skipped (and any
   *  earlier slots in the same gap as missed). */
  | { kind: "skip"; slot: number; missedBefore: number }
  /** Outside the grace window and no catch-up: record `count` missed slots. */
  | { kind: "missed"; slot: number; count: number };

/** The decision for one schedule on one pass. `runActive` is whether the
 *  previous run is still working or waiting on input. A pass acts only on a
 *  slot later than `last_slot`, and every action other than "none" is
 *  followed by writing that slot to `last_slot`, so a slot is acted on once. */
export function decidePass(
  s: Pick<TaskSchedule, "enabled" | "cadence" | "catch_up" | "last_slot">,
  now: number,
  runActive: boolean,
  graceMs: number = GRACE_MS,
): PassAction {
  if (!s.enabled) return { kind: "none" };
  const latest = latestSlotAtOrBefore(s.cadence, now);
  if (latest == null) return { kind: "none" };
  if (s.last_slot != null && latest <= s.last_slot) return { kind: "none" };
  // Every slot nobody acted on, the latest included. A record that never got
  // a last_slot (it is written at creation, so this is defensive) counts one.
  const pending = s.last_slot == null ? 1 : Math.max(1, slotsBetween(s.cadence, s.last_slot, latest));
  if (now - latest <= graceMs) {
    // Earlier slots in the same gap were missed, but the latest is on time:
    // the latest still fires and the rest are recorded first.
    if (runActive) return { kind: "skip", slot: latest, missedBefore: pending - 1 };
    return { kind: "fire", slot: latest, catchUp: false, missedBefore: pending - 1 };
  }
  if (s.catch_up && !runActive) return { kind: "fire", slot: latest, catchUp: true, missedBefore: pending - 1 };
  return { kind: "missed", slot: latest, count: pending };
}
