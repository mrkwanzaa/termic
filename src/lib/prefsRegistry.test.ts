// The registry in prefsRegistry.ts must list exactly the localStorage keys the
// app uses: a key in source that the registry does not list fails here, and so
// does a listed key nothing uses any more.
//
// Source-level like src/locales/usedKeys.test.ts, and for the same reason:
// exercising every store and pane to watch which keys get touched would only
// prove the keys of the paths a test happened to take.
//
// What counts as a use, after comments are stripped:
//   - `scoped("x")`, which also says the key is profile-scoped
//   - a constant `LS = "x"` or `LS_ANYTHING = "x"`
//   - a literal handed straight to localStorage: `localStorage.getItem("x")`
//   - a literal handed to a local helper whose first parameter is `k` or
//     `key` (`lsGetBool("x", false)` in prefs.ts), the convention every
//     helper here already follows
//   - a template handed to either, `getItem(\`x:${id}\`)`, which must fall in
//     a registered family
//   - the old names in lsMigration.ts's RENAMES table
//
// Any other expression handed to localStorage or a helper fails unless
// PASS_THROUGH below names it. That is what catches a key nobody can see: a
// constant not named LS_*, or a new builder like pr.ts's `mergeKey()`. The
// blind spot left is a helper called with a literal from ANOTHER file than the
// one defining it, which nothing does today.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PREF_KEYS } from "./prefsRegistry";

/** Non-literal keys allowed as the first argument to localStorage.getItem,
 *  setItem, removeItem or a helper, and the family each one builds (null: it
 *  forwards a key some other rule already sees). */
const PASS_THROUGH: Record<string, string | null> = {
  // The parameter of a helper like `lsGet(k)` or `readBool(key)`. Its call
  // sites are scanned instead, see `helperNames`.
  k: null,
  key: null,
  // lsMigration.ts's rename loop over RENAMES, scanned separately.
  oldKey: null,
  newKey: null,
  // RightPanel.tsx's ScriptStream prop, built as `hideRunPrompt:${activeKey}`.
  dismissKey: "hideRunPrompt:",
  // pr.ts's builder for `prMergeHandled:${taskId}:${provider}:${number}`.
  mergeKey: "prMergeHandled:",
};

const SELF = "src/lib/prefsRegistry.ts";
const MIGRATION = "src/lib/lsMigration.ts";

interface Use { key: string; scoped: boolean; file: string }
interface Scan {
  uses: Use[];
  /** Static heads of templates handed to localStorage or a helper. */
  familyUses: { head: string; file: string }[];
  /** Static head of EVERY template in the file, for the reverse check. */
  templateHeads: string[];
  /** Non-literal keys handed to localStorage or a helper, not named LS_*. */
  args: { expr: string; file: string }[];
}

