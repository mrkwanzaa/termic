// Config sync, the window's half (docs/ideas/config-sync.md, phase 1).
//
// Rust (src-tauri/src/config_sync.rs) owns git and the files. This module
// owns localStorage, which Rust cannot read: every sync command takes a
// snapshot of the registry's "sync" keys from here, and hands back the keys a
// pull changed for this module to write.
//
// Every profile window is a webview on the same origin, so they share one
// localStorage. That is what lets one window snapshot (and write) every bound
// profile's scoped keys, not only its own: a profile's keys are its
// namespace (`profileScope.ts`) plus the bare key. The other windows are told
// to reload their stores from storage, which publishes only what moved.
//
// The performance rule this keeps (docs/performance.md, bear trap 8): a pull
// that changed nothing writes nothing. A key whose stored value already
// matches is not written, and the store reloads compare before they `set`.

import { emit, listen } from "@tauri-apps/api/event";
import { PREF_KEYS } from "@/lib/prefsRegistry";
import { PROFILE_NS } from "@/lib/profileScope";
import { i18n } from "@/lib/i18n";
import { syncLaunchPull, syncNow, syncStatus } from "@/lib/ipc";
import type { SyncChange, SyncPrefsChanges, SyncPrefsSnapshot, SyncRunResult, SyncStatus } from "@/lib/types";
import { reloadPrefsFromStorage, usePrefs } from "@/store/prefs";
import { usePromptLibrary } from "@/store/prompts";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";

const SYNC_KEYS = PREF_KEYS.filter(k => k.class === "sync" && !k.family && !k.legacy);
/** Sync keys every window shares (not `scoped()`): machine-wide. */
export const SHARED_SYNC_KEYS: readonly string[] = SYNC_KEYS.filter(k => !k.scoped).map(k => k.key);
/** Sync keys a profile owns, stored under its namespace. */
export const SCOPED_SYNC_KEYS: readonly string[] = SYNC_KEYS.filter(k => k.scoped).map(k => k.key);

/** Rust's event after a run that changed anything. */
export const SYNC_CHANGED_EVENT = "termic://sync-changed";
/** This module's event once a window has written pulled prefs to storage. */
export const SYNC_PREFS_WRITTEN_EVENT = "termic://sync-prefs-written";

/** A profile's localStorage namespace, as Rust's `profile_ns` spells it. */
const isNamespace = (ns: string) => ns === "" || /^profile-[a-z0-9-]+:$/.test(ns);

function read(storage: Storage, key: string): string | null {
  try { return storage.getItem(key); } catch { return null; }
}

/** The sync keys as stored now: the shared ones, and each namespace's scoped
 *  ones. A key that is absent (reads as its default) is absent here too. */
export function snapshotSyncPrefs(namespaces: readonly string[], storage: Storage = localStorage): SyncPrefsSnapshot {
  const shared: Record<string, string> = {};
  for (const k of SHARED_SYNC_KEYS) {
    const v = read(storage, k);
    if (v !== null) shared[k] = v;
  }
  const scoped: Record<string, Record<string, string>> = {};
  for (const ns of new Set(namespaces)) {
    if (!isNamespace(ns)) continue;
    const m: Record<string, string> = {};
    for (const k of SCOPED_SYNC_KEYS) {
      const v = read(storage, ns + k);
      if (v !== null) m[k] = v;
    }
    scoped[ns] = m;
  }
  return { shared, scoped };
}

export interface WrittenPrefs { shared: string[]; scoped: Record<string, string[]> }

/** Write what a pull changed. Only registry "sync" keys are accepted (a repo
 *  file could name any key, and a local one like `terminalRenderer` must
 *  never arrive from another machine), and only a key whose stored value
 *  differs is written. Returns the keys actually written. */
export function writeSyncPrefs(changes: SyncPrefsChanges, storage: Storage = localStorage): WrittenPrefs {
  const out: WrittenPrefs = { shared: [], scoped: {} };
  const put = (full: string, value: string | null): boolean => {
    if (read(storage, full) === value) return false;
    try {
      if (value === null) storage.removeItem(full);
      else storage.setItem(full, value);
      return true;
    } catch { return false; }
  };
  for (const c of changes.shared) {
    if (SHARED_SYNC_KEYS.includes(c.key) && put(c.key, c.value)) out.shared.push(c.key);
  }
  for (const [ns, cs] of Object.entries(changes.scoped)) {
    if (!isNamespace(ns)) continue;
    for (const c of cs) {
      if (SCOPED_SYNC_KEYS.includes(c.key) && put(ns + c.key, c.value)) (out.scoped[ns] ??= []).push(c.key);
    }
  }
  return out;
}

const wroteAny = (w: WrittenPrefs) => w.shared.length > 0 || Object.values(w.scoped).some(v => v.length > 0);

/** Bring this window's stores up to what storage holds. Each reload compares
 *  before it publishes, so this is free when nothing moved. Every sync key
 *  lives in one of these three stores, which is why nothing a pull brings
 *  waits for a relaunch. */
export function reloadSyncedStores(): boolean {
  const prefs = reloadPrefsFromStorage();
  const prompts = usePromptLibrary.getState().reloadFromStorage();
  const colors = useApp.getState().reloadGroupColors();
  return prefs.length > 0 || prompts || colors;
}

/** Settings a pull can change that only take effect at the next launch. */
export const NEXT_LAUNCH_SETTINGS: readonly string[] = ["auto_install_hooks"];

