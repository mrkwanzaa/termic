// Recurring schedules (GH #300): a parent task, runs in its group, a report
// file each run writes, and the run's lifecycle after it ends.
//
// A spec cannot wait for a slot, so it presses Run now or runs ONE pass of the
// minute ticker at a chosen moment, through the same functions the app uses
// (window.__termic.scheduleRunner). The schedule's own cadence is set days
// away, so the real ticker never fires during the run. The agent is the
// `fakeagent` fixture: its first prompt line is a directive (`#report`,
// `#attn`, `#noreport`) and it writes the report file Termic's appended
// instruction names.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveTask, clickWhenVisible, dismissOverlays, requireTermicApi, sidebarBadge, snap, waitForAppShell,
  waitGone, waitTabInFront, waitTaskUnmounted, waitVisible,
} from "../helpers.js";

describe("scheduled tasks", () => {
  let projectId = "";
  let root = "";
  let parent = "";
  let slug = "";
  const runs: string[] = [];
  const NAME = "e2e nightly";

  const block = (gid: string) => `[data-task-group-id="${gid}"]`;
  const row = (id: string) => `[data-sidebar-task-id="${id}"]`;
  const toggle = (gid: string) => `[data-testid="task-group-toggle-${gid}"]`;

  const schedule = () =>
    browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.schedule ?? null,
      parent,
    ) as Promise<any>;
  const entryOf = async (runId: string) =>
    ((await schedule())?.history ?? []).find((e: any) => e.run_task_id === runId) ?? null;
  const waitOutcome = (runId: string, outcome: string, timeout = 30_000) =>
    browser.waitUntil(async () => (await entryOf(runId))?.outcome === outcome, {
      timeout, interval: 250,
      timeoutMsg: `run ${runId} never reached "${outcome}"`,
    });
  const update = (patch: Record<string, unknown>) =>
    browser.execute(async (id, p) => { await window.__termic!.scheduleRunner.updateSchedule(id, p); }, parent, patch);
  const runNow = async (): Promise<{ kind: string; runId?: string }> => {
    const r = await browser.execute(
      async (id) => window.__termic!.scheduleRunner.runScheduleNow(id),
      parent,
    ) as { kind: string; runId?: string };
    if (r.runId) runs.push(r.runId);
    return r;
  };
  const diskTask = (id: string) =>
    browser.execute(async (i) => {
      const all: any[] = await window.__termic!.ipc.tasksList();
      return all.find(t => t.id === i) ?? null;
    }, id) as Promise<any>;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await browser.waitUntil(
      () => browser.execute(() => window.__termic!.useApp.getState().projects.some((x: any) => x.name === "fixture-repo")),
      { timeout: 15_000, timeoutMsg: "the fixture project never loaded" },
    );
    ({ projectId, root } = await browser.execute(() => {
      const p = window.__termic!.useApp.getState().projects.find((x: any) => x.name === "fixture-repo");
      return { projectId: p.id as string, root: p.root_path as string };
    }));
    await browser.execute((p) => window.__termic!.useApp.getState().setProjectCollapsed(p, false), projectId);
    await dismissOverlays();
  });

  after(async () => {
    if (parent) {
      await browser.execute(
        async (id) => { await window.__termic!.scheduleRunner.deleteSchedule(id, true); },
        parent,
      ).catch(() => {});
    }
    for (const id of [...runs, parent].filter(Boolean)) {
      const t = await diskTask(id).catch(() => null);
      if (t && !t.archived) await archiveTask(id);
    }
    // Leave the fixture as it was found: the empty report root, and the
    // exclude line creating the schedule added.
    for (const dir of [path.join(root, ".termic", "schedules"), path.join(root, ".termic")]) {
      try { rmdirSync(dir); } catch { /* not empty, or never made */ }
    }
    const exclude = path.join(root, ".git", "info", "exclude");
    if (existsSync(exclude)) {
      const kept = readFileSync(exclude, "utf8").split("\n").filter(l => l !== "/.termic/schedules/");
      writeFileSync(exclude, kept.join("\n"));
    }
  });

  it("creates an unmounted parent that leads a collapsed group, its reports kept out of git", async () => {
    parent = await browser.execute(async (pid, name) => {
      // Three days out, so the real minute ticker never fires it mid-spec.
      const weekday = (new Date().getDay() + 3) % 7;
      return window.__termic!.scheduleRunner.createSchedule({
        projectId: pid,
        agent: { cli: "fakeagent", agentArgs: [], yolo: false, sandbox: { enabled: false, rwPaths: [], allowedHosts: [] } },
        input: {
          name, prompt: "#report", cadence: { kind: "weekly", time: "03:00", weekday },
          catch_up: false, keep_runs: 7, report_days: null,
        },
      });
    }, projectId, NAME);
    slug = (await schedule()).slug;

    await waitVisible(block(parent));
    expect(await browser.execute((s) => document.querySelector(s)?.getAttribute("aria-expanded"), toggle(parent))).toBe("false");
    // Created, not started: no task view, so no agent, until someone opens it.
    expect(await browser.execute((id) => !!document.querySelector(`[data-task-id="${id}"]`), parent)).toBe(false);

    expect(existsSync(path.join(root, ".termic", "schedules", slug))).toBe(true);
    expect(readFileSync(path.join(root, ".git", "info", "exclude"), "utf8")).toContain("/.termic/schedules/");
    // Anything that lands in the folder is invisible to git.
    const probe = path.join(root, ".termic", "schedules", slug, "probe.md");
    writeFileSync(probe, "x");
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
    unlinkSync(probe);
    expect(status).not.toContain(".termic");
    await snap("schedules-01-parent-collapsed.png");
  });

  it("Run now makes a run in the parent's group that writes its report and is stopped", async () => {
    const r = await runNow();
    expect(r.kind).toBe("started");
    const run = r.runId!;
    expect((await diskTask(run))?.group?.id).toBe(parent);
    await browser.waitUntil(
      () => browser.execute((g) => document.querySelector(`[data-testid="task-group-count-${g}"]`)?.textContent?.trim().startsWith("2") ?? false, parent),
      { timeout: 10_000, timeoutMsg: "the run never showed in the parent's group" },
    );

    await waitOutcome(run, "fired");
    const e = await entryOf(run);
    expect(e.title).toBe("Fake scheduled report");
    expect(readFileSync(path.join(root, e.report), "utf8")).toContain("# Fake scheduled report");
    // Done means stopped: no agent left running behind a collapsed group.
    await waitTaskUnmounted(run, 15_000);
    await snap("schedules-02-run-done.png");
  });

  it("opening the run puts its rendered report in front of the agent tab", async () => {
    const run = runs[0];
    await clickWhenVisible(toggle(parent));
    await clickWhenVisible(row(run));
    await browser.waitUntil(
      () => browser.execute((id) => document.querySelector(`[data-task-id="${id}"] .markdown-body h1`)?.textContent ?? null, run)
        .then(t => t === "Fake scheduled report"),
      { timeout: 15_000, timeoutMsg: "the run's report never rendered in its task view" },
    );
    const reportTab = await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      return (s.tabs[id] ?? []).find((t: any) => t.type === "edit")?.id ?? null;
    }, run) as string | null;
    expect(reportTab).toBeTruthy();
    await waitTabInFront(run, reportTab!);
    // The agent tab is still there behind it.
    expect(await browser.execute((id) =>
      (window.__termic!.useApp.getState().tabs[id] ?? []).some((t: any) => t.type === "terminal"), run)).toBe(true);
    await snap("schedules-03-report-open.png");
  });

  it("archives runs past keep_runs without running the project's archive script", async () => {
    const marker = path.join(os.tmpdir(), `termic-e2e-archive-script-${process.pid}`);
    const original = await browser.execute((pid) =>
      window.__termic!.useApp.getState().projects.find((p: any) => p.id === pid).archive_script ?? "", projectId);
    const setScript = (script: string) => browser.execute(async (pid, sc) => {
      const t = window.__termic!;
      const p = t.useApp.getState().projects.find((x: any) => x.id === pid);
      await t.ipc.projectUpdate({ ...p, archive_script: sc });
      await t.useApp.getState().loadAll();
    }, projectId, script);
    try {
      await setScript(`touch "${marker}"`);
      await update({ keep_runs: 1 });
      // The run on screen is never archived; step off it.
      await browser.execute(() => window.__termic!.useApp.getState().setActiveTask(null));
      const first = runs[0];
      const r = await runNow();
      await waitOutcome(r.runId!, "fired");
      await waitGone(row(first), 15_000);
      expect((await diskTask(first))?.archived).toBe(true);
      expect((await diskTask(r.runId!))?.archived).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await setScript(original);
    }
  });

  it("a run that needs input stays live, shows it, and holds back the next one", async () => {
    await update({ prompt: "#attn", keep_runs: 7 });
    const r = await runNow();
    const run = r.runId!;
    await waitOutcome(run, "needs_input");
    await browser.waitUntil(async () => (await sidebarBadge(run)) === "attention", {
      timeout: 10_000, timeoutMsg: "the run's row never asked for attention",
    });
    expect(await browser.execute((id) => !!document.querySelector(`[data-task-id="${id}"] .xterm`), run)).toBe(true);
    expect((await runNow()).kind).toBe("busy");
    await snap("schedules-04-needs-input.png");

    await browser.execute((id) => window.__termic!.useApp.getState().stopTask(id), run);
    await waitOutcome(run, "failed");
    expect((await entryOf(run)).error).toBe("stopped");
  });

  it("archiving the parent pauses the schedule, and a restore resumes it", async () => {
    await update({ prompt: "#report" });
    const tickAt = await browser.execute((id) => {
      const s = window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id).schedule;
      const d = new Date();
      for (let i = 1; i <= 7; i++) {
        const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, 3, 0);
        if (c.getDay() === s.cadence.weekday) return c.getTime() + 60_000;
      }
      throw new Error("no slot in the next week");
    }, parent) as number;
    const tick = () => browser.execute(
      async (now) => window.__termic!.scheduleRunner.scheduleTickNow(now),
      tickAt,
    ) as unknown as Promise<number>;

    await archiveTask(parent);
    expect(await tick()).toBe(0);

    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskRestore(id);
      await window.__termic!.useApp.getState().loadAll();
    }, parent);
    expect(await tick()).toBe(1);
    const s = await schedule();
    const e = s.history[s.history.length - 1];
    expect(e.slot).toBe(tickAt - 60_000);
    runs.push(e.run_task_id);
    await waitOutcome(e.run_task_id, "fired");
  });
});

