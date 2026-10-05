// When a scheduled run ends (GH #300): its outcome, its one notification, and
// the cleanup after it. The runner (lib/schedules/runner.ts) owns everything
// up to a delivered prompt and hands over through its hooks.
//
// What it watches is the run's own agent tab, in the store, through ONE
// subscription that costs a Map.size check on every store write while no run
// is in flight and an identity check per watched run otherwise. It never
// writes to the store on that path: every write is an outcome.
//
//   done        -> `fired` if the report file exists, else `no_report`; the
//                  run is stopped (unless it is on screen) and runs past
//                  keep_runs are archived, without the archive script.
//   attention   -> `needs_input`; the run stays live and stays watched, and a
//                  later done updates the same entry.
//   PTY exit    -> `fired` if it got as far as the report, else `failed`.
//   idle after working, with no done, while the run is ON SCREEN (a done
//                  the user acknowledged by watching it, or their own
//                  interrupt): resolved by the report file, but NOT stopped.
//                  Off screen an idle proves nothing (a respawn, or the
//                  20-minute ceiling, which claims nothing either), so the
//                  run stays in flight until a done, an exit or the user.
//   unmounted or archived by the user -> resolved by the report, never rung.
//
// One notification per run, through the same OS path and Settings switch as
// every other (`desktopNotifications`), and the generic done for a run's tab
// is muted (useAttentionNotifier asks `isRunInFlight`), so a run never rings
// twice. A missed or skipped slot never rings.

import { isTabOnScreenIn, isUserWatching, useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import * as ipc from "@/lib/ipc";
import { i18n } from "@/lib/i18n";
import { startArchive } from "@/lib/archiveTask";
import { agentTabFor } from "@/lib/agentDelivery";
import {
  initScheduleRunner, isRunInFlight, mutateSchedule, releaseRun, setRunHooks,
} from "@/lib/schedules/runner";
import { markReportsGone, patchEntry, runsToArchive, updateRun } from "@/lib/schedules/history";
import { reportCutoff } from "@/lib/schedules/slots";
import { stemOfReport } from "@/lib/schedules/runSpec";
import type { ReportStatus, ScheduleRun, Task } from "@/lib/types";

type AppState = ReturnType<typeof useApp.getState>;

/** A delivered run being watched for its end. */
interface Track {
  parentId: string;
  sawWorking: boolean;
  sawPty: boolean;
  needsInput: boolean;
  ending: boolean;
}
const tracks = new Map<string, Track>();
/** Runs that already rang. One notification per run, whatever happens next. */
const rang = new Set<string>();
/** Runs whose report this session already put in front of their agent tab. */
const reportOpened = new Set<string>();

let unsub: (() => void) | null = null;
let started = false;
/** Runs whose tab moved since the last evaluation, flushed in a microtask. */
const dirty = new Set<string>();
let flushQueued = false;

/** How a watched run stopped being watched. */
type Ending = "done" | "idle" | "exited" | "stopped";

function arm(runId: string, parentId: string): void {
  tracks.set(runId, { parentId, sawWorking: false, sawPty: false, needsInput: false, ending: false });
  // The agent may have worked and finished before the delivery returned.
  markDirty(runId);
}

function onStore(state: AppState, prev: AppState): void {
  if (tracks.size > 0 && (state.tabs !== prev.tabs || state.mountedTasks !== prev.mountedTasks || state.tasks !== prev.tasks)) {
    for (const [runId, t] of tracks) {
      if (state.tabs[runId] === prev.tabs[runId] && state.mountedTasks === prev.mountedTasks && state.tasks === prev.tasks) continue;
      // What the run has been through is recorded on every write; only the
      // DECISION waits for the burst to settle (markDirty).
      const tab = agentTabFor(runId);
      if (tab?.ptyId) t.sawPty = true;
      if (tab?.workState === "working") t.sawWorking = true;
      markDirty(runId);
    }
  }
  if (state.activeTaskId !== prev.activeTaskId && state.activeTaskId) maybeOpenReport(state.activeTaskId);
}

/** Evaluate after the current synchronous burst, never inside it. One agent
 *  event can be several store writes in a row: `goAttention` sets `done` and
 *  only then marks the attention, so a run judged on the first write would be
 *  closed as finished a moment before it asked its question. */
function markDirty(runId: string): void {
  dirty.add(runId);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    const state = useApp.getState();
    for (const id of [...dirty]) {
      dirty.delete(id);
      evaluate(id, state);
    }
  });
}

function evaluate(runId: string, state: AppState): void {
  const t = tracks.get(runId);
  if (!t || t.ending) return;
  const task = state.tasks.find(x => x.id === runId);
  if (!task || task.archived || !state.mountedTasks.has(runId)) {
    void end(runId, "stopped");
    return;
  }
  const tab = agentTabFor(runId);
  if (!tab) return;
  if (tab.ptyId) t.sawPty = true;
  // Attention first: a mark does not touch workState, so an agent blocked on
  // the user can still read as working (or as done, when a title-driven done
  // lands just before its hook). Being blocked on the user is the stronger
  // fact, and ending the run on it would throw the question away.
  if (tab.unread?.reason === "attention") {
    if (!t.needsInput) {
      t.needsInput = true;
      void needsInput(runId, t.parentId);
    }
    return;
  }
  if (tab.workState === "working") {
    t.sawWorking = true;
    return;
  }
  if (tab.workState === "done") return void end(runId, "done");
  if (tab.unread?.reason === "exit" || (t.sawPty && !tab.ptyId)) return void end(runId, "exited");
  if (t.sawWorking && isTabOnScreenIn(state, runId)) void end(runId, "idle");
}

