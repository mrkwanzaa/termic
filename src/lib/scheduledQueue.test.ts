import { describe, it, expect } from "vitest";
import {
  queueLoopRunning,
  dateInputValue, hasDueScheduled, hydrateScheduled, lateBy, localDateValue,
  pickQueueItem, scheduledOf, startOfDayIn,
} from "@/lib/scheduledQueue";
import type { QueueItem } from "@/lib/types";

const NOW = new Date(2026, 8, 17, 14, 5).getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const item = (id: string, extra: Partial<QueueItem> = {}): QueueItem =>
  ({ id, text: id, repeat: 1, remaining: 1, ...extra });

describe("pickQueueItem", () => {
  it("skips a future scheduled item so the ordinary items behind it drain", () => {
    const q = [item("future", { notBefore: NOW + DAY }), item("plain")];
    expect(pickQueueItem(q, { queueActive: true, now: NOW })).toBe(1);
  });

  it("sends a due scheduled item without an active queue", () => {
    const q = [item("plain"), item("due", { notBefore: NOW - 1 })];
    expect(pickQueueItem(q, { queueActive: false, now: NOW })).toBe(1);
  });

  it("finds nothing when only future items remain", () => {
    const q = [item("future", { notBefore: NOW + 1 })];
    expect(pickQueueItem(q, { queueActive: true, now: NOW })).toBe(-1);
    expect(hasDueScheduled(q, NOW)).toBe(false);
  });

  it("an inactive queue sends no ordinary item", () => {
    expect(pickQueueItem([item("plain")], { queueActive: false, now: NOW })).toBe(-1);
  });

  it("Send now takes the head even when it is not due yet", () => {
    const q = [item("future", { notBefore: NOW + DAY })];
    expect(pickQueueItem(q, { queueActive: false, now: NOW, force: true })).toBe(0);
    expect(pickQueueItem([], { queueActive: true, now: NOW, force: true })).toBe(-1);
  });

  it("an item due exactly now is due", () => {
    expect(hasDueScheduled([item("x", { notBefore: NOW })], NOW)).toBe(true);
  });
});

describe("persistence shape", () => {
  it("round-trips scheduled items and leaves ordinary ones out", () => {
    const q = [item("plain"), item("s", { notBefore: NOW + DAY, created: NOW })];
    const saved = scheduledOf(q);
    expect(saved).toEqual([{ id: "s", text: "s", not_before: NOW + DAY, created: NOW }]);
    // Key order is Rust's serialization order, which the store's JSON compare relies on.
    expect(Object.keys(saved[0])).toEqual(["id", "text", "not_before", "created"]);
    expect(hydrateScheduled(saved)).toEqual([
      { id: "s", text: "s", repeat: 1, remaining: 1, notBefore: NOW + DAY, created: NOW },
    ]);
  });
});

describe("dates", () => {
  it("presets resolve to local midnight, so a week out still sends that morning", () => {
    const d = new Date(startOfDayIn(7, NOW));
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 8, 24, 0, 0]);
  });

  it("parses a date input as LOCAL midnight, not UTC", () => {
    const ms = localDateValue("2026-09-24")!;
    expect(ms).toBe(new Date(2026, 8, 24).getTime());
    expect(dateInputValue(ms)).toBe("2026-09-24");
    expect(localDateValue("")).toBeNull();
  });

  it("only mentions lateness past an hour", () => {
    expect(lateBy(NOW, NOW + HOUR)).toBeNull();
    expect(lateBy(NOW, NOW + 5 * HOUR)).toBe("5 hours");
    expect(lateBy(NOW, NOW + DAY + HOUR)).toBe("1 day");
    expect(lateBy(NOW, NOW + 3 * DAY)).toBe("3 days");
  });
});

describe("queueLoopRunning", () => {
  const item = (extra: Partial<QueueItem> = {}): QueueItem =>
    ({ id: "a", text: "t", repeat: 1, remaining: 1, ...extra }) as QueueItem;

  it("is running only while active with an ordinary message still waiting", () => {
    expect(queueLoopRunning({ queueActive: true, queue: [item()] })).toBe(true);
    // The stored flag outlives the queue: it is dropped at the NEXT turn end,
    // so an emptied queue must not read as running in the meantime.
    expect(queueLoopRunning({ queueActive: true, queue: [] })).toBe(false);
    expect(queueLoopRunning({ queueActive: true })).toBe(false);
    // Waiting but paused is not running either.
    expect(queueLoopRunning({ queueActive: false, queue: [item()] })).toBe(false);
  });

  it("a message scheduled for later does not keep the loop running", () => {
    const later = item({ notBefore: Date.now() + 60_000 });
    expect(queueLoopRunning({ queueActive: true, queue: [later] })).toBe(false);
    expect(queueLoopRunning({ queueActive: true, queue: [later, item({ id: "b" })] })).toBe(true);
  });
});
