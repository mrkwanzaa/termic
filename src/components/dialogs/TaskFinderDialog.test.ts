// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ipc", () => ({
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));

import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { DEFAULT_BINDINGS, SHORTCUT_DEFS } from "@/lib/shortcuts";
import { fuzzyMatch } from "@/lib/fuzzy";
import type { Task, Project } from "@/lib/types";

describe("TaskFinder shortcut and state", () => {
  beforeEach(() => {
    useUI.setState({ taskFinderOpen: false });
  });

  it("has a task-finder shortcut registered with Cmd+O / Ctrl+O", () => {
    const def = SHORTCUT_DEFS.find(d => d.id === "task-finder");
    expect(def).toBeDefined();
    expect(def?.label).toBe("Open task finder");
    expect(def?.group).toBe("General");
    expect(def?.defaultBinding.key).toBe("o");
    expect(def?.defaultBinding.cmd).toBe(true);
    expect(DEFAULT_BINDINGS["task-finder"]).toEqual({
      key: "o",
      cmd: true,
      shift: false,
      alt: false,
    });
  });

  it("toggles taskFinderOpen in UI store", () => {
    expect(useUI.getState().taskFinderOpen).toBe(false);
    useUI.getState().openTaskFinder();
    expect(useUI.getState().taskFinderOpen).toBe(true);
    useUI.getState().closeTaskFinder();
    expect(useUI.getState().taskFinderOpen).toBe(false);
  });
});

describe("task matching logic for TaskFinder", () => {
  const p1: Project = { id: "p1", name: "termic", root_path: "/code/termic" } as Project;
  const p2: Project = { id: "p2", name: "api-server", root_path: "/code/api-server" } as Project;

  const t1: Task = { id: "t1", project_id: "p1", name: "auth-refactor", branch: "feat/auth", cli: "claude", archived: false } as Task;
  const t2: Task = { id: "t2", project_id: "p1", name: "fix-layout", branch: "fix/layout", cli: "codex", archived: false } as Task;
  const t3: Task = { id: "t3", project_id: "p2", name: "database-migration", branch: "db-mig", cli: "gemini", archived: false } as Task;

  it("fuzzy-matches by task name", () => {
    expect(fuzzyMatch(t1.name, "auth")).toBeTruthy();
    expect(fuzzyMatch(t2.name, "layout")).toBeTruthy();
    expect(fuzzyMatch(t3.name, "layout")).toBeNull();
  });

  it("fuzzy-matches by branch name", () => {
    expect(fuzzyMatch(t1.branch, "feat/auth")).toBeTruthy();
    expect(fuzzyMatch(t3.branch, "db")).toBeTruthy();
  });

  it("fuzzy-matches by project name", () => {
    expect(fuzzyMatch(p1.name, "term")).toBeTruthy();
    expect(fuzzyMatch(p2.name, "api")).toBeTruthy();
  });
});
