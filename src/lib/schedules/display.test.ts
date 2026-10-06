import { describe, it, expect } from "vitest";
import { i18n } from "@/lib/i18n";
import { cadenceText, failureText, nextRun, outcomeText, slotText, weekdayName } from "@/lib/schedules/display";
import type { ScheduleRun } from "@/lib/types";

const t = i18n.getFixedT("en", "chrome");
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const NOW = at(2, 12); // Friday 2026-10-02 12:00

describe("cadenceText", () => {
  it("names all three presets", () => {
    expect(cadenceText({ kind: "daily", time: "09:00" }, t, "en")).toBe("Daily at 09:00");
    expect(cadenceText({ kind: "weekdays", time: "08:30" }, t, "en")).toBe("Weekdays at 08:30");
    expect(cadenceText({ kind: "weekly", time: "17:00", weekday: 1 }, t, "en")).toBe("Every Monday at 17:00");
    expect(weekdayName(0, "en")).toBe("Sunday");
  });
});

describe("slotText and nextRun", () => {
  it("shows the time today, the weekday this week, the date beyond", () => {
    expect(slotText(at(2, 9), NOW, "en")).toBe("09:00");
    expect(slotText(at(3, 9), NOW, "en")).toBe("Sat 09:00");
    expect(slotText(at(20, 9), NOW, "en")).toBe("Oct 20 09:00");
  });

  it("is the next slot after now or the last acted slot, and none when paused", () => {
    const c = { kind: "daily" as const, time: "09:00" };
    expect(nextRun({ enabled: true, cadence: c, last_slot: at(2, 9) }, NOW)).toBe(at(3, 9));
    // A slot acted on early (a clock set back) is still not offered again.
    expect(nextRun({ enabled: true, cadence: c, last_slot: at(3, 9) }, NOW)).toBe(at(4, 9));
    expect(nextRun({ enabled: false, cadence: c, last_slot: at(2, 9) }, NOW)).toBeNull();
  });
});

describe("outcomeText", () => {
  const e = (extra: Partial<ScheduleRun>): ScheduleRun => ({ slot: at(2, 9), outcome: "fired", ...extra });

  it("reads a fired run as its report's title, or says the report went", () => {
    expect(outcomeText(e({ title: "All green" }), t, NOW, "en")).toBe("All green");
    expect(outcomeText(e({}), t, NOW, "en")).toBe("Report ready");
    expect(outcomeText(e({ title: "x", report_gone: true }), t, NOW, "en")).toBe("Report cleaned up");
  });

  it("says when a slot was missed, one slot by its time and a streak by its count", () => {
    expect(outcomeText(e({ outcome: "missed" }), t, NOW, "en")).toBe("Missed 09:00");
    expect(outcomeText(e({ outcome: "missed", count: 3 }), t, NOW, "en")).toBe("Missed 3 runs");
    expect(outcomeText(e({ outcome: "skipped" }), t, NOW, "en")).toBe("Skipped 09:00: the previous run was still going");
  });

  it("translates the runner's failure codes and passes a raw error through", () => {
    expect(outcomeText(e({ outcome: "failed", error: "docker" }), t, NOW, "en")).toBe("Failed: Docker runs are not supported yet");
    expect(failureText("quit", t)).toBe("Termic quit during the run");
    expect(failureText("a task named \"x\" already exists in this project", t)).toBe("a task named \"x\" already exists in this project");
  });

  it("has no em dash in any line it can produce", () => {
    const all: ScheduleRun["outcome"][] = ["running", "fired", "no_report", "needs_input", "missed", "skipped", "failed"];
    for (const outcome of all) {
      for (const lang of ["en", "zh-CN"]) {
        const tl = i18n.getFixedT(lang, "chrome");
        expect(outcomeText(e({ outcome, error: "exited", count: 2 }), tl, NOW, lang)).not.toContain("—");
      }
    }
  });
});
