import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    // The profile cases turn a dormant install into one with profiles. Put it
    // back whatever they left: the profile that came from the repo is deleted
    // (its own directory, no worktrees), then the feature is switched off,
    // which is the door built for the last profile standing. Before the
    // disconnect, so the delete's "ignore this folder" note goes with the
    // sync state instead of outliving it.
    await browser.execute(async () => {
      const t = window.__termic!;
      const view = await t.invoke("profiles_list");
      for (const p of (view.profiles ?? []).filter((r: any) => !r.is_root)) {
        try { await t.invoke("profile_delete", { slug: p.slug, deleteWorktrees: false }); } catch { /* already gone */ }
      }
      try { await t.invoke("sync_disconnect"); } catch { /* not connected */ }
      try { await t.invoke("profiles_disable"); } catch { /* already dormant */ }
      await t.useProfiles.getState().refresh();
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

  it("refuses a URL git would run as a command or read as an option, before cloning", async () => {
    // `ext::` is a remote helper that runs its argument; a leading `-` is an
    // option to `git clone`. Rust refuses both (check_repo_url); the page
    // names the forms it takes.
    const marker = path.join(root, "sync-ext-ran");
    rmTree(marker, { bestEffort: true });
    await setInputValue('[data-testid="sync-url"]', `ext::sh -c touch% ${marker}`);
    await clickWhenVisible('[data-testid="sync-connect"]');
    await waitVisible('[data-testid="sync-action-error"]');
    expect(await textOf('[data-testid="sync-action-error"]')).toBe(
      "Unsupported repo URL. Use an https://, http://, ssh://, git:// or file:// URL, or user@host:path.");
    await waitVisible('[data-testid="sync-url"]');
    // The option form, straight at the command: the refusal is Rust's.
    const refused = await browser.execute(async () => {
      try { await window.__termic!.invoke("sync_connect", { url: "--upload-pack=touch /tmp/x" }); return "connected"; }
      catch (e) { return String(e); }
    });
    expect(refused).toMatch(/^Unsupported repo URL\./);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(dataDir, "sync"))).toBe(false);
    await snap("sync-bad-url.png");
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

  it("pulls a change when the window regains focus, and not again right away", async () => {
    onOtherMachine(folder => editJson(path.join(folder, "projects", `${original.id}.json`), d => {
      d.preview_url = "http://localhost:4321/e2e-focus";
    }));
    // The launch pull and Sync now just ran, so a focus pull is not due
    // until the recorded attempt is older than five minutes.
    const statePath = path.join(dataDir, "sync-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    state.last_sync_at = old;
    state.last_pull_at = old;
    writeFileSync(statePath, JSON.stringify(state));

    const wasFocused = await browser.execute(() => window.__termic!.useUI.getState().windowFocused);
    await browser.execute(() => {
      const ui = window.__termic!.useUI.getState();
      ui.setWindowFocused(false);
      ui.setWindowFocused(true);
    });
    await browser.waitUntil(async () => (await fixture()).preview_url === "http://localhost:4321/e2e-focus",
      { timeout: 30_000, timeoutMsg: "the focus pull did not apply the other machine's preview URL" });
    await browser.execute((focused) => window.__termic!.useUI.getState().setWindowFocused(focused), wasFocused);

    // Still inside the gap: Rust skips, and this machine does not push.
    const again = await browser.execute(async () => window.__termic!.invoke("sync_focus_pull", { prefs: null }));
    expect(again.skipped).toBe(true);
    expect(git(["--git-dir", bare, "log", "-1", "--format=%s", "main"])).toMatch(/^edit on another machine/);
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
    await waitForText("Sync changed settings on this machine");
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

  // ── profiles follow the repo ──
  //
  // The other machine here has a second profile, "Work". This install has no
  // profiles at all, which is the hard case: taking the profile means turning
  // the feature on. The slot math of who is created, uploaded or left waiting
  // is plan_adoption's, unit-tested in config_sync.rs; these cases are the
  // window's half, that the profile really appears, stays deleted, and can be
  // asked for again.

  const profileNames = () => browser.execute(async () => {
    const view = await window.__termic!.invoke("profiles_list");
    return ((view.profiles ?? []) as { name: string }[]).map(p => p.name).sort();
  });
  const WORK = "E2E Work";

  it("creates a profile here for one another machine added", async () => {
    await openSync();
    await waitVisible('[data-testid="sync-now"]');
    expect(await profileNames()).toEqual([]);

    // Another machine's second profile: a folder of its own, named after its
    // slug, with a name, a colour and one project this machine has no folder
    // for. Written beside this profile's folder, not into it.
    onOtherMachine((mine) => {
      const dir = path.join(path.dirname(mine), "e2e-work");
      mkdirSync(path.join(dir, "projects"), { recursive: true });
      writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ accent: "orange", name: WORK }, null, 2) + "\n");
      writeFileSync(path.join(dir, "projects", "work-only.json"), JSON.stringify({
        id: "work-only", name: "work-only-app", non_git: false, position: 0,
        remote_url: "https://git.acme.com/acme/work-only-app.git", subdir: "", type: "single",
      }, null, 2) + "\n");
    });
    await syncNow();

    await browser.waitUntil(async () => (await profileNames()).includes(WORK),
      { timeout: 15_000, timeoutMsg: "the other machine's profile was never created here" });
    // The report says so in words, since a new profile is not a silent change.
    expect(await textOf('[data-testid="sync-result-list"]')).toContain(`Create profile ${WORK} on this machine`);
    // And the window learned without a reload: the chip only renders once
    // profiles exist, so its presence is the profile list having refreshed.
    await waitVisible('[data-testid="profile-chip"]');
    const made = await browser.execute(async (name) => {
      const view = await window.__termic!.invoke("profiles_list");
      return (view.profiles as any[]).find(p => p.name === name) ?? null;
    }, WORK);
    expect(made.accent).toBe("orange");
    expect(made.is_root).toBe(false);
    // This window's own profile is untouched: still following its folder.
    expect(await textOf('[data-testid="sync-folder-name"]')).not.toContain("e2e-work");
    await snap("sync-profile-created.png");
  });

  it("a profile deleted here stays deleted, and Settings offers it back", async () => {
    const slug = await browser.execute(async (name) => {
      const view = await window.__termic!.invoke("profiles_list");
      return (view.profiles as any[]).find(p => p.name === name).slug as string;
    }, WORK);
    await browser.execute(async (s) => {
      await window.__termic!.invoke("profile_delete", { slug: s, deleteWorktrees: false });
    }, slug);
    expect(await profileNames()).not.toContain(WORK);

    // The sync that would have recreated it.
    await openSync();
    await syncNow();
    expect(await profileNames()).not.toContain(WORK);
    // Still in the repo for every other machine.
    expect(remoteFiles()).toContain("profiles/e2e-work/profile.json");

    // Listed, with the way back.
    await waitVisible('[data-testid="sync-ignored-e2e-work"]');
    expect(await textOf('[data-testid="sync-ignored-e2e-work"]')).toContain(WORK);
    await snap("sync-profile-ignored.png");
    await clickWhenVisible('[data-testid="sync-restore-e2e-work"]');
    await browser.waitUntil(async () => (await profileNames()).includes(WORK),
      { timeout: 30_000, timeoutMsg: "Create here did not bring the profile back" });
    await waitGone('[data-testid="sync-ignored"]');
    await browser.execute(() => window.__termic!.useUI.setState({ toasts: [] }));
  });
});