async function needsInput(runId: string, parentId: string): Promise<void> {
  await mutateSchedule(parentId, cur => {
    const h = updateRun(cur.history, runId, { outcome: "needs_input" });
    return h ? { ...cur, history: h } : null;
  });
  ring(runId, parentId, i18n.t("backend:schedules.notifyNeedsInput"), false);
}

async function end(runId: string, how: Ending): Promise<void> {
  const t = tracks.get(runId);
  if (!t || t.ending) return;
  t.ending = true;
  try {
    const parent = useApp.getState().tasks.find(p => p.id === t.parentId);
    const s = parent?.schedule;
    const entry = s?.history.find(e => e.run_task_id === runId);
    if (parent && s && entry) {
      const status = await reportOf(parent, entry);
      const patch: Partial<ScheduleRun> = status?.path
        ? { outcome: "fired", report: status.path, title: status.title ?? undefined }
        : how === "done" || how === "idle"
          ? { outcome: "no_report" }
          : { outcome: "failed", error: how };
      await mutateSchedule(t.parentId, cur => {
        const h = updateRun(cur.history, runId, patch);
        return h ? { ...cur, history: h } : null;
      });
      if (how !== "stopped") {
        const body = patch.outcome === "fired" ? i18n.t("backend:schedules.notifyReportReady")
          : patch.outcome === "no_report" ? i18n.t("backend:schedules.notifyNoReport")
          : i18n.t("backend:schedules.notifyExited");
        ring(runId, t.parentId, body, patch.outcome !== "failed");
      }
    }
    // A run stops when it is DONE, to free its agent and scrollback: a month
    // of a collapsed daily schedule would otherwise be thirty idle agents.
    // Never the run on screen (stopping it would throw the user to the
    // dashboard), and never on a mere idle, which claimed nothing.
    const st = useApp.getState();
    if (how === "done" && st.mountedTasks.has(runId) && !isTabOnScreenIn(st, runId)) st.stopTask(runId);
  } finally {
    tracks.delete(runId);
    releaseRun(runId);
  }
  await afterRun(t.parentId);
}

/** Did the run write its report, and what is it called. */
async function reportOf(parent: Task, entry: ScheduleRun): Promise<ReportStatus | null> {
  const stem = stemOfReport(entry.report);
  if (!stem || !parent.schedule) return null;
  return ipc.scheduleReportStatus(parent.project_id, parent.schedule.slug, stem).catch(() => null);
}

/** The one notification for a run: behind the Settings switch, and not for
 *  the task the user is looking at. The title is the schedule's name. */
function ring(runId: string, parentId: string, body: string, sound: boolean): void {
  if (rang.has(runId)) return;
  rang.add(runId);
  if (!usePrefs.getState().desktopNotifications) return;
  if (isUserWatching(runId)) return;
  const name = useApp.getState().tasks.find(p => p.id === parentId)?.schedule?.name ?? "";
  ipc.notify(name, body, { taskId: runId, tabId: agentTabFor(runId)?.id ?? "" }, { sound }).catch(() => {});
}

/** The prompt never landed. The runner already wrote `failed`; say so once,
 *  and stop the agent it left sitting at an empty prompt. */
function onDeliveryFailed(runId: string, parentId: string, error: string): void {
  ring(runId, parentId, i18n.t("backend:schedules.notifyFailed", { error }), false);
  const st = useApp.getState();
  if (st.mountedTasks.has(runId) && !isTabOnScreenIn(st, runId)) st.stopTask(runId);
  void afterRun(parentId);
}

/** After any run: archive runs past keep_runs and apply report retention. */
async function afterRun(parentId: string): Promise<void> {
  const st = useApp.getState();
  const parent = st.tasks.find(p => p.id === parentId);
  const s = parent?.schedule;
  if (!parent || !s) return;
  const live = (id: string) => {
    const t = useApp.getState().tasks.find(x => x.id === id);
    return !!t && !t.archived;
  };
  const old = runsToArchive(s.history, s.keep_runs, live)
    .filter(id => id !== useApp.getState().activeTaskId && !isRunInFlight(id));
  // Without the archive script: a run is a main-checkout task that never ran
  // a setup script, and the project's archive script would run in the live
  // checkout every morning.
  for (const id of old) await startArchive(id, false, true).catch(() => {});
  await pruneReports(parent);
}

/** Retention: delete this schedule's reports past `report_days`. Writes the
 *  history only when a file actually went. */
