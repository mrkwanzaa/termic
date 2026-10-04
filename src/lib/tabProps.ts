// Tab properties (GH #358): small key/value labels an agent puts on its own
// tab with `termic prop`, collected on the task's sidebar row. This module
// is the ONE implementation of the collect rule: the sidebar renders it and
// cliAgentState pushes it to Rust for `list` / `status`, so the CLI and the
// window cannot describe the same tabs two ways.

import type { Tab, TabProp, TerminalTab } from "@/lib/types";

/** Mirrors termic-proto's PROP_* limits; the server validates first, these
 *  only guard the store against a caller that skipped it. */
export const PROP_KEY_MAX = 32;
export const PROP_VALUE_MAX = 40;
export const PROP_KEYS_PER_TAB = 8;
const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Why `key` cannot be a property key, or null. Mirror of
 *  `termic_proto::prop_key_problem`. */
export function propKeyProblem(key: string): string | null {
  if (!KEY_RE.test(key)) {
    return `property key "${key}" must be lowercase letters, digits, - and _, starting with a letter or digit`;
  }
  if ([...key].length > PROP_KEY_MAX) return `a property key is longer than ${PROP_KEY_MAX} characters`;
  return null;
}

/** Why `value` cannot be a property value, or null. "" clears the key. */
export function propValueProblem(value: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return "a property value must be one line, with no control characters";
  }
  if ([...value.trim()].length > PROP_VALUE_MAX) {
    return `a property value is longer than ${PROP_VALUE_MAX} characters`;
  }
  return null;
}

/** The tab's props after setting `key` to `value` ("" removes it), or the
 *  SAME array when nothing changes, so the store can bail without a write
 *  (bear trap 8). A new key goes last with `since = now`; an existing key
 *  keeps its `since`, which is what keeps it in place on the task row.
 *  Returns "too_many" when the write would add a ninth key. */
export function applyProp(
  props: TabProp[] | undefined, key: string, value: string, now: number,
): TabProp[] | undefined | "too_many" {
  const list = props ?? [];
  const v = value.trim();
  const at = list.findIndex(p => p.key === key);
  if (!v) {
    if (at < 0) return props;
    const next = list.filter((_, i) => i !== at);
    return next.length ? next : undefined;
  }
  if (at >= 0) {
    if (list[at].value === v) return props;
    return list.map((p, i) => (i === at ? { ...p, value: v } : p));
  }
  if (list.length >= PROP_KEYS_PER_TAB) return "too_many";
  return [...list, { key, value: v, since: now }];
}

/** One key of the task's collected view. */
export interface CollectedProp {
  key: string;
  /** Distinct values, in tab strip order. */
  values: string[];
}

/** The task row's view of its tabs' properties: one entry per key, keys in
 *  the order each was FIRST set anywhere in the task (ties: tab order), and
 *  for each key the distinct values in tab strip order, so one tab on
 *  ticket ABC-1 and another on ABC-2 read "ABC-1, ABC-2". */
export function collectTaskProps(tabs: Tab[] | undefined): CollectedProp[] {
  const firstSet = new Map<string, number>();
  const values = new Map<string, string[]>();
  for (const t of tabs ?? []) {
    if (t.type !== "terminal") continue;
    for (const p of (t as TerminalTab).props ?? []) {
      const since = firstSet.get(p.key);
      if (since === undefined || p.since < since) firstSet.set(p.key, p.since);
      const vs = values.get(p.key) ?? [];
      if (!vs.includes(p.value)) vs.push(p.value);
      values.set(p.key, vs);
    }
  }
  // Map insertion order is first-seen-in-tab-order, which is the tiebreak;
  // a stable sort by `since` keeps it for equal timestamps.
  return [...values.keys()]
    .sort((a, b) => firstSet.get(a)! - firstSet.get(b)!)
    .map(key => ({ key, values: values.get(key)! }));
}

/** The row text for a collected view: each key's values joined with ", ",
 *  keys separated by " · ". Empty string when there is nothing to show. */
export function collectedText(collected: CollectedProp[]): string {
  return collected.map(c => c.values.join(", ")).join(" · ");
}
