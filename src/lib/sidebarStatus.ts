// The sidebar's status section: which tasks it lists, under which bucket, in
// which order (docs/ui.md "The sidebar's status section").
//
// A bucket IS a board column. Every task's bucket comes from
// boardColumnFromFacts, the precedence the Kanban board uses, so the two
// surfaces cannot disagree; a bucket that looks wrong here is a change to
// taskBoardState.ts, and the board moves with it. Nothing is stored.
//
// Pure and store-free on purpose (the pr store's import chain touches the DOM
// at module scope): the caller passes the PR snapshot in as plain data.

import type { Project, Task } from "./types";
import { visualProjectOrder } from "./projectGroups";
import { crossProjectStrays, flattenSegments, layoutTaskList } from "./taskGroups";
import {
  boardColumnFromFacts,
  type BoardPrInfo,
  type BoardStateColumn,
  type BoardTaskFacts,
} from "./taskBoardState";
import type { WorkStatePrefs } from "./taskWorkState";

/** Display order: attention first, because it is the reason the section
 *  exists, then the lifecycle. Archived is not a bucket: it lives in History
 *  and on the board. */
export const STATUS_BUCKETS = ["attention", "working", "review", "settled", "backlog"] as const satisfies readonly BoardStateColumn[];
export type StatusBucket = (typeof STATUS_BUCKETS)[number];

/** The two buckets that show a count and nothing else until opened: Settled
 *  is the largest and least urgent, and Not started is session-scoped (after
 *  a relaunch every unopened task sits there), so both are mostly noise. */
const COUNT_ONLY: ReadonlySet<StatusBucket> = new Set(["settled", "backlog"]);

export function statusBucketCollapsedByDefault(bucket: StatusBucket): boolean {
  return COUNT_ONLY.has(bucket);
}

/** Only the buckets the user has toggled are stored; the rest follow
 *  statusBucketCollapsedByDefault. */
export type StatusBucketCollapsed = Readonly<Partial<Record<StatusBucket, boolean>>>;

export function isStatusBucketCollapsed(bucket: StatusBucket, overrides: StatusBucketCollapsed): boolean {
  return overrides[bucket] ?? statusBucketCollapsedByDefault(bucket);
}

/** Parsed defensively because it comes back from localStorage: anything that
 *  is not a known bucket with a boolean is dropped, so a hand-edited or
 *  future value falls back to the default instead of rendering nonsense. */
export function parseStatusBucketCollapsed(raw: string | null | undefined): StatusBucketCollapsed {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Partial<Record<StatusBucket, boolean>> = {};
  for (const b of STATUS_BUCKETS) {
    const v = (parsed as Record<string, unknown>)[b];
    if (typeof v === "boolean") out[b] = v;
  }
  return out;
}

/** A task whose tabs never loaded this session: no evidence of anything, the
 *  same reading the board gives `EMPTY_TABS`. */
const UNLOADED: BoardTaskFacts = Object.freeze({ attention: false, working: false, untouched: true });

export interface StatusBucketGroup {
  bucket: StatusBucket;
  tasks: Task[];
}

/** The section's contents: non-empty buckets in display order, each holding
 *  its tasks in TREE order: the sidebar's visual project order (which the
 *  keyboard walks too), then each project's rows as the tree lays them out,
 *  a task group drawn as one block at its first member's position. A row
 *  therefore never shuffles inside its bucket; it moves only when its
 *  bucket changes.
 *
 *  Walks projects rather than tasks, so a task whose project is not in this
 *  profile's list is skipped exactly as the tree skips it. */
export function statusBuckets(
  projects: Project[],
  tasks: Task[],
  facts: Readonly<Record<string, BoardTaskFacts>>,
  prByTask: Readonly<Record<string, { lookup: BoardPrInfo | null } | undefined>>,
  prefs: WorkStatePrefs,
): StatusBucketGroup[] {
  const byProject = new Map<string, Task[]>();
  for (const w of tasks) {
    if (w.archived) continue;
    const list = byProject.get(w.project_id);
    if (list) list.push(w);
    else byProject.set(w.project_id, [w]);
  }
  // The tree's own layout: the same strays it draws as plain rows (a legacy
  // cross-project group), and the same grouping for everything else.
  const strays = crossProjectStrays(tasks);
  const groupFor = (t: Task) => (strays.has(t.id) ? null : t.group ?? null);
  const buckets = new Map<StatusBucket, Task[]>(STATUS_BUCKETS.map(b => [b, []]));
  for (const p of visualProjectOrder(projects)) {
    for (const w of flattenSegments(layoutTaskList(byProject.get(p.id) ?? [], groupFor))) {
      const column = boardColumnFromFacts(w, facts[w.id] ?? UNLOADED, prByTask[w.id]?.lookup ?? null, prefs);
      // Unreachable (archived tasks were skipped above), but the type allows
      // it, and dropping a task is better than inventing a bucket for it.
      if (column === "archived") continue;
      buckets.get(column)!.push(w);
    }
  }
  return STATUS_BUCKETS
    .map(bucket => ({ bucket, tasks: buckets.get(bucket)! }))
    .filter(g => g.tasks.length > 0);
}
