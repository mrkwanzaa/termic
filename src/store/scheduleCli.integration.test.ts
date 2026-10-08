// @vitest-environment happy-dom
//
// `termic schedule` through the webview handler: list, show, set, run, delete.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  taskSetSchedule: vi.fn().mockImplementation(async (id: string, s: any) => {
    useApp.getState().setTaskSchedule(id, s);
  }),
  scheduleDeleteReports: vi.fn().mockResolvedValue(["report1.md"]),
  schedulePruneReports: vi.fn().mockResolvedValue([]),
  scheduleReportStatus: vi.fn().mockResolvedValue(null),
  taskGroupNew: vi.fn().mockResolvedValue(undefined),
  taskArchive: vi.fn().mockResolvedValue(undefined),
  taskDelete: vi.fn().mockResolvedValue(undefined),
  taskRename: vi.fn().mockResolvedValue(undefined),
  tasksList: vi.fn().mockImplementation(async () => useApp.getState().tasks),
  projectsList: vi.fn().mockImplementation(async () => useApp.getState().projects),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import * as ipc from "@/lib/ipc";
import { useApp } from "@/store/app";
import { scheduleHandler } from "@/lib/scheduleCli";
import type { Project, Task, TaskSchedule } from "@/lib/types";

const PROJ: Project = {
  id: "proj-1",
  name: "web",
  path: "/repo/web",
};

const TASK: Task = {
  id: "task-1",
  project_id: "proj-1",
  name: "daily-sync",
  cli: "claude",
  path: "/repo/web/tasks/daily-sync",
  created_at: 1000,
  schedule: {
    enabled: true,
    name: "daily sync",
    slug: "daily-sync",
    prompt: "Sync the repo",
    cadence: { kind: "daily", time: "09:00" },
    catch_up: false,
    keep_runs: 7,
    report_days: 30,
    last_slot: 1728300000,
    history: [
      { slot: 1728300000, outcome: "fired", report: "2026-10-07_0900.md", title: "Sync summary" },
    ],
  },
};

const DOCKER_TASK: Task = {
  id: "task-docker",
  project_id: "proj-1",
  name: "docker-job",
  cli: "claude",
  path: "/repo/web/tasks/docker-job",
  sandbox: "docker",
  created_at: 1000,
};

const BARE_TASK: Task = {
  id: "task-bare",
  project_id: "proj-1",
  name: "bare-task",
  cli: "claude",
  path: "/repo/web/tasks/bare-task",
  created_at: 1000,
};

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({
    projects: [PROJ],
    tasks: [TASK, DOCKER_TASK, BARE_TASK],
  });
});

describe("schedule list", () => {
  it("lists active schedules with summaries", async () => {
    const res = (await scheduleHandler({ op: "list" })) as { schedules: any[] };
    expect(res.schedules).toHaveLength(1);
    expect(res.schedules[0]).toMatchObject({
      task_id: "task-1",
      name: "daily sync",
      project_name: "web",
      enabled: true,
      last_outcome: "fired",
      cadence: { kind: "daily", time: "09:00" },
    });
  });

  it("filters schedules by project", async () => {
    const res = (await scheduleHandler({ op: "list", projectId: "proj-1" })) as { schedules: any[] };
    expect(res.schedules).toHaveLength(1);

    const empty = (await scheduleHandler({ op: "list", projectId: "other" })) as { schedules: any[] };
    expect(empty.schedules).toHaveLength(0);
  });
});

describe("schedule show", () => {
  it("shows schedule details and history", async () => {
    const res = (await scheduleHandler({ op: "show", taskId: "task-1" })) as {
      schedule: any;
      history: any[];
    };
    expect(res.schedule.name).toBe("daily sync");
    expect(res.history).toHaveLength(1);
    expect(res.history[0]).toMatchObject({
      slot: 1728300000,
      outcome: "fired",
      report: "2026-10-07_0900.md",
      title: "Sync summary",
    });
  });

  it("errors when task has no schedule", async () => {
    await expect(scheduleHandler({ op: "show", taskId: "task-bare" })).rejects.toThrow(
      'task "bare-task" has no schedule',
    );
  });
});

describe("schedule set", () => {
  it("refuses to schedule a Docker task", async () => {
    await expect(
      scheduleHandler({
        op: "set",
        taskId: "task-docker",
        cadence: { kind: "daily", time: "10:00" },
      }),
    ).rejects.toThrow("cannot schedule a Docker task");
  });

  it("updates an existing schedule", async () => {
    const res = (await scheduleHandler({
      op: "set",
      taskId: "task-1",
      name: "updated sync",
      cadence: { kind: "weekdays", time: "10:30" },
      enabled: false,
    })) as { schedule: any };

    expect(ipc.taskSetSchedule).toHaveBeenCalled();
    expect(res.schedule.name).toBe("updated sync");
    expect(res.schedule.cadence).toEqual({ kind: "weekdays", time: "10:30" });
    expect(res.schedule.enabled).toBe(false);
  });

  it("attaches a new schedule to a bare task", async () => {
    const res = (await scheduleHandler({
      op: "set",
      taskId: "task-bare",
      cadence: { kind: "weekly", time: "12:00", weekday: 5 },
      prompt: "Weekly review",
      keepRuns: 10,
    })) as { schedule: any };

    expect(ipc.taskSetSchedule).toHaveBeenCalled();
    expect(res.schedule.name).toBe("bare-task");
    expect(res.schedule.cadence).toEqual({ kind: "weekly", time: "12:00", weekday: 5 });
    expect(res.schedule.keep_runs).toBe(10);
    expect(res.schedule.prompt).toBe("Weekly review");
  });
});

describe("schedule delete", () => {
  it("removes a schedule and optionally deletes report files", async () => {
    const res = (await scheduleHandler({
      op: "delete",
      taskId: "task-1",
      deleteReports: true,
    })) as { deleted: boolean };

    expect(res.deleted).toBe(true);
    expect(ipc.taskSetSchedule).toHaveBeenCalledWith("task-1", null);
    expect(ipc.scheduleDeleteReports).toHaveBeenCalledWith("proj-1", "daily-sync");
  });
});
