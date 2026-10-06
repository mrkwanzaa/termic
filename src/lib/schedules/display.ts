// How a schedule reads in the Scheduled view (GH #300). Pure: every function
// takes the component's `t`, so a language switch re-renders it
// (docs/i18n.md, "A pure helper that renders for a component").

import type { TFunction } from "i18next";
import type { ScheduleCadence, ScheduleRun, TaskSchedule } from "@/lib/types";
import { nextSlotAfter } from "@/lib/schedules/slots";

/** The name of a weekday (0 = Sunday) in the UI language. */
export function weekdayName(day: number, lang: string): string {
  // 2026-10-04 is a Sunday.
  return new Intl.DateTimeFormat(lang, { weekday: "long" }).format(new Date(2026, 9, 4 + day));
}

export function cadenceText(c: ScheduleCadence, t: TFunction, lang: string): string {
  if (c.kind === "weekdays") return t("scheduled.cadenceWeekdays", { time: c.time });
  if (c.kind === "weekly") return t("scheduled.cadenceWeekly", { day: weekdayName(c.weekday ?? 1, lang), time: c.time });
  return t("scheduled.cadenceDaily", { time: c.time });
}

/** A slot as the view shows it: the time alone today, the weekday and time
 *  within a week, the date and time further off. */
export function slotText(ms: number, now: number, lang: string): string {
  const d = new Date(ms);
  const n = new Date(now);
  const time = new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return time;
  if (Math.abs(ms - now) < 6 * 86_400_000) {
    return `${new Intl.DateTimeFormat(lang, { weekday: "short" }).format(d)} ${time}`;
  }
  return `${new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" }).format(d)} ${time}`;
}

/** When the schedule runs next, or null when it does not (disabled). A slot
 *  at or before `last_slot` was already acted on, so the next one is after
 *  whichever is later. */
export function nextRun(s: Pick<TaskSchedule, "enabled" | "cadence" | "last_slot">, now: number): number | null {
  if (!s.enabled) return null;
  return nextSlotAfter(s.cadence, Math.max(now, s.last_slot ?? 0));
}

/** Why a run failed, in words. Codes the runner writes are translated; a raw
 *  backend error is shown as it came (docs/i18n.md, "Raw backend errors stay
 *  raw"). */
export function failureText(error: string | undefined, t: TFunction): string {
  switch (error) {
    case "docker": return t("scheduled.reasonDocker");
    case "agent": return t("scheduled.reasonAgent");
    case "prompt": return t("scheduled.reasonPrompt");
    case "exited": return t("scheduled.reasonExited");
    case "stopped": return t("scheduled.reasonStopped");
    case "quit": return t("scheduled.reasonQuit");
    default: return error ?? "";
  }
}

/** One history entry as a line of text. A fired run reads as its report's
 *  title when it has one. */
export function outcomeText(e: ScheduleRun, t: TFunction, now: number, lang: string): string {
  const time = slotText(e.slot, now, lang);
  switch (e.outcome) {
    case "running": return t("scheduled.outcomeRunning");
    case "fired": return e.report_gone ? t("scheduled.reportGone") : (e.title || t("scheduled.outcomeFired"));
    case "no_report": return t("scheduled.outcomeNoReport");
    case "needs_input": return t("scheduled.outcomeNeedsInput");
    case "missed": {
      const count = e.count ?? 1;
      return count > 1 ? t("scheduled.outcomeMissedMany", { count }) : t("scheduled.outcomeMissed", { time });
    }
    case "skipped": return t("scheduled.outcomeSkipped", { time });
    case "failed": return t("scheduled.outcomeFailed", { reason: failureText(e.error, t) });
  }
}