/** Write a run's prefs, reload, tell the other windows, surface notices. */
export async function applyRunResult(res: SyncRunResult): Promise<void> {
  if (wroteAny(writeSyncPrefs(res.prefs))) {
    reloadSyncedStores();
    void emit(SYNC_PREFS_WRITTEN_EVENT, {}).catch(() => {});
  }
  await surfaceNotices();
}

/** The snapshot every run command takes, for every bound profile. */
export function snapshotFor(st: Pick<SyncStatus, "bound">): SyncPrefsSnapshot {
  return snapshotSyncPrefs([PROFILE_NS, ...st.bound.map(b => b.ns)]);
}

/** "Sync now", or the launch pull. `null` when sync is not set up here. */
export async function runSync(kind: "now" | "launch"): Promise<SyncRunResult | null> {
  const st = await syncStatus();
  if (!st.connected || st.bound.length === 0) return null;
  const snap = snapshotFor(st);
  const res = kind === "now" ? await syncNow(snap) : await syncLaunchPull(snap);
  await applyRunResult(res);
  return res;
}

// ── safety notices ──

/** Field and pref names, for people. Literal keys so the used-keys test sees
 *  them. `t` is i18next's, with namespace-qualified keys. */
export function fieldLabel(field: string, t: (k: string) => string): string {
  switch (field) {
    case "default_yolo": return t("settings:sync.fields.projectYolo");
    case "default_sandbox": return t("settings:sync.fields.projectSandbox");
    case "default_sandbox_mode": return t("settings:sync.fields.projectSandboxMode");
    case "default_docker": return t("settings:sync.fields.projectDocker");
    case "defaultYolo": return t("settings:sync.fields.appYolo");
    case "globalDefaultSandboxKind": return t("settings:sync.fields.appSandbox");
    case "sandboxBypassPermissions": return t("settings:sync.fields.appBypass");
    case "sandboxAllowScope": return t("settings:sync.fields.appAllowScope");
    default: return field;
  }
}

export function valueLabel(v: unknown, t: (k: string) => string): string {
  if (v === null || v === undefined || v === "") return t("settings:sync.values.default");
  if (v === true || v === "1") return t("settings:sync.values.on");
  if (v === false || v === "0") return t("settings:sync.values.off");
  return String(v);
}

/** One safety change as a line: "All projects: Start new tasks in YOLO changed
 *  from Off to On". The verb is in the line on purpose: "YOLO, Off to On" read
 *  as if the setting were called "Off to On". */
export function describeSafety(c: SyncChange, t: (k: string, o?: Record<string, unknown>) => string): string {
  const field = c.kind === "pref" ? fieldLabel(c.target, t) : fieldLabel(c.field ?? "", t);
  const scope = c.kind === "pref" ? t("settings:sync.appWide") : c.target;
  return t("settings:sync.safetyLine", { scope, field, from: valueLabel(c.from, t), to: valueLabel(c.to, t) });
}

/** Announced and kept until dismissed: mirrors `is_notice` in config_sync.rs. */
export function isNotice(c: SyncChange): boolean {
  return c.safety || (c.kind === "agent" && c.action === "remove");
}

/** A notice as a line, for the panel and the toast. An agent removal is
 *  applied, not asked (it deletes no files, unlike removing a project), so
 *  the line says what it costs here. */
export function describeNotice(c: SyncChange, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (c.kind === "agent" && c.action === "remove") return t("settings:sync.agentRemoved", { name: c.target });
  return describeSafety(c, t);
}

let lastToasted = "";

/** Toast the notices a pull made for this window's profile (safety-default
 *  changes, agents removed elsewhere), once per set. They stay listed in
 *  Settings > Sync until dismissed. */
export async function surfaceNotices(): Promise<void> {
  let st: SyncStatus;
  try { st = await syncStatus(); } catch { return; }
  const notices = st.notices.filter(isNotice);
  const sig = JSON.stringify(notices);
  if (!notices.length || sig === lastToasted) return;
  lastToasted = sig;
  const t = i18n.t.bind(i18n) as (k: string, o?: Record<string, unknown>) => string;
  // Each line ends its own sentence: an agent removal is two of them.
  const end = (s: string) => (/[.。]$/.test(s) ? s : `${s}${/[\u4e00-\u9fff]/.test(s) ? "。" : "."}`);
  const lines = notices.slice(0, 3).map(n => end(describeNotice(n, t))).join(" ");
  const more = notices.length > 3 ? ` ${end(t("settings:sync.andMore", { count: notices.length - 3 }))}` : "";
  useUI.getState().pushToast(t("settings:sync.safetyToast", { lines: lines + more }), "warning", {
    sticky: true,
    action: { label: t("settings:sync.review"), onClick: () => useApp.getState().openSettings("sync") },
  });
}

// ── boot ──

let started = false;

/** Once per window, after first paint: listen for runs other windows make,
 *  and run the launch pull (Rust lets only the first window's through). */
export function initConfigSync(): void {
  if (started) return;
  started = true;
  void listen<{ profiles: string[]; themes: boolean }>(SYNC_CHANGED_EVENT, ev => {
    if (ev.payload.profiles.includes(PROFILE_NS)) void useApp.getState().loadAll();
    if (ev.payload.themes) void usePrefs.getState().loadCustomThemes();
    void surfaceNotices();
  }).catch(() => {});
  void listen(SYNC_PREFS_WRITTEN_EVENT, () => { reloadSyncedStores(); }).catch(() => {});
  void runSync("launch").catch(() => {});
}
