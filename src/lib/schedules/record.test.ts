import { describe, it, expect } from "vitest";
import { editedSchedule, newSchedule, sameSchedule } from "@/lib/schedules/record";
import type { TaskSchedule } from "@/lib/types";

const at = (d: number, h: number) => new Date(2026, 9, d, h).getTime();
const input = {
  name: "  Nightly  ", prompt: "go", prompt_id: "  ", cadence: { kind: "daily" as const, time: "09:00", weekday: 3 },
  catch_up: true, keep_runs: 5, report_days: null,
};

describe("newSchedule", () => {
  it("trims, drops empty fields and a weekday a daily cadence has no use for", () => {
    const s = newSchedule(input, at(2, 10), []);
    expect(s).toEqual({
      enabled: true, name: "Nightly", slug: "nightly", prompt: "go", prompt_id: undefined,
      cadence: { kind: "daily", time: "09:00" }, catch_up: true, keep_runs: 5, report_days: null,
      last_slot: at(2, 9), history: [],
    });
  });
});

describe("sameSchedule", () => {
  it("ignores key order and undefined members, so a disk copy equals its rebuild", () => {
    const a = newSchedule(input, at(2, 10), []);
    // Same record, keys in another order, the shape a disk round trip gives.
    const reordered = Object.fromEntries(Object.entries(a).reverse());
    const fromDisk = JSON.parse(JSON.stringify(reordered)) as TaskSchedule;
    expect(Object.keys(fromDisk)[0]).not.toBe(Object.keys(a)[0]);
    expect(sameSchedule(a, fromDisk)).toBe(true);
    expect(sameSchedule(a, { ...a, last_slot: 1 })).toBe(false);
    expect(sameSchedule(null, undefined)).toBe(true);
    expect(sameSchedule(a, null)).toBe(false);
  });
});

describe("editedSchedule", () => {
  const base = newSchedule(input, at(2, 10), []);

  it("never changes the slug", () => {
    expect(editedSchedule(base, { name: "Weekly digest" }, at(3, 10)).slug).toBe("nightly");
  });

  it("keeps last_slot for an edit that does not touch the cadence", () => {
    expect(editedSchedule(base, { keep_runs: 3, report_days: 90 }, at(5, 10)).last_slot).toBe(at(2, 9));
  });

  it("restarts last_slot for a new time, a new weekday, or turning back on", () => {
    expect(editedSchedule(base, { cadence: { kind: "daily", time: "08:00" } }, at(5, 10)).last_slot).toBe(at(5, 8));
    const weekly = editedSchedule(base, { cadence: { kind: "weekly", time: "09:00", weekday: 1 } }, at(5, 10));
    expect(weekly.last_slot).toBe(at(5, 9)); // 2026-10-05 is a Monday
    const off = editedSchedule(base, { enabled: false }, at(5, 10));
    expect(off.last_slot).toBe(at(2, 9));
    expect(editedSchedule(off, { enabled: true }, at(7, 10)).last_slot).toBe(at(7, 9));
  });

  it("can clear the prompt text when a library entry takes over", () => {
    const e = editedSchedule(base, { prompt: "", prompt_id: "builtin:review" }, at(3, 10));
    expect(e.prompt).toBeUndefined();
    expect(e.prompt_id).toBe("builtin:review");
  });
});
