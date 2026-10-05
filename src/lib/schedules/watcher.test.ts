// @vitest-environment happy-dom
//
// What happens when a scheduled run ends. Runs are started through the REAL
// runner (Run now), so the hand-over from a delivered prompt to the watcher
// is the production one; the agent's states are written into the real store
// the way TerminalPane writes them.
import { describe, it, expect, vi, beforeEach } from "vitest";

const disk = vi.hoisted(() => ({ tasks: [] as import("@/lib/types").Task[], seq: 0 }));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

vi.mock("@/lib/ipc", () => ({
  tasksList: vi.fn(async () => clone(disk.tasks)),
  taskOpenRepo: vi.fn(async (projectId: string, cli: string, name: string) => {
    const t = {
      id: `run-${++disk.seq}`, project_id: projectId, name, cli, branch: "main", base_branch: "main",
      path: "/Users/u/web", port: 18100, created: "", archived: false, is_main_checkout: true,
    };
    disk.tasks.push(t as never);
    return clone(t);
  }),
  taskSetSchedule: vi.fn(async (id: string, schedule: unknown) => {
    const t = disk.tasks.find(x => x.id === id)!;
    if (schedule) t.schedule = clone(schedule) as never; else delete t.schedule;
  }),
  taskSetAccount: vi.fn(async () => {}),
  taskLinkSpawn: vi.fn(async (child: string, parent: string) => {
    disk.tasks.find(x => x.id === child)!.spawned_by = parent;
  }),
  scheduleReportStatus: vi.fn(async () => ({ path: null, title: null })),
  schedulePruneReports: vi.fn(async () => []),
  notify: vi.fn(async () => {}),
  taskSetTabs: vi.fn(async () => {}),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/agentDelivery", async (orig) => ({
  ...(await orig<object>()),
  waitForAgentPty: vi.fn().mockResolvedValue(true),
  deliverPromptWhenReady: vi.fn().mockResolvedValue({ ok: true, tabId: "agent" }),
}));
vi.mock("@/lib/archiveTask", () => ({ startArchive: vi.fn(async () => {}) }));
vi.mock("@/lib/previewBrowser", () => ({ openWebUrlForProject: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

import * as ipc from "@/lib/ipc";
import { deliverPromptWhenReady } from "@/lib/agentDelivery";
import { startArchive } from "@/lib/archiveTask";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";
import { __resetScheduleRunnerForTests, isRunInFlight, runScheduleNow, scheduleTickNow } from "@/lib/schedules/runner";
import { IDLE_SETTLE_MS, __scheduleWatcherForTests as W } from "@/lib/schedules/watcher";
import { openWebUrlForProject } from "@/lib/previewBrowser";
import type { ScheduleRun, Task, TaskSchedule, TerminalTab } from "@/lib/types";

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
const REPORT = { path: ".termic/schedules/grafana-check/2026-10-02_1400.md", title: "All green" };

function schedule(extra: Partial<TaskSchedule> = {}): TaskSchedule {
  return {
    enabled: true, name: "grafana check", slug: "grafana-check", prompt: "check",
    cadence: { kind: "daily", time: "09:00" }, catch_up: false, keep_runs: 7, report_days: null,
    last_slot: 0, history: [], ...extra,
  };
}

function seed(s: TaskSchedule = schedule(), extraTasks: Task[] = []) {
  disk.seq = 0;
  disk.tasks = [{
    id: "parent", project_id: "p1", name: "grafana check", branch: "main", base_branch: "main",
    path: "/Users/u/web", cli: "claude", port: 18100, created: "", archived: false, is_main_checkout: true,
    schedule: s,
  } as Task, ...extraTasks];
  useApp.setState({
    tasks: clone(disk.tasks),
    projects: [{ id: "p1", name: "web", root_path: "/Users/u/web" } as never],
    agents: [{ id: "claude", name: "Claude Code" }] as never,
    mountedTasks: new Set<string>(),
    activeTaskId: null,
    tabs: {},
    loadAll: async () => { useApp.setState({ tasks: clone(disk.tasks) }); },
  } as never);
}

const entry = (runId: string): ScheduleRun | undefined =>
  useApp.getState().tasks.find(t => t.id === "parent")!.schedule!.history.find(e => e.run_task_id === runId);

/** Start a run through Run now and give it an agent tab with a live PTY. */
async function startRun(): Promise<string> {
  const r = await runScheduleNow("parent", new Date(2026, 9, 2, 14).getTime());
  if (r.kind !== "started") throw new Error(`run did not start: ${JSON.stringify(r)}`);
  const tab = { id: "agent", type: "terminal", cli: "claude", title: "claude", is_default: true, ptyId: "pty-1" };
  useApp.setState(s => ({ tabs: { ...s.tabs, [r.runId]: [tab as never] } }));
  await flush();
  return r.runId;
}

const agent = (runId: string, patch: Partial<TerminalTab>) => useApp.getState().patchTab(runId, "agent", patch);

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps a test's mockResolvedValue; put the defaults back.
  vi.mocked(ipc.scheduleReportStatus).mockResolvedValue({ path: null, title: null });
  vi.mocked(ipc.schedulePruneReports).mockResolvedValue([]);
  __resetScheduleRunnerForTests();
  W.reset();
  W.start();
  seed();
  usePrefs.setState({ desktopNotifications: true } as never);
  useUI.setState({ windowless: false, windowFocused: true } as never);
});

describe("a run that finishes", () => {
  it("with its report: fired, titled, rung once with a sound, stopped and released", async () => {
    vi.mocked(ipc.scheduleReportStatus).mockResolvedValue(REPORT);
    const runId = await startRun();
    expect(W.watched()).toEqual([runId]);
    agent(runId, { workState: "working" });
    agent(runId, { workState: "done", unread: { reason: "done" } as never });
    // Still in flight on the very write that carries the done, which is what
    // keeps the generic "finished" banner (useAttentionNotifier) muted.
    expect(isRunInFlight(runId)).toBe(true);
    await flush();
    expect(entry(runId)).toMatchObject({ outcome: "fired", report: REPORT.path, title: "All green" });
    expect(ipc.notify).toHaveBeenCalledTimes(1);
    expect(ipc.notify).toHaveBeenCalledWith("grafana check", "Report ready", { taskId: runId, tabId: "agent" }, { sound: true });
    expect(useApp.getState().mountedTasks.has(runId)).toBe(false);
    expect(isRunInFlight(runId)).toBe(false);
    expect(W.watched()).toEqual([]);
  });

  it("without its report: no_report, and the right message", async () => {
    const runId = await startRun();
    agent(runId, { workState: "working" });
    agent(runId, { workState: "done" });
    await flush();
    expect(entry(runId)?.outcome).toBe("no_report");
    expect(ipc.notify).toHaveBeenCalledWith("grafana check", "Finished without a report", expect.anything(), { sound: true });
  });

  it("is not stopped while it is the task on screen", async () => {
    const runId = await startRun();
    useApp.setState({ activeTaskId: runId } as never);
    agent(runId, { workState: "working" });
    agent(runId, { workState: "done" });
    await flush();
    expect(useApp.getState().mountedTasks.has(runId)).toBe(true);
    expect(isRunInFlight(runId)).toBe(false);
  });

  it("does not ring when notifications are off, and still records the outcome", async () => {
    usePrefs.setState({ desktopNotifications: false } as never);
    const runId = await startRun();
    agent(runId, { workState: "working" });
    agent(runId, { workState: "done" });
    await flush();
    expect(ipc.notify).not.toHaveBeenCalled();
    expect(entry(runId)?.outcome).toBe("no_report");
  });

  it("ignores a done that predates the prompt: only an armed run is watched", async () => {
    vi.mocked(deliverPromptWhenReady).mockImplementationOnce(() => new Promise(() => {}));
    const runId = (await runScheduleNow("parent", Date.now()) as { runId: string }).runId;
    useApp.setState(s => ({ tabs: { ...s.tabs, [runId]: [{ id: "agent", type: "terminal", cli: "claude", is_default: true, ptyId: "p", workState: "done" } as never] } }));
    await flush();
    expect(entry(runId)?.outcome).toBe("running");
    expect(W.watched()).toEqual([]);
  });
});

describe("a run that needs input", () => {
  it("is recorded and rung once, stays live, keeps the overlap lock, and a later done settles it", async () => {
    vi.mocked(ipc.scheduleReportStatus).mockResolvedValue(REPORT);
    const runId = await startRun();
    agent(runId, { workState: "working" });
    agent(runId, { workState: "idle", unread: { reason: "attention" } as never });
    await flush();
    expect(entry(runId)?.outcome).toBe("needs_input");
    expect(ipc.notify).toHaveBeenCalledWith("grafana check", "Needs your input", expect.anything(), { sound: false });
    expect(useApp.getState().mountedTasks.has(runId)).toBe(true);
    expect(isRunInFlight(runId)).toBe(true);
    expect(await runScheduleNow("parent")).toEqual({ kind: "busy" });

    agent(runId, { unread: null, workState: "working" });
    agent(runId, { workState: "done" });
    await flush();
    expect(entry(runId)?.outcome).toBe("fired");
    expect(ipc.notify).toHaveBeenCalledTimes(1);
    expect(isRunInFlight(runId)).toBe(false);
  });
});

describe("a run that ends any other way", () => {
  it("an agent that exits without a done fails and rings", async () => {
    const runId = await startRun();
    agent(runId, { workState: "working" });
    agent(runId, { workState: undefined, ptyId: undefined, unread: { reason: "exit" } as never });
    await flush();
    expect(entry(runId)).toMatchObject({ outcome: "failed", error: "exited" });
    expect(ipc.notify).toHaveBeenCalledWith("grafana check", "The agent exited before it finished", expect.anything(), { sound: false });
    expect(isRunInFlight(runId)).toBe(false);
  });

  it("a run the user stops is resolved by its report and never rung", async () => {
    const runId = await startRun();
    agent(runId, { workState: "working" });
    useApp.getState().stopTask(runId);
    await flush();
    expect(entry(runId)).toMatchObject({ outcome: "failed", error: "stopped" });
    expect(ipc.notify).not.toHaveBeenCalled();
    expect(isRunInFlight(runId)).toBe(false);
  });

  it("idle after working ON screen (a done the user watched) is settled by the report but left running", async () => {
    vi.mocked(ipc.scheduleReportStatus).mockResolvedValue(REPORT);
    const runId = await startRun();
    useApp.setState({ activeTaskId: runId } as never);
    agent(runId, { workState: "working" });
    agent(runId, { workState: "idle" });
    await flush();
    expect(entry(runId)?.outcome).toBe("fired");
    expect(useApp.getState().mountedTasks.has(runId)).toBe(true);
  });

  it("idle off screen for IDLE_SETTLE_MS settles on the minute tick, without stopping the run", async () => {
    // Disabled: these passes are only here for the tick, never to fire a slot.
    seed(schedule({ enabled: false }));
    vi.mocked(ipc.scheduleReportStatus).mockResolvedValue(REPORT);
    const runId = await startRun();
    agent(runId, { workState: "working" });
    agent(runId, { workState: "idle" }); // the ceiling cleared the spinner
    await flush();
    // A tick inside the window does nothing.
    await scheduleTickNow(Date.now() + IDLE_SETTLE_MS - 5_000);
    await flush();
    expect(entry(runId)?.outcome).toBe("running");
    await scheduleTickNow(Date.now() + IDLE_SETTLE_MS + 1_000);
    await flush();
    expect(entry(runId)?.outcome).toBe("fired");
    expect(isRunInFlight(runId)).toBe(false);
    expect(useApp.getState().mountedTasks.has(runId)).toBe(true);
  });

  it("working again restarts the idle clock", async () => {
    // Disabled: these passes are only here for the tick, never to fire a slot.
    seed(schedule({ enabled: false }));
    const runId = await startRun();
    agent(runId, { workState: "working" });
    agent(runId, { workState: "idle" });
    await flush();
    await new Promise(r => setTimeout(r, 5));
    agent(runId, { workState: "working" });
    await flush();
    await scheduleTickNow(Date.now() + IDLE_SETTLE_MS + 1_000);
    await flush();
    expect(entry(runId)?.outcome).toBe("running");
    expect(isRunInFlight(runId)).toBe(true);
  });

  it("idle after working OFF screen proves nothing: the run waits for its done", async () => {
    const runId = await startRun();
    agent(runId, { workState: "working" });
    agent(runId, { workState: "idle" }); // a respawn, or the ceiling
    await flush();
    expect(entry(runId)?.outcome).toBe("running");
    expect(isRunInFlight(runId)).toBe(true);
    agent(runId, { workState: "working" });
    agent(runId, { workState: "done" });
    await flush();
    expect(entry(runId)?.outcome).toBe("no_report");
  });

  it("a done written just before its attention mark is a question, not a finish", async () => {
    // goAttention's order: setWorkState("done"), then markAttention, in one call.
    const runId = await startRun();
    agent(runId, { workState: "working" });
    useApp.getState().setWorkState(runId, "agent", "done", "attention: hook");
    useApp.getState().markAttention(runId, "agent", "attention");
    await flush();
    expect(entry(runId)?.outcome).toBe("needs_input");
    expect(useApp.getState().mountedTasks.has(runId)).toBe(true);
    expect(isRunInFlight(runId)).toBe(true);
  });

  it("a prompt that never lands rings once and stops the idle agent", async () => {
    vi.mocked(deliverPromptWhenReady).mockResolvedValueOnce({ ok: false, error: "the agent PTY never spawned" });
    const r = await runScheduleNow("parent", Date.now());
    const runId = (r as { runId: string }).runId;
    await flush();
    expect(entry(runId)).toMatchObject({ outcome: "failed", error: "the agent PTY never spawned" });
    expect(ipc.notify).toHaveBeenCalledWith(
      "grafana check", "The run did not start: the agent PTY never spawned", expect.anything(), { sound: false },
    );
    expect(useApp.getState().mountedTasks.has(runId)).toBe(false);
  });
});

describe("after a run", () => {
  it("archives runs past keep_runs, without the archive script, never the one on screen", async () => {
    const old = (n: number): Task => ({ id: `old-${n}`, project_id: "p1", name: `old ${n}`, archived: false } as Task);
    const history: ScheduleRun[] = [1, 2, 3].map(n => ({ slot: n, outcome: "fired", run_task_id: `old-${n}` }));
    seed(schedule({ keep_runs: 2, history }), [old(1), old(2), old(3)]);
    useApp.setState({ activeTaskId: "old-1" } as never);
    const runId = await startRun();
    agent(runId, { workState: "working" });
    agent(runId, { workState: "done" });
    await flush();
    // Newest two live runs are the new one and old-3; old-2 goes, old-1 is on screen.
    expect(vi.mocked(startArchive).mock.calls).toEqual([["old-2", false, true]]);
  });

  it("applies retention and marks the entries whose report went", async () => {
    const history: ScheduleRun[] = [{ slot: 1, outcome: "fired", run_task_id: "gone", report: ".termic/schedules/grafana-check/2026-08-01_0900.md" }];
    seed(schedule({ report_days: 30, history }));
    vi.mocked(ipc.schedulePruneReports).mockResolvedValueOnce(["2026-08-01_0900.md"]);
    const runId = await startRun();
    agent(runId, { workState: "working" });
    agent(runId, { workState: "done" });
    await flush();
    expect(ipc.schedulePruneReports).toHaveBeenCalledWith("p1", "grafana-check", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(useApp.getState().tasks.find(t => t.id === "parent")!.schedule!.history[0].report_gone).toBe(true);
  });

  it("keeps reports forever when retention is off", async () => {
    const runId = await startRun();
    agent(runId, { workState: "working" });
    agent(runId, { workState: "done" });
    await flush();
    expect(ipc.schedulePruneReports).not.toHaveBeenCalled();
  });
});

describe("at launch", () => {
  it("resolves runs a previous session left running, and writes nothing when there are none", async () => {
    vi.mocked(ipc.scheduleReportStatus).mockImplementation(async (_p, _s, stem) =>
      stem === "2026-10-01_0900" ? REPORT : { path: null, title: null });
    seed(schedule({
      history: [
        { slot: 1, outcome: "running", run_task_id: "a", report: ".termic/schedules/grafana-check/2026-10-01_0900.md" },
        { slot: 2, outcome: "running", run_task_id: "b", report: ".termic/schedules/grafana-check/2026-10-02_0900.md" },
        { slot: 3, outcome: "running", report: ".termic/schedules/grafana-check/2026-10-03_0900.md" },
      ],
    }));
    await W.reconcileAtLaunch();
    const h = useApp.getState().tasks.find(t => t.id === "parent")!.schedule!.history;
    expect(h.map(e => [e.outcome, e.error ?? null])).toEqual([["fired", null], ["failed", "quit"], ["failed", "quit"]]);

    vi.mocked(ipc.taskSetSchedule).mockClear();
    await W.reconcileAtLaunch();
    expect(ipc.taskSetSchedule).not.toHaveBeenCalled();
  });

  it("prunes every live schedule once, disabled ones included, and writes nothing when nothing went", async () => {
    seed(schedule({ enabled: false, report_days: 7 }));
    await W.pruneAllAtLaunch();
    expect(ipc.schedulePruneReports).toHaveBeenCalledTimes(1);
    expect(ipc.taskSetSchedule).not.toHaveBeenCalled();
  });
});

describe("opening a finished run", () => {
  const fired = (report: string): ScheduleRun => ({ slot: 1, outcome: "fired", run_task_id: "r1", report });
  const run = { id: "r1", project_id: "p1", name: "grafana check 2026-10-02 09:00", spawned_by: "parent", archived: false } as Task;

  it("puts a Markdown report in front of the agent tab, rendered, once", async () => {
    seed(schedule({ history: [fired(".termic/schedules/grafana-check/2026-10-02_0900.md")] }), [run]);
    useApp.setState({ activeTaskId: "r1" } as never);
    // Nothing until the agent tab exists, or ensureDefaultTab would never restore it.
    expect(useApp.getState().tabs.r1).toBeUndefined();
    useApp.setState(s => ({ tabs: { ...s.tabs, r1: [{ id: "agent", type: "terminal", cli: "claude", is_default: true } as never] } }));
    await flush();
    const tabs = useApp.getState().tabs.r1;
    const report = tabs.find(t => t.type === "edit") as { id: string; path: string; mdView?: string };
    expect(report).toMatchObject({ path: ".termic/schedules/grafana-check/2026-10-02_0900.md", mdView: "preview" });
    expect(useApp.getState().activeTab.r1).toBe(report.id);

    useApp.getState().closeTab("r1", report.id);
    useApp.setState({ activeTaskId: null } as never);
    useApp.setState({ activeTaskId: "r1" } as never);
    await flush();
    expect(useApp.getState().tabs.r1.some(t => t.type === "edit")).toBe(false);
  });

  it("opens an HTML report in the browser, once, and never in the webview", async () => {
    seed(schedule({ history: [fired(".termic/schedules/grafana-check/2026-10-02_0900.html")] }), [run]);
    useApp.setState({ tabs: { r1: [{ id: "agent", type: "terminal", cli: "claude", is_default: true } as never] } } as never);
    useApp.setState({ activeTaskId: "r1" } as never);
    await flush();
    expect(useApp.getState().tabs.r1.some(t => t.type === "edit")).toBe(false);
    expect(openWebUrlForProject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openWebUrlForProject).mock.calls[0][0])
      .toBe("file:///Users/u/web/.termic/schedules/grafana-check/2026-10-02_0900.html");
    useApp.setState({ activeTaskId: null } as never);
    useApp.setState({ activeTaskId: "r1" } as never);
    await flush();
    expect(openWebUrlForProject).toHaveBeenCalledTimes(1);
  });

  it("survives the row click that restores the previous tab in the same handler", async () => {
    seed(schedule({ history: [fired(".termic/schedules/grafana-check/2026-10-02_0900.md")] }), [run]);
    useApp.setState({ tabs: { r1: [{ id: "agent", type: "terminal", cli: "claude", is_default: true } as never] } } as never);
    // Sidebar.tsx's row onClick: setActive, then setActiveTabId(last active).
    useApp.getState().setActiveTask("r1");
    useApp.getState().setActiveTabId("r1", "agent");
    await flush();
    const report = useApp.getState().tabs.r1.find(t => t.type === "edit")!;
    expect(useApp.getState().activeTab.r1).toBe(report.id);
  });
});
