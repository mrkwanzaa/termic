import { describe, expect, it } from "vitest";
import {
  STATUS_BUCKETS,
  isStatusBucketCollapsed,
  parseStatusBucketCollapsed,
  statusBucketCollapsedByDefault,
  statusBuckets,
} from "./sidebarStatus";
import type { BoardTaskFacts } from "./taskBoardState";
import type { WorkStatePrefs } from "./taskWorkState";
import type { Project, Task } from "./types";

const prefsOn: WorkStatePrefs = { settledHighlight: true, workingIndicator: true, attentionIndicator: true };

function project(id: string, group?: string): Project {
  return { id, name: id, root_path: `/Users/u/${id}`, group } as Project;
}

function task(id: string, projectId: string, over: Partial<Task> = {}): Task {
  return {
    id, project_id: projectId, name: id, branch: id, base_branch: "main",
    path: `/Users/u/${projectId}/${id}`, cli: "claude", port: 0,
    created: "2026-09-01T00:00:00Z", archived: false, ...over,
  } as Task;
}

const F = {
  untouched: { attention: false, working: false, untouched: true },
  settled: { attention: false, working: false, untouched: false },
  working: { attention: false, working: true, untouched: false },
  attention: { attention: true, working: false, untouched: false },
} satisfies Record<string, BoardTaskFacts>;

const ids = (groups: ReturnType<typeof statusBuckets>) =>
  Object.fromEntries(groups.map(g => [g.bucket, g.tasks.map(t => t.id)]));

describe("statusBuckets", () => {
  it("files each task under its board column, buckets in display order", () => {
    const projects = [project("web")];
    const tasks = [
      task("fresh", "web"),
      task("done", "web"),
      task("busy", "web"),
      task("blocked", "web"),
      task("pr", "web", { pr_url: "https://github.com/acme/web/pull/1" }),
    ];
    const facts = { fresh: F.untouched, done: F.settled, busy: F.working, blocked: F.attention, pr: F.settled };
    const groups = statusBuckets(projects, tasks, facts, { pr: { lookup: { pr: { state: "open" } } } }, prefsOn);

    expect(groups.map(g => g.bucket)).toEqual(["attention", "working", "review", "settled", "backlog"]);
    expect(ids(groups)).toEqual({
      attention: ["blocked"], working: ["busy"], review: ["pr"], settled: ["done"], backlog: ["fresh"],
    });
  });

  it("drops empty buckets, and returns nothing at all for no live tasks", () => {
    const projects = [project("web")];
    expect(statusBuckets(projects, [], {}, {}, prefsOn)).toEqual([]);
    const groups = statusBuckets(projects, [task("a", "web")], { a: F.attention }, {}, prefsOn);
    expect(groups.map(g => g.bucket)).toEqual(["attention"]);
  });

  it("keeps tree order: grouped projects pulled together, then each project's task order", () => {
    // Store order web, api, docs with web and docs in one folder: the tree
    // draws web, docs, api, and so must every bucket.
    const projects = [project("web", "front"), project("api"), project("docs", "front")];
    const tasks = [
      task("api-1", "api"), task("web-2", "web"), task("docs-1", "docs"), task("web-1", "web"),
    ];
    const facts = Object.fromEntries(tasks.map(t => [t.id, F.settled]));
    expect(ids(statusBuckets(projects, tasks, facts, {}, prefsOn)).settled)
      .toEqual(["web-2", "web-1", "docs-1", "api-1"]);
  });

  it("draws a task group the way the tree does: one block, at its first member", () => {
    // Store order a(G), b, c(G): the tree renders the group block where its
    // first member sits, so c comes up next to a, ahead of b.
    const g = { id: "a" };
    const tasks = [task("a", "web", { group: g }), task("b", "web"), task("c", "web", { group: g })];
    const facts = { a: F.settled, b: F.settled, c: F.settled };
    expect(ids(statusBuckets([project("web")], tasks, facts, {}, prefsOn)).settled).toEqual(["a", "c", "b"]);
  });

  it("skips archived tasks and tasks whose project is not in the list", () => {
    const tasks = [
      task("live", "web"),
      task("gone", "web", { archived: true }),
      task("orphan", "elsewhere"),
    ];
    const facts = { live: F.settled, gone: F.attention, orphan: F.attention };
    expect(ids(statusBuckets([project("web")], tasks, facts, {}, prefsOn))).toEqual({ settled: ["live"] });
  });

  it("a task whose tabs never loaded reads as Not started, as the board reads it", () => {
    expect(ids(statusBuckets([project("web")], [task("cold", "web")], {}, {}, prefsOn))).toEqual({ backlog: ["cold"] });
  });

  it("follows the PR: unfetched and draft are review, merged falls through", () => {
    const projects = [project("web")];
    const pr = { pr_url: "https://github.com/acme/web/pull/1" };
    const tasks = [task("unfetched", "web", pr), task("draft", "web", pr), task("merged", "web", pr)];
    const facts = { unfetched: F.settled, draft: F.settled, merged: F.settled };
    const prByTask = {
      draft: { lookup: { pr: { state: "draft" } } },
      merged: { lookup: { pr: { state: "merged" } } },
    };
    expect(ids(statusBuckets(projects, tasks, facts, prByTask, prefsOn)))
      .toEqual({ review: ["unfetched", "draft"], settled: ["merged"] });
  });

  it("is gated by the same prefs as the board", () => {
    const projects = [project("web")];
    const tasks = [task("busy", "web"), task("blocked", "web")];
    const facts = { busy: F.working, blocked: F.attention };
    const off: WorkStatePrefs = { settledHighlight: true, workingIndicator: false, attentionIndicator: false };
    expect(ids(statusBuckets(projects, tasks, facts, {}, off))).toEqual({ settled: ["busy", "blocked"] });
  });
});

describe("status bucket collapse", () => {
  it("lists the actionable buckets and folds the count-only ones by default", () => {
    expect(STATUS_BUCKETS.filter(statusBucketCollapsedByDefault)).toEqual(["settled", "backlog"]);
  });

  it("an override wins in both directions", () => {
    expect(isStatusBucketCollapsed("attention", { attention: true })).toBe(true);
    expect(isStatusBucketCollapsed("settled", { settled: false })).toBe(false);
    expect(isStatusBucketCollapsed("settled", { attention: true })).toBe(true);
  });

  it("parses localStorage defensively", () => {
    expect(parseStatusBucketCollapsed(null)).toEqual({});
    expect(parseStatusBucketCollapsed("not json")).toEqual({});
    expect(parseStatusBucketCollapsed("[1,2]")).toEqual({});
    expect(parseStatusBucketCollapsed("null")).toEqual({});
    // Unknown buckets (archived is not one) and non-booleans are dropped.
    expect(parseStatusBucketCollapsed('{"settled":false,"archived":true,"working":"yes","backlog":true}'))
      .toEqual({ settled: false, backlog: true });
  });
});
