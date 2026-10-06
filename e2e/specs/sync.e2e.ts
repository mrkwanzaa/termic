import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dataDir } from "../../wdio.conf.js";
import {
  clickWhenVisible, requireTermicApi, rmTree, setInputValue, snap, textOf,
  waitForAppShell, waitForText, waitGone, waitVisible,
} from "../helpers";

// Config sync (docs/ideas/config-sync.md, phase 1): Settings > Sync against a
// local bare repo reached over file://. The spec plays "another machine" by
// cloning that repo, editing a file and pushing, which is all another termic
// would do. No real remote, host or user anywhere.
//
// What the spec must never touch: localStorage and the themes folder. The e2e
// binary shares localStorage with an installed Termic (the webview keys it by
// app identifier), and the themes folder is the user's real one. So every
// "other machine" commit edits project files only, never prefs.json or
// themes/: a pull then writes no pref and no theme here. Export only READS
// both.
//
// It owns two global mutations, both undone in `after` whatever the body did:
// the profile's sync binding (Disconnect removes the clone and its state) and
// the fixture project's preview URL and YOLO default.

const root = path.dirname(dataDir);
const bare = path.join(root, "sync-remote.git");
const other = path.join(root, "sync-other-machine");
const url = pathToFileURL(bare).href;
const SECRET = "e2e-sync-secret-value";

function git(args: string[], cwd = root): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Files on the remote's main branch. */
function remoteFiles(): string[] {
  return git(["--git-dir", bare, "ls-tree", "-r", "--name-only", "main"]).split("\n").filter(Boolean);
}

/** Paths on the remote whose content contains `needle` (git grep exits 1 on
 *  no match, which is the answer we usually want). */
