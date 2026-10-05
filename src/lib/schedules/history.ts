// A schedule's history (GH #300): what became of each slot, newest LAST.
//
// Pure. The runner reads the result, compares, and writes the schedule back
// only when something moved; nothing here touches the store.

import type { ScheduleRun } from "@/lib/types";

/** Entries kept. Rust refuses more than 100, as a bound on a bug rather than
 *  a target. */
export const HISTORY_KEEP = 30;

/** Outcomes that mean the run may still be on screen and working. */
export const IN_FLIGHT: ReadonlySet<ScheduleRun["outcome"]> = new Set(["running", "needs_input"]);

/** Append `entry`. A missed entry right after another missed one merges into
 *  a single streak ("Missed 3 runs"): a silent skip looks like a broken
 *  schedule, and a weekend of separate misses is noise.
 *
 *  Then trims to HISTORY_KEEP, oldest first, but never drops an entry whose
 *  run task is still live: runs past `keep_runs` are found through these
 *  entries, so dropping one would leave its run unarchived forever. */
export function appendRun(
  history: readonly ScheduleRun[],
  entry: ScheduleRun,
  holdsLiveRun: (runTaskId: string) => boolean,
): ScheduleRun[] {
  const next = [...history];
  const last = next[next.length - 1];
  if (entry.outcome === "missed" && last?.outcome === "missed") {
    next[next.length - 1] = { ...last, slot: entry.slot, count: (last.count ?? 1) + (entry.count ?? 1) };
  } else {
    next.push(entry);
  }
  while (next.length > HISTORY_KEEP) {
    const i = next.findIndex(e => !(e.run_task_id && holdsLiveRun(e.run_task_id)));
    if (i < 0) break;
    next.splice(i, 1);
  }
  return next;
}

/** Patch the entry for one run. Returns null when there is no such entry or
 *  the patch changes nothing, so the caller writes nothing. */
export function updateRun(
  history: readonly ScheduleRun[],
  runTaskId: string,
  patch: Partial<ScheduleRun>,
): ScheduleRun[] | null {
  return patchEntry(history, e => e.run_task_id === runTaskId, patch);
}

/** Patch the NEWEST entry matching `match`; null when none matches or the
 *  patch changes nothing. */
export function patchEntry(
  history: readonly ScheduleRun[],
  match: (e: ScheduleRun) => boolean,
  patch: Partial<ScheduleRun>,
): ScheduleRun[] | null {
  let i = -1;
  for (let j = history.length - 1; j >= 0; j--) if (match(history[j])) { i = j; break; }
  if (i < 0) return null;
  const cur = history[i];
  const merged: ScheduleRun = { ...cur, ...patch };
  const keys = new Set([...Object.keys(cur), ...Object.keys(merged)]) as Set<keyof ScheduleRun>;
  if ([...keys].every(k => cur[k] === merged[k])) return null;
  const next = [...history];
  next[i] = merged;
  return next;
}

/** Run task ids past the newest `keep` live runs: the ones to archive. Only
 *  ids in the history are ever considered, never "any task this parent
 *  spawned", because the parent's own agent can spawn tasks through the CLI
 *  and those are not the scheduler's to archive. */
export function runsToArchive(
  history: readonly ScheduleRun[],
  keep: number,
  isLiveRun: (runTaskId: string) => boolean,
): string[] {
  const seen = new Set<string>();
  const live: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const id = history[i].run_task_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (isLiveRun(id)) live.push(id);
  }
  return live.slice(Math.max(0, keep));
}

/** Mark entries whose report retention just deleted. Null when none moved. */
export function markReportsGone(history: readonly ScheduleRun[], deletedNames: readonly string[]): ScheduleRun[] | null {
  if (deletedNames.length === 0) return null;
  const gone = new Set(deletedNames);
  let moved = false;
  const next = history.map(e => {
    if (!e.report || e.report_gone) return e;
    const name = e.report.slice(e.report.lastIndexOf("/") + 1);
    if (!gone.has(name)) return e;
    moved = true;
    return { ...e, report_gone: true };
  });
  return moved ? next : null;
}

/** The newest entry, the "last run" column. */
export function lastEntry(history: readonly ScheduleRun[]): ScheduleRun | undefined {
  return history[history.length - 1];
}