function stripComments(src: string): string {
  // Same treatment as usedKeys.test.ts: dozens of comments here say things
  // like `localStorage.ptyDebug = "1"`, and they are documentation, not uses.
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Names of the functions in this file whose first parameter is `k` or `key`,
 *  in a file that hands a `k` or `key` to localStorage at all. Elsewhere a
 *  `key` is a keyboard key (shortcuts.ts has dozens). */
function helperNames(src: string): string[] {
  if (!/\blocalStorage\.(?:get|set|remove)Item\(\s*(?:k|key)\b/.test(src)) return [];
  return [
    ...[...src.matchAll(/\bfunction\s+(\w+)\s*\(\s*(?:k|key)\b/g)].map(m => m[1]),
    ...[...src.matchAll(/\bconst\s+(\w+)\s*=\s*\(\s*(?:k|key)\b/g)].map(m => m[1]),
  ];
}

function scan(file: string, raw: string): Scan {
  const src = stripComments(raw);
  const out: Scan = { uses: [], familyUses: [], templateHeads: [], args: [] };
  const bare = (key: string) => out.uses.push({ key, scoped: false, file });
  const helpers = helperNames(src);
  // localStorage itself, and every helper that forwards a key to it.
  const callers = ["\\blocalStorage\\.(?:get|set|remove)Item", ...helpers.map(h => `\\b${h}`)];

  for (const m of src.matchAll(/\bscoped\(\s*"([^"]+)"\s*\)/g)) out.uses.push({ key: m[1], scoped: true, file });
  for (const m of src.matchAll(/\bLS(?:_[A-Z0-9_]+)?\s*=\s*"([^"]+)"/g)) bare(m[1]);
  for (const call of callers) {
    for (const m of src.matchAll(new RegExp(`${call}\\(\\s*"([^"]+)"`, "g"))) bare(m[1]);
    for (const m of src.matchAll(new RegExp(`${call}\\(\\s*\`([^\`$]*)\\$\\{`, "g"))) {
      out.familyUses.push({ head: m[1], file });
    }
    for (const m of src.matchAll(new RegExp(`${call}\\(\\s*([A-Za-z_$][\\w$]*)`, "g"))) {
      if (!/^LS(?:_[A-Z0-9_]+)?$/.test(m[1])) out.args.push({ expr: m[1], file });
    }
  }
  for (const m of src.matchAll(/`([^`$]*)\$\{/g)) out.templateHeads.push(m[1]);
  return out;
}

/** Old names from lsMigration.ts's RENAMES table, and the names they became. */
function renames(raw: string): [string, string][] {
  const block = stripComments(raw).match(/\bconst RENAMES\b[\s\S]*?\];/)?.[0] ?? "";
  return [...block.matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/g)].map(m => [m[1], m[2]]);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // Forward slashes on Windows too, so paths compare against SELF.
    const p = join(dir, name).replace(/\\/g, "/");
    if (statSync(p).isDirectory()) {
      // Test helpers seed keys for tests; they are not the app using them.
      if (p !== "src/test") sourceFiles(p, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    if (p === SELF) continue;
    out.push(p);
  }
  return out;
}

const exact = new Map(PREF_KEYS.filter(e => !e.family).map(e => [e.key, e]));
const families = PREF_KEYS.filter(e => e.family);
const familyOf = (head: string) => families.find(f => head.startsWith(f.key));

describe("localStorage prefs registry", () => {
  const files = sourceFiles("src");
  const scans = files.map(f => scan(f, readFileSync(f, "utf8")));
  const uses = scans.flatMap(s => s.uses);
  const familyUses = scans.flatMap(s => s.familyUses);
  const templateHeads = scans.flatMap(s => s.templateHeads);
  const args = scans.flatMap(s => s.args);
  const migrated = renames(readFileSync(MIGRATION, "utf8"));

  it("finds the source at all", () => {
    // Guards the scanner: if a regex stops matching, every check below passes
    // against an empty list.
    expect(files.length).toBeGreaterThan(100);
    expect(uses.length).toBeGreaterThan(100);
    expect(migrated.length).toBeGreaterThan(0);
  });

  it("lists every key the source uses", () => {
    const missing = uses.filter(u => !exact.has(u.key)).map(u => `${u.key}  (${u.file})`);
    expect([...new Set(missing)],
      "These localStorage keys are used but not in src/lib/prefsRegistry.ts. "
      + "Add each with `scoped` and a sync/local class:\n  " + missing.join("\n  "),
    ).toEqual([]);
  });

  it("records whether each key is profile-scoped", () => {
    const wrong: string[] = [];
    for (const u of uses) {
      const e = exact.get(u.key);
      if (!e || e.scoped === u.scoped) continue;
      wrong.push(`${u.key}: registry says scoped=${e.scoped}, ${u.file} uses it ${u.scoped ? "through scoped()" : "bare"}`);
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("puts every runtime-built key in a registered family", () => {
    const orphans = familyUses.filter(u => !familyOf(u.head)).map(u => `\`${u.head}\${...}\`  (${u.file})`);
    expect(orphans, "Register a `family: true` entry for:\n  " + orphans.join("\n  ")).toEqual([]);
    for (const [expr, family] of Object.entries(PASS_THROUGH)) {
      if (family) expect(families.map(f => f.key), `PASS_THROUGH.${expr}`).toContain(family);
    }
  });

  it("can see every key handed to localStorage", () => {
    const lines = args.filter(a => !(a.expr in PASS_THROUGH)).map(a => `${a.expr}  (${a.file})`);
    expect(lines,
      "localStorage is given a key this test cannot read. Name the constant "
      + "LS_*, or register its family and add the expression to PASS_THROUGH:\n  "
      + lines.join("\n  "),
    ).toEqual([]);
    const seen = new Set(args.map(a => a.expr));
    const unused = Object.keys(PASS_THROUGH).filter(e => !seen.has(e));
    expect(unused, "PASS_THROUGH names an expression nothing passes any more").toEqual([]);
  });

  it("lists no key nothing uses any more", () => {
    const used = new Set(uses.map(u => u.key));
    const oldNames = new Set(migrated.map(([from]) => from));
    const stale: string[] = [];
    for (const e of PREF_KEYS) {
      if (e.family) {
        if (!templateHeads.some(h => h.startsWith(e.key))) stale.push(e.key);
      } else if (!used.has(e.key) && !(e.legacy && oldNames.has(e.key))) {
        stale.push(e.key);
      }
    }
    expect(stale, "Listed in src/lib/prefsRegistry.ts but used nowhere: " + stale.join(", ")).toEqual([]);
  });

  it("keeps lsMigration.ts's renames in step", () => {
    for (const [from, to] of migrated) {
      expect(exact.get(from)?.legacy, `${from} (old name) must be listed with legacy: true`).toBe(true);
      expect(exact.get(to)?.legacy, `${to} (new name) must be listed, not as legacy`).toBeUndefined();
    }
  });

  it("is well-formed", () => {
    const keys = PREF_KEYS.map(e => e.key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i), "duplicate keys").toEqual([]);
    for (const e of PREF_KEYS) {
      if (e.class === "local") expect(e.reason.trim(), `${e.key} needs a reason`).not.toBe("");
      // A legacy key is read once to carry its value to the new name, and the
      // new name is the one that syncs.
      if (e.legacy) expect(e.class, `${e.key} is legacy`).toBe("local");
    }
  });
});

describe("the scanner", () => {
  // Proves each spelling is seen, so a regex that silently stops matching
  // fails here rather than passing every check above.
  const keysOf = (src: string) => scan("src/x.ts", src).uses.map(u => `${u.key}${u.scoped ? " (scoped)" : ""}`);

  it("sees a constant, a scoped key, a direct literal and a helper literal", () => {
    expect(keysOf(`const LS_FOO = "foo";`)).toEqual(["foo"]);
    expect(keysOf(`export const LS = "bar";`)).toEqual(["bar"]);
    expect(keysOf(`const LS_BAZ = scoped("baz");`)).toEqual(["baz (scoped)"]);
    expect(keysOf(`try { return localStorage.getItem("qux") === "1"; } catch {}`)).toEqual(["qux"]);
    expect(keysOf(`const lsGet = (k: string) => localStorage.getItem(k);\nlsGet("quux");`)).toEqual(["quux"]);
  });

  it("ignores comments", () => {
    expect(keysOf(`// localStorage.getItem("foo")\n/* scoped("bar") */`)).toEqual([]);
  });

  it("reports a key it cannot read, and a template's family", () => {
    // Through a helper as well as straight to localStorage.
    const helper = scan("src/x.ts", `function persist(key: string) { localStorage.setItem(key, "1"); }\npersist(OTHER); persist(\`h:\${id}\`);`);
    expect(helper.args.map(a => a.expr).filter(e => !(e in PASS_THROUGH))).toEqual(["OTHER"]);
    expect(helper.familyUses.map(u => u.head)).toEqual(["h:"]);
    const s = scan("src/x.ts", `localStorage.setItem(STORAGE_KEY, "1"); localStorage.getItem(\`fam:\${id}\`);`);
    expect(s.args.map(a => a.expr)).toEqual(["STORAGE_KEY"]);
    expect(s.familyUses.map(u => u.head)).toEqual(["fam:"]);
  });
});
