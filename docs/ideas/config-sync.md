# Future work: config sync through a git repo

Not built, not approved. Everything a user sets up in termic (projects,
project folders and their colors, per-project overrides, custom agents,
prompts, shortcuts, prefs) lives on one machine. A second laptop, or a
reinstall, starts from nothing. This file proposes syncing that setup
through a private git repo the user owns, and lists what has to be
decided before anyone builds it.

## The request

Set termic up once, and get the same setup on every machine:

- the project list, with its folders, folder colors and order
- per-project settings (scripts, `files_to_copy`, preview URL, default
  agent, sandbox defaults)
- custom agents and their args
- shortcuts, the prompt library, fonts, themes and the other prefs

A backup comes with it: the repo's history is a record of every change,
and a bad edit can be reverted.

## Why a git repo

- **Nothing new to authenticate.** termic already shells out to `git`
  with the user's own environment (`git_command` in `lib.rs`), so the
  user's SSH keys and credential helper just work. No OAuth client, no
  tokens stored by termic, no server.
- **No new outbound host.** The remote is the user's own, reached by the
  same `git` that already fetches their task branches. termic.dev/local
  publishes `connect-src` as proof the webview only talks to termic.dev,
  and a Google Drive integration would make that claim false even if it
  ran from Rust, where the CSP does not reach.
- **Conflicts are explicit.** Two machines editing the same file get a
  merge git can report, instead of the silent `settings 2.json` copies
  that iCloud Drive and Dropbox make.
- **It works everywhere termic runs**, including the Windows port.

Rejected:

- **Native iCloud or Google Drive APIs.** CloudKit needs Apple
  entitlements, has no Tauri binding, and is Apple-only. Drive needs an
  OAuth client, token storage and Google's app verification. Both add a
  vendor to an app whose pitch is that it is entirely on-device.
- **Pointing the data dir at a cloud folder.** `tasks/` holds this
  machine's worktree paths and port blocks, `logins/` holds credentials,
  and file-sync clients evict and conflict-copy live JSON. Two machines
  writing `projects.json` through one would corrupt it.
- **Manual export/import only.** A reasonable first step, and phase 1
  below is close to it, but it leaves the user to remember to do it.

## What syncs and what never does

The rule of thumb: **anything that names a path, a binary, a port range,
a hardware fact or a credential stays on the machine.** Everything else
is the user's preference and follows them.

That is why two fields that [data-model.md](../data-model.md) both calls
"personal" land on different sides. `preview_browser` is a launch
command, and `open -a "Google Chrome"` is a dead link on Linux. `group`,
or a project's default agent, means the same thing on every machine.

Sync is personal config only. It never reads or writes `.termic.yaml`:
team config already travels with the repo it belongs to.

| Store | Syncs | Stays local |
|---|---|---|
| `projects.json` | `id`, `name`, `group`, position in the list, `base_branch`, scripts and `run_scripts`, `files_to_copy`, `preview_url`, `default_cli`, sandbox, Docker and YOLO defaults (see open question 2), `sandbox_allowed_hosts`, `extra_named_ports`, `on_pr_merge`, PR watch flags, code-intel toggles and settings, members (without paths) | `root_path`, `tasks_path`, `remote` (a remote NAME in this clone), `preview_browser`, `sandbox_rw_paths`, `docker_extra_mounts`, `code_intel_servers`, `code_intel_commands` |
| `settings.json` | `agents` (see below), `file_tree_exclude`, `sandbox_default_allowed_hosts`, Docker rebuild settings, `fetch_before_create`, `close_action`, `tray_enabled`, `auto_install_hooks` | `repos_dir`, `default_tasks_path`, `preview_browser`, `task_port_min` / `task_port_max`, `sandbox_default_rw_paths`, `docker_default_extra_mounts`, `docker_agent_extra_dirs`, `discovery_dismissed` (paths), CLI and MCP install state, `welcomed`, `schema_version` |
| Agents | `id`, name, `command`, `args`, `yolo_args`, icon and color, capabilities, `sandbox_allowed_hosts`, account NAMES, `default_account`, `extends`, `kind` | `adopted_account` (the login that already existed on THIS machine), `disabled` (often hides a CLI not installed here), `sandbox_allowed_paths`, and `env` / `docker_env` (never, see below) |
| `localStorage` | fonts and sizes, editor and terminal themes, theme mode, shortcuts, the prompt library, folder colors, indicators, confirm-before prompts, branch prefix, language, sounds | collapse state, recent tasks, split and panel sizes, last New Task mode, `terminalRenderer` and GPU (hardware), `uiScale` (display), `openWithApp` (an app installed here) |
| `~/.config/termic/themes/` | all of it | |
| Never | | `tasks/`, `scratch/`, `logins/`, `docker-agents/`, `docker-forge/`, the CLI token, window state, `servers/`, `backups/` |