function remoteGrep(needle: string): string[] {
  try {
    return git(["--git-dir", bare, "grep", "-I", "-l", needle, "main"]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Be the other machine: clone, change files in this profile's folder, push. */
function onOtherMachine(edit: (folder: string) => void): void {
  rmTree(other, { bestEffort: true });
  git(["clone", "-q", url, other]);
  const sid = readdirSync(path.join(other, "profiles"))[0];
  edit(path.join(other, "profiles", sid));
  git(["add", "-A"], other);
  git(["-c", "user.email=e2e@termic.dev", "-c", "user.name=e2e", "commit", "-q", "-m", "edit on another machine"], other);
  git(["push", "-q", "origin", "HEAD:main"], other);
}

/** Rewrite one JSON file the way termic writes them: keys in the order they
 *  were read (already sorted), two-space indent, trailing newline. */
function editJson(file: string, f: (doc: Record<string, unknown>) => void): void {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  f(doc);
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
}

async function fixture(): Promise<{ id: string; preview_url: string; default_yolo: boolean | null }> {
  return await browser.execute(() => {
    const p = window.__termic!.useApp.getState().projects.find((x: any) => x.name === "fixture-repo");
    return { id: p.id, preview_url: p.preview_url, default_yolo: p.default_yolo ?? null };
  });
}

async function patchFixture(fields: Record<string, unknown>): Promise<void> {
  await browser.execute(async (f) => {
    const t = window.__termic!;
    const p = t.useApp.getState().projects.find((x: any) => x.name === "fixture-repo");
    await t.invoke("project_update", { p: { ...p, ...f } });
    await t.useApp.getState().loadAll();
  }, fields);
}

const openSync = () => browser.execute(() => window.__termic!.useApp.getState().openSettings("sync"));
const syncNow = async () => {
  await clickWhenVisible('[data-testid="sync-now"]');
  // The button relabels while a sync runs; it is back when the run is done.
  await browser.waitUntil(async () => (await textOf('[data-testid="sync-now"]')).includes("Sync now"),
    { timeout: 30_000, timeoutMsg: "Sync now never finished" });
};

describe("config sync", () => {
  let original: { id: string; preview_url: string; default_yolo: boolean | null };
  let originalAgents: unknown[];

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    rmTree(bare, { bestEffort: true });
    rmTree(other, { bestEffort: true });
    // `-b main`: a bare repo whose HEAD names a branch nobody pushed clones
    // with nothing checked out, which is the other machine's problem, not
    // the one under test (termic handles it; ensure_branch in config_sync.rs).
    git(["init", "-q", "--bare", "-b", "main", bare]);
    // A run that died half way leaves the profile bound to a repo that is
    // gone; start from "not connected" whatever happened before.
    await browser.execute(async () => {
      try { await window.__termic!.invoke("sync_disconnect"); } catch { /* not connected */ }
    });
    original = await fixture();
    originalAgents = await browser.execute(async () =>
      (await window.__termic!.invoke("settings_load")).agents);
  });

  after(async () => {
    await browser.execute(async () => {
      try { await window.__termic!.invoke("sync_disconnect"); } catch { /* not connected */ }
    });
    await patchFixture({ preview_url: original.preview_url, default_yolo: original.default_yolo });
    await browser.execute(async (agents) => {
      await window.__termic!.invoke("agents_save", { agents });
      window.__termic!.useUI.setState({ toasts: [] });
      window.__termic!.useApp.getState().closeSettings();
    }, originalAgents);
    rmTree(bare, { bestEffort: true });
    rmTree(other, { bestEffort: true });
  });

  it("says what never syncs, before anything is connected", async () => {
    await openSync();
    await waitVisible('[data-testid="sync-url"]');
    const note = await textOf('[data-testid="sync-never"]');
    expect(note).toContain("Agent environment variables (env and Docker env) never sync");
    expect(note).toContain("paths, port ranges, logins and tokens");
    await snap("sync-disconnected.png");
  });

  it("pushes this setup to an empty repo, without an agent's env", async () => {
    // A secret in an agent's env, the way people put API keys there.
    await browser.execute(async (secret) => {
      const t = window.__termic!;
      const agents = (await t.invoke("settings_load")).agents.map((a: any) =>
        a.id === "fakeagent" ? { ...a, env: { ...a.env, E2E_SYNC_TOKEN: secret } } : a);
      await t.invoke("agents_save", { agents });
    }, SECRET);
    await setInputValue('[data-testid="sync-url"]', url);
    await clickWhenVisible('[data-testid="sync-connect"]');
    await waitVisible('[data-testid="sync-now"]', 30_000);
    await waitForText("Synced and pushed.");

    const files = remoteFiles();
    const folder = files.find(f => f.endsWith("/profile.json"))!.split("/").slice(0, 2).join("/");
    expect(files).toEqual(expect.arrayContaining([
      "README.md", "prefs.json",
      `${folder}/settings.json`, `${folder}/agents/fakeagent.json`, `${folder}/projects/${original.id}.json`,
    ]));
    expect(git(["--git-dir", bare, "log", "-1", "--format=%s", "main"])).toMatch(/^sync from \S/);
    expect(remoteGrep(SECRET)).toEqual([]);
    expect(remoteGrep("E2E_SYNC_TOKEN")).toEqual([]);
    // No local field either: a project's path, the repos folder, an agent's
    // allowed paths.
    expect(remoteGrep('"root_path"')).toEqual([]);
    expect(remoteGrep('"repos_dir"')).toEqual([]);
    expect(remoteGrep('"sandbox_allowed_paths"')).toEqual([]);
    expect(await textOf('[data-testid="sync-folder-name"]')).toContain(folder);
    // Repo and Folder values start on one line, whatever the labels measure.
    const lefts = await browser.execute(() =>
      ['[data-testid="sync-repo-url"]', '[data-testid="sync-folder-name"]']
        .map(sel => Math.round(document.querySelector(sel)!.getBoundingClientRect().left)));
    expect(lefts[0]).toBe(lefts[1]);
    await snap("sync-connected.png");
  });

  it("pulls and applies a change made on another machine", async () => {
    onOtherMachine(folder => editJson(path.join(folder, "projects", `${original.id}.json`), d => {
      d.preview_url = "http://localhost:4321/e2e-sync";
    }));
    await syncNow();
    await browser.waitUntil(async () => (await textOf('[data-testid="sync-result"]')).includes("fixture-repo: preview_url"),
      { timeout: 15_000, timeoutMsg: "the pulled change is not in the sync report" });
    expect((await fixture()).preview_url).toBe("http://localhost:4321/e2e-sync");
  });

  it("shows a YOLO default another machine changed, until dismissed", async () => {
    onOtherMachine(folder => editJson(path.join(folder, "projects", `${original.id}.json`), d => {
      d.default_yolo = true;
    }));
    await syncNow();
    await waitVisible('[data-testid="sync-notices"]');
    const notice = await textOf('[data-testid="sync-notices"]');
    expect(notice).toContain("fixture-repo: Start new tasks in YOLO changed from");
    expect(notice).toContain("to On");
    // Announced, and kept in the panel; the report counts it without
    // repeating the line a third time on the same screen.
    await waitForText("Sync changed a YOLO or sandbox default");
    const report = await textOf('[data-testid="sync-result"]');
    expect(report).toContain("1 change from the repo applied.");
    expect(report).not.toContain("Start new tasks in YOLO");
    expect(await browser.execute(() =>
      document.querySelectorAll('[data-testid="sync-result"] [data-testid="sync-change-safety"]').length)).toBe(0);
    expect((await fixture()).default_yolo).toBe(true);
    await snap("sync-safety-notice.png");
    await clickWhenVisible('[data-testid="sync-notices-dismiss"]');
    await waitGone('[data-testid="sync-notices"]');
    await browser.execute(() => window.__termic!.useUI.setState({ toasts: [] }));
  });

  it("lists a project with no folder here as waiting, and remembers Skip", async () => {
    onOtherMachine(folder => {
      writeFileSync(path.join(folder, "projects", "e2e-sync-elsewhere.json"), JSON.stringify({
        id: "e2e-sync-elsewhere", members: [], name: "elsewhere-app", non_git: false, position: 900,
        remote_url: "https://git.acme.com/acme/elsewhere.git", type: "single",
      }, null, 2) + "\n");
      writeFileSync(path.join(folder, "projects", "e2e-sync-notes.json"), JSON.stringify({
        id: "e2e-sync-notes", members: [], name: "notes-folder", non_git: true, position: 901, type: "single",
      }, null, 2) + "\n");
    });
    await syncNow();
    await waitVisible('[data-testid="sync-waiting-e2e-sync-elsewhere"]');
    await waitVisible('[data-testid="sync-locate-e2e-sync-elsewhere"]');
    // A plain folder has no URL to match, so it always waits.
    expect(await textOf('[data-testid="sync-waiting-e2e-sync-notes"]')).toContain("Plain folder");
    expect(await textOf('[data-testid="sync-waiting-e2e-sync-elsewhere"]')).toContain("git.acme.com/acme/elsewhere");
    const names = await browser.execute(() =>
      window.__termic!.useApp.getState().projects.map((p: any) => p.name));
    expect(names).not.toContain("elsewhere-app");
    // One count in the report: the section below names them, and nothing
    // was applied.
    const report = await textOf('[data-testid="sync-result"]');
    expect(report).toContain("2 projects wait for a folder.");
    expect(report).not.toContain("elsewhere-app");
    expect(report).not.toContain("from the repo applied");
    await snap("sync-waiting.png");

    await clickWhenVisible('[data-testid="sync-skip-e2e-sync-elsewhere"]');
    await waitVisible('[data-testid="sync-skipped-e2e-sync-elsewhere"]');
    await waitGone('[data-testid="sync-waiting-e2e-sync-elsewhere"]');
    // Still skipped after another pull.
    await syncNow();
    await waitVisible('[data-testid="sync-skipped-e2e-sync-elsewhere"]');
    await clickWhenVisible('[data-testid="sync-unskip-e2e-sync-elsewhere"]');
    await waitVisible('[data-testid="sync-waiting-e2e-sync-elsewhere"]');
  });

  it("previews a first connect to a repo with a setup, and applies only on confirm", async () => {
    await clickWhenVisible('[data-testid="sync-disconnect"]');
    await waitVisible('[data-testid="sync-url"]');
    // This machine's YOLO default differs from the repo's again.
    await patchFixture({ default_yolo: original.default_yolo });

    await setInputValue('[data-testid="sync-url"]', url);
    await clickWhenVisible('[data-testid="sync-connect"]');
    await waitVisible('[data-testid="sync-folder-option-new"]', 30_000);
    const options = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid^="sync-folder-option-"]')].map(e => ({
        id: e.getAttribute("data-testid"), checked: (e.querySelector("input") as HTMLInputElement).checked,
      })));
    expect(options).toHaveLength(2);
    expect(options[0].checked).toBe(true);

    await clickWhenVisible('[data-testid="sync-preview"]');
    await waitVisible('[data-testid="sync-preview-panel"]');
    const safety = await textOf('[data-testid="sync-preview-list"] [data-testid="sync-change-safety"]');
    expect(safety).toContain("fixture-repo: Start new tasks in YOLO changed from");
    expect(await textOf('[data-testid="sync-preview-list"]')).toContain("elsewhere-app waits for a folder");
    await snap("sync-preview.png");

    // Cancel applies nothing.
    await clickWhenVisible('[data-testid="sync-preview-cancel"]');
    await waitGone('[data-testid="sync-preview-panel"]');
    expect((await fixture()).default_yolo).toBe(original.default_yolo);

    await clickWhenVisible('[data-testid="sync-preview"]');
    await clickWhenVisible('[data-testid="sync-apply"]');
    await waitVisible('[data-testid="sync-now"]', 30_000);
    await browser.waitUntil(async () => (await fixture()).default_yolo === true,
      { timeout: 15_000, timeoutMsg: "the confirmed first connect did not apply the repo's YOLO default" });
    await browser.execute(() => window.__termic!.useUI.setState({ toasts: [] }));
  });
});
