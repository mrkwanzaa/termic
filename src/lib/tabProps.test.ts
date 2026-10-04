import { describe, it, expect } from "vitest";
import {
  applyProp, collectTaskProps, collectedText, propKeyProblem, propValueProblem,
  PROP_KEYS_PER_TAB, PROP_VALUE_MAX,
} from "@/lib/tabProps";
import type { Tab, TabProp } from "@/lib/types";

const tab = (id: string, props?: TabProp[]): Tab =>
  ({ id, type: "terminal", cli: "claude", title: id, props }) as unknown as Tab;
const p = (key: string, value: string, since: number): TabProp => ({ key, value, since });

describe("tab property validation (mirrors termic-proto)", () => {
  it("keys are lowercase letters, digits, - and _", () => {
    for (const ok of ["status", "ticket", "2fa", "sp-points", "x_1"]) expect(propKeyProblem(ok)).toBeNull();
    for (const bad of ["", "Status", "-x", "_x", "a b", "a.b"]) expect(propKeyProblem(bad)).not.toBeNull();
    expect(propKeyProblem("k".repeat(33))).toMatch(/longer/);
  });

  it("values are one line and short; \"\" is allowed (it clears)", () => {
    expect(propValueProblem("ABC-1")).toBeNull();
    expect(propValueProblem("")).toBeNull();
    expect(propValueProblem(`  ${"v".repeat(PROP_VALUE_MAX)}  `)).toBeNull();
    expect(propValueProblem("v".repeat(PROP_VALUE_MAX + 1))).toMatch(/longer/);
    expect(propValueProblem("a\nb")).toMatch(/one line/);
  });
});

describe("applyProp", () => {
  it("adds a new key last, stamped with when it was first set", () => {
    expect(applyProp(undefined, "ticket", " ABC-1 ", 10)).toEqual([p("ticket", "ABC-1", 10)]);
    expect(applyProp([p("a", "1", 1)], "b", "2", 5)).toEqual([p("a", "1", 1), p("b", "2", 5)]);
  });

  it("updates a value in place and keeps its first-set time, so the key never moves", () => {
    const cur = [p("a", "1", 1), p("b", "2", 2)];
    expect(applyProp(cur, "a", "9", 50)).toEqual([p("a", "9", 1), p("b", "2", 2)]);
  });

  it("returns the SAME array for an unchanged value or a clear of a missing key", () => {
    const cur = [p("a", "1", 1)];
    expect(applyProp(cur, "a", "1", 9)).toBe(cur);
    expect(applyProp(cur, "zz", "", 9)).toBe(cur);
    expect(applyProp(undefined, "zz", "", 9)).toBeUndefined();
  });

  it("\"\" removes the key, and the last one leaves no list at all", () => {
    expect(applyProp([p("a", "1", 1), p("b", "2", 2)], "a", "", 9)).toEqual([p("b", "2", 2)]);
    expect(applyProp([p("a", "1", 1)], "a", "  ", 9)).toBeUndefined();
  });

  it("refuses a key past the per-tab limit but still updates existing ones", () => {
    const full = Array.from({ length: PROP_KEYS_PER_TAB }, (_, i) => p(`k${i}`, "v", i));
    expect(applyProp(full, "extra", "v", 99)).toBe("too_many");
    expect(applyProp(full, "k0", "new", 99)).not.toBe("too_many");
  });
});

describe("collectTaskProps", () => {
  it("joins the distinct values of one key in tab strip order", () => {
    const c = collectTaskProps([
      tab("t1", [p("ticket", "ABC-1", 1)]),
      tab("t2", [p("ticket", "ABC-2", 2)]),
      tab("t3", [p("ticket", "ABC-1", 3)]),
    ]);
    expect(c).toEqual([{ key: "ticket", values: ["ABC-1", "ABC-2"] }]);
    expect(collectedText(c)).toBe("ABC-1, ABC-2");
  });

  it("orders keys by when they were first set anywhere in the task", () => {
    // `status` was set first (t2, at 1) even though t1 is earlier in the strip.
    const c = collectTaskProps([
      tab("t1", [p("ticket", "ABC-1", 5)]),
      tab("t2", [p("status", "ToDo", 1), p("ticket", "ABC-2", 6)]),
    ]);
    expect(c.map(x => x.key)).toEqual(["status", "ticket"]);
    expect(collectedText(c)).toBe("ToDo · ABC-1, ABC-2");
  });

  it("breaks a first-set tie by tab order, and ignores non-terminal tabs", () => {
    const c = collectTaskProps([
      tab("t1", [p("b", "1", 7)]),
      { id: "e", type: "edit", title: "x", props: [p("z", "0", 0)] } as unknown as Tab,
      tab("t2", [p("a", "2", 7)]),
    ]);
    expect(c.map(x => x.key)).toEqual(["b", "a"]);
  });

  it("is empty for tabs without properties", () => {
    expect(collectTaskProps([tab("t1"), tab("t2", [])])).toEqual([]);
    expect(collectTaskProps(undefined)).toEqual([]);
  });
});