The `localStorage` row is a summary. The per-key answer, including the
keys the table does not name, is `src/lib/prefsRegistry.ts`.

**`Agent.env` and `docker_env` are where people put API keys**, so they
never sync by default. A private repo is still a copy of the secret on a
forge's disk.

## Shape of the sync repo

```
<sync repo>/
  README.md                   written once: what this is, do not hand-edit
  profiles/<sync-id>/
    projects/<project-id>.json
    agents/<agent-id>.json
    settings.json
    prefs.json
    removed.json              tombstones, see "Deletions"
  themes/*.json
```

One file per project and per agent, so two machines that edit different
projects never touch the same file. Every file is written
deterministically: sorted keys, pretty-printed, trailing newline. One
changed field is then one changed line, and git merges two machines'
edits to different fields of one project without help.

`project-id` is the existing `Project.id` UUID. A project's file also
carries what another machine needs to find the repo: the remote URL
(from `git remote get-url`, since `Project.remote` is only a name) and
the path of the project below the repo root, for a project that points
at `packages/app` of a monorepo. Multi-repo members carry the same pair
each.

## The loop

**Where the clone lives.** `global_dir()/sync/`. That is inside the data
dir the Seatbelt profile denies to caged agents as its final rule, and
Docker only mounts named subfolders of the data dir (`docker-agents/`,
`docker-forge/`, `docker-gitfiles/`), never the whole thing. A caged
agent can then neither read the user's setup nor push to their repo, in
either sandbox. A clone anywhere the user picks would lose both
guarantees.

**Commit identity.** Set `user.name` and `user.email` in the clone's own
config, never inherit the global one. A global personal address with
GitHub's "block command line pushes that expose my email" setting fails
every push with `GH007`, and in a background loop nobody sees it.

**Push.** A config write (a project saved, a setting changed, a pref
written) schedules an export about ten seconds later, coalescing a
burst of edits into one commit. The export rewrites the profile's
folder, `git add -A`, commits as "sync from <machine name>", then pulls
(below) and pushes.

**Pull.** On launch, on "Sync now", before every push, and when the
window regains focus if the last pull is older than a few minutes. No
background timer in v1.

**Every network call is bounded.** `fetch_ref` already carries the
pattern (`GIT_TERMINAL_PROMPT=0`, batch-mode SSH with a short connect
timeout, a wall-clock deadline that kills the child), and its comment
says every network git op must go through it. Push goes through the
plain `git()` helper today, so push and clone would each need a bounded
version. Everything runs off the main thread (`spawn_blocking`), like
the other IO commands.

**Apply is per profile window.** A pull for profile A is applied by A's
window, because half of what it applies is A's `scoped()` localStorage
keys, and Rust cannot write those. Rust owns git and the files; the
window owns localStorage and the store reload. The reverse direction is
the same split: the window hands its prefs snapshot to Rust over IPC
for the export.

A profile with no window open still gets its `projects.json` and
`settings.json` applied by Rust on pull. Its prefs wait in the clone and
apply when a window for that profile next opens.

## Finding a project on another machine

A pulled project that is not registered here needs a local path, and
guessing wrong is worse than asking:

1. The `id` is already registered here: update it in place.
2. A repo under `repos_dir` has the same remote URL (the discovery scan,
   `discover_repos_in`, already walks that folder): register it, with
   the subdirectory applied.
3. Neither: list it under "waiting for a folder", with Locate, Clone
   into `repos_dir`, and Skip. Skip is remembered locally so it stops
   asking. A plain-folder project (`non_git`) has no URL and always
   lands here.

## Deletions

Removing a project is not a sidebar edit. `project_remove` archives every
task under it, which runs archive scripts and deletes worktrees, then
hard-deletes the task records. A removal on one machine must never do
that on another one unasked.

So a removal writes a tombstone (`removed.json`: project id, machine,
time) instead of just deleting the file. Another machine that sees the
tombstone shows "removed on <machine>" with Remove and Keep. Keep clears
the tombstone and publishes the project again, so this machine is not
asked on every pull.

