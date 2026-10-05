// Building and editing a schedule record (GH #300). Pure.

import type { ScheduleCadence, TaskSchedule } from "@/lib/types";
import { initialLastSlot } from "@/lib/schedules/slots";
import { scheduleSlug } from "@/lib/schedules/runSpec";

/** What the create / edit dialog collects. */
export interface ScheduleInput {
  name: string;
  prompt?: string;
  prompt_id?: string;
  cadence: ScheduleCadence;
  catch_up: boolean;
  keep_runs: number;
  /** null = forever. */
  report_days: number | null;
}

export const DEFAULT_KEEP_RUNS = 7;
/** Rust's `MAX_KEEP_RUNS`: runs past N are found through the history, so N
 *  has to fit well inside it. */
export const MAX_KEEP_RUNS = 20;
export const DEFAULT_REPORT_DAYS = 30;
/** The retention choices the dialog offers; null is forever. */
export const REPORT_DAY_CHOICES: readonly (number | null)[] = [7, 30, 90, null];

const clean = (v: string | undefined) => (v && v.trim() ? v : undefined);

/** A new, enabled schedule. `last_slot` starts at the latest slot that has
 *  already passed, so creating one at 10:00 for 09:00 does nothing today.
 *  `takenSlugs` are the report folders other schedules in the project own. */
export function newSchedule(input: ScheduleInput, now: number, takenSlugs: Iterable<string>): TaskSchedule {
  return {
    enabled: true,
    name: input.name.trim(),
    slug: scheduleSlug(input.name, takenSlugs),
    prompt: clean(input.prompt),
    prompt_id: clean(input.prompt_id),
    cadence: normalizeCadence(input.cadence),
    catch_up: input.catch_up,
    keep_runs: input.keep_runs,
    report_days: input.report_days,
    last_slot: initialLastSlot(input.cadence, now),
    history: [],
  };
}

/** Apply an edit. The slug never changes (renaming does not strand the
 *  reports), and `last_slot` restarts from now whenever the cadence changes
 *  or a disabled schedule is turned back on: slots that passed under the old
 *  rule, or while it was off, are neither run nor reported as missed. */
export function editedSchedule(
  prev: TaskSchedule,
  patch: Partial<ScheduleInput> & { enabled?: boolean },
  now: number,
): TaskSchedule {
  const cadence = patch.cadence ? normalizeCadence(patch.cadence) : prev.cadence;
  const enabled = patch.enabled ?? prev.enabled;
  const cadenceMoved = !sameCadence(cadence, prev.cadence);
  const turnedOn = enabled && !prev.enabled;
  const next: TaskSchedule = {
    ...prev,
    name: patch.name !== undefined ? patch.name.trim() : prev.name,
    prompt: "prompt" in patch ? clean(patch.prompt) : prev.prompt,
    prompt_id: "prompt_id" in patch ? clean(patch.prompt_id) : prev.prompt_id,
    cadence,
    catch_up: patch.catch_up ?? prev.catch_up,
    keep_runs: patch.keep_runs ?? prev.keep_runs,
    report_days: patch.report_days !== undefined ? patch.report_days : prev.report_days,
    enabled,
  };
  if (cadenceMoved || turnedOn) next.last_slot = initialLastSlot(cadence, now);
  return next;
}

/** A weekday only means something on a weekly cadence. */
function normalizeCadence(c: ScheduleCadence): ScheduleCadence {
  return c.kind === "weekly" ? { kind: c.kind, time: c.time, weekday: c.weekday } : { kind: c.kind, time: c.time };
}

function sameCadence(a: ScheduleCadence, b: ScheduleCadence): boolean {
  return a.kind === b.kind && a.time === b.time && (a.kind !== "weekly" || a.weekday === b.weekday);
}

/** Structural equality that ignores key order and `undefined` members, so a
 *  record read from disk and the same one rebuilt by a spread compare equal.
 *  The runner writes nothing when this says nothing moved. */
export function sameSchedule(a: TaskSchedule | null | undefined, b: TaskSchedule | null | undefined): boolean {
  return canonical(a ?? null) === canonical(b ?? null);
}

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.keys(val as object)
          .filter(k => (val as Record<string, unknown>)[k] !== undefined)
          .sort()
          .map(k => [k, (val as Record<string, unknown>)[k]]),
      );
    }
    return val;
  });
}
