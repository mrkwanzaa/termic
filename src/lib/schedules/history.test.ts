import { describe, it, expect } from "vitest";
import { HISTORY_KEEP, appendRun, markReportsGone, runsToArchive, updateRun } from "@/lib/schedules/history";
import type { ScheduleRun } from "@/lib/types";

const run = (slot: number, extra: Partial<ScheduleRun> = {}): ScheduleRun =>
  ({ slot, outcome: "fired", run_task_id: `r${slot}`, ...extra });
const none = () => false;

describe("appendRun", () => {
  it("appends newest last", () => {
    expect(appendRun([run(1)], run(2), none).map(e => e.slot)).toEqual([1, 2]);
  });

  it("merges a streak of missed slots into one entry", () => {
    const h = appendRun([run(1)], { slot: 2, outcome: "missed", count: 2 }, none);
    const h2 = appendRun(h, { slot: 3, outcome: "missed", count: 1 }, none);
    expect(h2).toEqual([run(1), { slot: 3, outcome: "missed", count: 3 }]);
    // A run in between ends the streak.
    const h3 = appendRun(appendRun(h2, run(4), none), { slot: 5, outcome: "missed" }, none);
    expect(h3.map(e => e.outcome)).toEqual(["fired", "missed", "fired", "missed"]);
  });

  it("trims to the cap, oldest first", () => {
    let h: ScheduleRun[] = [];
    for (let i = 0; i < HISTORY_KEEP + 5; i++) h = appendRun(h, run(i), none);
    expect(h).toHaveLength(HISTORY_KEEP);
    expect(h[0].slot).toBe(5);
  });

  it("never trims an entry whose run is still live, so no run escapes archiving", () => {
    let h: ScheduleRun[] = [run(0)];
    for (let i = 1; i < HISTORY_KEEP + 3; i++) h = appendRun(h, { slot: i, outcome: "skipped" }, id => id === "r0");
    expect(h).toHaveLength(HISTORY_KEEP);
    expect(h[0]).toEqual(run(0));
  });
});

describe("updateRun", () => {
  it("patches the run's entry", () => {
    const h = [run(1, { outcome: "running" }), run(2, { outcome: "running" })];
    expect(updateRun(h, "r2", { outcome: "fired", title: "ok" })?.[1]).toEqual(run(2, { outcome: "fired", title: "ok" }));
  });

  it("returns null for no entry or no change, so nothing is written", () => {
    const h = [run(1)];
    expect(updateRun(h, "nope", { outcome: "fired" })).toBeNull();
    expect(updateRun(h, "r1", { outcome: "fired" })).toBeNull();
  });
});

describe("runsToArchive", () => {
  const h = [run(1), { slot: 2, outcome: "missed" } as ScheduleRun, run(3), run(4), run(5)];

  it("keeps the newest N live runs and returns the rest", () => {
    expect(runsToArchive(h, 2, () => true).sort()).toEqual(["r1", "r3"]);
    expect(runsToArchive(h, 7, () => true)).toEqual([]);
  });

  it("counts only live runs toward N", () => {
    // r5 was archived by hand: r3 and r4 are now the newest two live ones.
    expect(runsToArchive(h, 2, id => id !== "r5")).toEqual(["r1"]);
  });

  it("only ever names runs in the history", () => {
    expect(runsToArchive([], 0, () => true)).toEqual([]);
  });
});

describe("markReportsGone", () => {
  it("flags entries whose report retention deleted", () => {
    const h = [run(1, { report: ".termic/schedules/s/2026-08-01_0900.md" }), run(2, { report: ".termic/schedules/s/2026-09-28_0900.md" })];
    const next = markReportsGone(h, ["2026-08-01_0900.md"])!;
    expect(next[0].report_gone).toBe(true);
    expect(next[1].report_gone).toBeUndefined();
    expect(markReportsGone(next, ["2026-08-01_0900.md"])).toBeNull();
    expect(markReportsGone(h, [])).toBeNull();
  });
});