That republished file would then reach the first machine as a project
it does not have. So the removing machine also puts the id on its local
Skip list (the one "Finding a project" already keeps), and it does not
come back there unless the user adds it again.

## Conflicts

The file layout keeps them rare, but two machines can still change the
same field between syncs. v1 does not write conflict markers into JSON:
the rebase is aborted, the local state is kept, and the sync status
names the files in conflict with a choice per file, "keep this
machine's" or "take the other one". A field-level merge from the three
versions git already has (`:1:`, `:2:`, `:3:`) is a later phase, and
may never be needed.

## Setup

Settings gets a Sync section per profile: the remote URL, a "Sync now"
button, the last sync time and the last error. When the user is signed
in to `gh` or `glab` (`forge.rs` already detects both), it can offer to
create a private repo. It warns, loudly, if the repo turns out to be
public.

The first connect has two cases. An empty repo gets this machine's setup
pushed. A non-empty one shows what would change here before applying
anything, because the first pull onto a machine already set up is the
one most likely to surprise.

## Constraints

- **Performance.** Nothing touches a PTY path. A pull that changed
  nothing must write nothing through a store setter and re-render no
  sidebar row ([performance.md](../performance.md), bear trap 8); the
  `selectorFanout` count test is the place to pin that. No sleep-poll
  loops in Rust (bear trap 9).
- **Two realms.** The clone is out of reach of both sandboxes, as above.
  Anything added later that mounts the data dir into a container must
  keep `sync/` out.
- **Fixtures.** The e2e spec drives a local bare repo (`file://`) as the
  remote, and plays the "other machine" by committing into it from the
  spec. No real hostnames or users in any fixture.

## Cost

Measured against the pieces, not a guess at the whole:

- **A prefs registry.** The list exists: `src/lib/prefsRegistry.ts`
  names every localStorage key and runtime-built key family, each
  marked profile-scoped or not and classified sync or local with a
  reason, and `src/lib/prefsRegistry.test.ts` fails on a key in source
  the registry does not list, or a listed key nothing uses. What sync
  still needs is a `setPref` write path that doubles as the change
  signal: about 20 files still write localStorage directly, and routing
  them through one function is the remaining mechanical piece.
- **Field classification in Rust**, for `Project`, `Settings` and
  `Agent`, with a test that serializes each struct and fails on a field
  in neither list. Without it, the next field added to `Project` is
  silently synced or silently dropped.
- **The git loop:** clone, commit, bounded push and pull, rebase and
  abort.
- **Project matching** and the "waiting for a folder" list.
- **Tombstones and the per-file conflict choice.**
- **The Settings section**, en and zh-CN.
- **Tests:** cargo for export determinism, classification and
  tombstones; vitest for apply (the registry has its test already); one
  e2e spec against a bare repo.

Phase 1 is a manual "Sync now" with keep-local on conflict: roughly a
week, most of it the `setPref` write path and the Rust classification
tests.
Phase 2 is the automatic push and pull, about the same again, most of it
edge cases. Field-level merging is phase 3 and optional.

## Open questions

1. **Profiles.** A profile's slug is frozen at creation and can differ
   between machines. Is a profile bound to its sync folder by a
   `sync_id` stored in the profile, chosen at first connect? And is it
   one repo with a folder per profile, as sketched, or one repo per
   profile, so a work profile can sync to a work forge and a personal
   one elsewhere?
2. **Safety defaults.** YOLO and sandbox defaults (the app-wide
   `defaultYolo`, a project's `default_yolo`, the default sandbox mode)
   are preferences by the rule above, but
   [data-model.md](../data-model.md) calls `defaultYolo` machine-level,
   and switching approvals off on a work laptop because of a click on a
   personal one is a bad surprise. Proposed answer: sync them, and show
   any change to one in the preview before it applies.
   `src/lib/prefsRegistry.ts` already classifies them `sync`.
3. **Agent `env`.** Never, opt-in with a warning, or encrypted in the
   repo (age, sops)? Never is the simplest honest answer.
4. **Agent `command`.** Usually a bare name, sometimes an absolute path
   that does not exist on the other machine. Sync it and fall back to
   the local value when the synced one is not on `PATH`, or keep it
   local?
5. **Pull cadence.** Is launch, focus and before-push enough, or does a
   long-running window need a timer?
6. **Phase 1 as plain export/import.** Should phase 1 be a file export
   and import with no git at all, which helps users who will never set
   up a repo, and make git the transport in phase 2?
