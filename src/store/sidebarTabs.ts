// What the sidebar reads from `tabs`, held so a tab write it does not draw
// re-renders nothing (docs/performance.md bear trap 5).
//
// Two layers, with opposite rules, because they read opposite amounts:
//
// - The Sidebar BODY draws a handful of per-task booleans (rollup dots, the
//   filter bell's count, the broadcast count, the filter's matches). It gets
//   exactly those as `SidebarTaskFacts`, and has no `tabs` in scope at all,
//   so a new read has to be added here as a fact. It used to select the whole
//   `tabs` map, which re-rendered the whole sidebar, every row included, on
//   every `lastOutputAt` stamp of every streaming terminal.
//
// - A TaskRow draws nearly every field of its own tabs (titles, live titles,
//   badges, run controls). It gets its tabs array, but the previous one is
//   kept while the only change is a field it never draws. That is an
//   EXCLUSION list on purpose: a field missing from it costs an extra render,
//   never a stale one.
//
// Selector bodies are exported so `selectorFanout.test.ts` measures these,
// not a copy.

import { useMemo, useState } from "react";
import { useApp, EMPTY_TABS, type AppState } from "@/store/app";
import { taskFilterFacts, type TaskFilterFacts } from "@/lib/taskFilter";
import { taskNeedsAttention, taskWorkDone } from "@/lib/taskWorkState";
import type { Tab, TerminalTab } from "@/lib/types";

// ─── Sidebar body: per-task facts ───────────────────────────────────────

export interface SidebarTaskFacts extends TaskFilterFacts {
  /** A terminal tab is blocked on the user. No pref applies: the collapsed
   *  project and group rollup dots never took the attention switch. */
  readonly attention: boolean;
  /** A terminal tab settled. Raw: the Sidebar gates it on `settledHighlight`,
   *  so a pref flip never has to re-run this selector. */
  readonly done: boolean;
  /** A live main agent, i.e. something the project broadcast would reach. */
  readonly liveDefault: boolean;
}

/** Facts per LOADED task. No entry means the tabs were never loaded this
 *  session, which the filter treats differently from "loaded, none". */
export type SidebarTabFacts = Readonly<Record<string, SidebarTaskFacts>>;

export const EMPTY_SIDEBAR_FACTS: SidebarTabFacts = Object.freeze({});

// Both helpers apply their prefs; these make them report the raw fact.
const RAW = { settledHighlight: true, attentionIndicator: true } as const;

export function computeSidebarTaskFacts(tabs: Tab[]): SidebarTaskFacts {
  return Object.freeze({
    ...taskFilterFacts(tabs),
    attention: taskNeedsAttention(tabs, RAW),
    done: taskWorkDone(tabs, RAW),
    liveDefault: tabs.some(t => t.type === "terminal"
      && !!(t as TerminalTab).is_default && !(t as TerminalTab).paneId
      && !(t as TerminalTab).runTab && !!(t as TerminalTab).ptyId),
  });
}

function sameFacts(a: SidebarTaskFacts, b: SidebarTaskFacts): boolean {
  return a.notification === b.notification
    && a.attention === b.attention
    && a.done === b.done
    && a.liveDefault === b.liveDefault
    && a.titles.length === b.titles.length
    && a.titles.every((t, i) => t === b.titles[i])
    && a.propValues.length === b.propValues.length
    && a.propValues.every((v, i) => v === b.propValues[i]);
}

/** One per mounted Sidebar (the hover reveal mounts two). Returns the SAME
 *  record until some task's facts change, and the same per-task object for
 *  every task whose facts did not. Costs O(1) on a write that leaves `tabs`
 *  alone, and one task's recompute on a `patchTab`, which replaces only that
 *  task's array. */
export function createSidebarFactsSelector(): (s: AppState) => SidebarTabFacts {
  let prevTabs: AppState["tabs"] | null = null;
  let prevFacts: SidebarTabFacts = EMPTY_SIDEBAR_FACTS;
  let prevCount = 0;
  return (s) => {
    const tabs = s.tabs;
    if (tabs === prevTabs) return prevFacts;
    const next: Record<string, SidebarTaskFacts> = {};
    let count = 0;
    let changed = false;
    for (const id in tabs) {
      const list = tabs[id];
      if (!list) continue;
      count++;
      const old: SidebarTaskFacts | undefined = prevFacts[id];
      let facts: SidebarTaskFacts;
      if (old && prevTabs && prevTabs[id] === list) {
        facts = old;
      } else {
        const fresh = computeSidebarTaskFacts(list);
        facts = old && sameFacts(old, fresh) ? old : fresh;
      }
      if (facts !== old) changed = true;
      next[id] = facts;
    }
    prevTabs = tabs;
    if (!changed && count === prevCount) return prevFacts;
    prevCount = count;
    prevFacts = Object.freeze(next);
    return prevFacts;
  };
}

export function useSidebarTabFacts(): SidebarTabFacts {
  const [select] = useState(createSidebarFactsSelector);
  return useApp(select);
}

// ─── TaskRow: its own tabs, minus the fields it never draws ─────────────

/** Tab fields a PTY-driven path rewrites that no sidebar row draws: the idle
 *  heuristic's timestamps. `lastOutputAt` is the hot one, stamped up to twice
 *  a second per streaming terminal (bear trap 9's 500 ms window). */
export const ROW_HIDDEN_TAB_FIELDS: ReadonlySet<string> = new Set([
  "lastOutputAt", "lastInputAt", "firstOutputAt",
]);

/** Equal for drawing purposes: every field but the hidden ones is Object.is.
 *  An absent key and an `undefined` one read the same, as they render. */
export function tabRenderEqual(a: Tab, b: Tab): boolean {
  if (a === b) return true;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  for (const k in ra) {
    if (!ROW_HIDDEN_TAB_FIELDS.has(k) && !Object.is(ra[k], rb[k])) return false;
  }
  for (const k in rb) {
    if (!(k in ra) && !ROW_HIDDEN_TAB_FIELDS.has(k) && rb[k] !== undefined) return false;
  }
  return true;
}

export function tabListRenderEqual(a: readonly Tab[], b: readonly Tab[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!tabRenderEqual(a[i], b[i])) return false;
  }
  return true;
}

/** One per mounted row. Hands back the array it last returned while the new
 *  one differs only in hidden fields, so those tab objects carry stale
 *  timestamps: fine for drawing, and every row handler acts by tab id. */
export function createRowTabsSelector(taskId: string): (s: AppState) => Tab[] {
  let prev: Tab[] | null = null;
  return (s) => {
    const next = s.tabs[taskId] ?? EMPTY_TABS;
    if (prev && tabListRenderEqual(prev, next)) return prev;
    prev = next;
    return next;
  };
}

export function useRowTabs(taskId: string): Tab[] {
  const select = useMemo(() => createRowTabsSelector(taskId), [taskId]);
  return useApp(select);
}