async function pruneReports(parent: Task, now: number = Date.now()): Promise<void> {
  const s = parent.schedule;
  if (!s || s.report_days == null) return;
  const deleted = await ipc.schedulePruneReports(parent.project_id, s.slug, reportCutoff(now, s.report_days))
    .catch(() => [] as string[]);
  if (deleted.length === 0) return;
  await mutateSchedule(parent.id, cur => {
    const h = markReportsGone(cur.history, deleted);
    return h ? { ...cur, history: h } : null;
  });
}

/** Entries a previous session left `running` (Termic quit, or the webview
 *  reloaded, mid-run): nothing is watching them now. One that got as far as
 *  its report is `fired`; anything else failed because Termic quit. */
async function reconcileAtLaunch(): Promise<void> {
  for (const parent of useApp.getState().tasks) {
    const s = parent.schedule;
    if (!s || !s.history.some(e => e.outcome === "running")) continue;
    const found = new Map<string, ReportStatus | null>();
    for (const e of s.history) {
      if (e.outcome === "running" && e.run_task_id) found.set(e.run_task_id, await reportOf(parent, e));
    }
    await mutateSchedule(parent.id, cur => {
      let h = cur.history;
      for (let i = 0; i < h.length; i++) {
        const e = h[i];
        if (e.outcome !== "running") continue;
        const st = e.run_task_id ? found.get(e.run_task_id) : null;
        const patch: Partial<ScheduleRun> = st?.path
          ? { outcome: "fired", report: st.path, title: st.title ?? undefined }
          : { outcome: "failed", error: "quit" };
        h = patchEntry(h, x => x === e, patch) ?? h;
      }
      return h === cur.history ? null : { ...cur, history: h };
    });
  }
}

/** Retention also runs once at launch, for every schedule on a live parent,
 *  disabled ones included, so their reports age out too. One at a time. */
async function pruneAllAtLaunch(): Promise<void> {
  for (const parent of useApp.getState().tasks) {
    if (parent.schedule && !parent.archived) await pruneReports(parent);
  }
}

/** Opening a finished run puts its Markdown report in front of the agent tab,
 *  rendered, once per run per session. An HTML report is never opened in
 *  Termic's webview, which sits outside the sandbox (docs/sandbox.md, "Known
 *  gap"); the Scheduled view links it to the browser instead. */
function maybeOpenReport(taskId: string): void {
  if (reportOpened.has(taskId)) return;
  const st = useApp.getState();
  const run = st.tasks.find(t => t.id === taskId);
  if (!run?.spawned_by) return;
  const e = st.tasks.find(t => t.id === run.spawned_by)?.schedule?.history.find(h => h.run_task_id === taskId);
  if (!e || e.outcome !== "fired" || !e.report || e.report_gone || !e.report.endsWith(".md")) return;
  reportOpened.add(taskId);
  const path = e.report;
  // Next task, not inside the activation: a sidebar row's click selects the
  // task and THEN restores the tab it last had in front, in the same handler,
  // which would put the agent tab straight back over the report.
  // After the agent tab exists. A preview tab opened first would count as a
  // main tab, and ensureDefaultTab bails on any main tab, so the run's agent
  // would never be restored (docs/gotchas.md, "A durable tab is only restored
  // by a WAKE").
  whenAgentTab(taskId, () => window.setTimeout(() => {
    const app = useApp.getState();
    app.openPreviewTab(taskId, { type: "edit", path, title: path.slice(path.lastIndexOf("/") + 1) });
    const tab = (useApp.getState().tabs[taskId] ?? []).find(t => t.type === "edit" && (t as { path?: string }).path === path);
    if (tab) app.patchTab(taskId, tab.id, { mdView: "preview" });
  }, 0));
}

function whenAgentTab(taskId: string, fn: () => void): void {
  const has = (s: AppState) => (s.tabs[taskId] ?? []).some(t => t.type === "terminal");
  if (has(useApp.getState())) return fn();
  let timer = 0;
  const stop = useApp.subscribe(s => {
    if (!has(s)) return;
    stop();
    window.clearTimeout(timer);
    fn();
  });
  timer = window.setTimeout(stop, 10_000);
}

/** Start schedules: the end-of-run watcher, the launch reconciliation, then
 *  the runner's clock, then retention in the background. Idempotent; called
 *  from App once `loadAll` resolved. */
export async function initSchedules(): Promise<void> {
  if (started) return;
  started = true;
  setRunHooks({ delivered: arm, failed: onDeliveryFailed });
  unsub = useApp.subscribe(onStore);
  await reconcileAtLaunch().catch(e => console.warn("[schedules] reconcile failed", e));
  initScheduleRunner();
  void pruneAllAtLaunch();
}

/** Test seam. */
export const __scheduleWatcherForTests = {
  reconcileAtLaunch,
  pruneAllAtLaunch,
  watched: () => [...tracks.keys()],
  reset(): void {
    unsub?.();
    unsub = null;
    started = false;
    tracks.clear();
    dirty.clear();
    flushQueued = false;
    rang.clear();
    reportOpened.clear();
  },
  start(): void {
    setRunHooks({ delivered: arm, failed: onDeliveryFailed });
    unsub = useApp.subscribe(onStore);
  },
};
