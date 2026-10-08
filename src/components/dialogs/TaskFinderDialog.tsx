// ⌘O global task finder — fuzzy-search active tasks across projects
// and switch immediately. Built for rapid keyboard-driven context switching
// without touching the mouse or disturbing the sidebar tree layout.

import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { fuzzyMatch, Highlighted } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";
import { focusMainTab } from "@/lib/tabFocus";
import { groupOf } from "@/lib/projectGroups";
import { accentCss } from "@/lib/accents";
import { TaskLocationIcon } from "@/components/TaskLocationIcon";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import type { Project, Task } from "@/lib/types";

const MAX_RESULTS = 30;

interface ScoredTask {
  task: Task;
  project?: Project;
  score: number;
  nameMatches: number[];
  branchMatches: number[];
  projectMatches: number[];
  isCurrent: boolean;
}

export function TaskFinderDialog() {
  const { t } = useTranslation("dialogs");
  const open = useUI(s => s.taskFinderOpen);
  const close = useUI(s => s.closeTaskFinder);
  const tasks = useApp(s => s.tasks);
  const projects = useApp(s => s.projects);
  const recentTasks = useApp(s => s.recentTasks);
  const activeTaskId = useApp(s => s.activeTaskId);
  const agents = useApp(s => s.agents);
  const groupColors = useApp(s => s.groupColors);

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Reset query and active selection whenever the finder opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
    }
  }, [open]);

  const results = useMemo<ScoredTask[]>(() => {
    const unarchived = tasks.filter(t => !t.archived);
    if (!unarchived.length) return [];

    const projectMap = new Map(projects.map(p => [p.id, p]));
    const recents = recentTasks;

    // Recency bonus: decays linearly with position in recentTasks.
    const recencyBonus = (taskId: string) => {
      const idx = recents.indexOf(taskId);
      if (idx === -1) return 0;
      return Math.max(0, 10 - idx);
    };

    if (!query.trim()) {
      // Empty query: order primarily by recency, with current task at top.
      const sorted = [...unarchived].sort((a, b) => {
        if (a.id === activeTaskId) return -1;
        if (b.id === activeTaskId) return 1;
        const aIdx = recents.indexOf(a.id);
        const bIdx = recents.indexOf(b.id);
        if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
        if (aIdx !== -1) return -1;
        if (bIdx !== -1) return 1;
        return 0;
      });

      return sorted.slice(0, MAX_RESULTS).map(t => ({
        task: t,
        project: projectMap.get(t.project_id),
        score: 0,
        nameMatches: [],
        branchMatches: [],
        projectMatches: [],
        isCurrent: t.id === activeTaskId,
      }));
    }

    const scored: ScoredTask[] = [];
    const q = query.trim();

    for (const task of unarchived) {
      const project = projectMap.get(task.project_id);
      const projName = project?.name ?? "";
      const branchName = task.branch || "";
      const isCurrent = task.id === activeTaskId;

      const nameMatch = fuzzyMatch(task.name, q);
      const branchMatch = branchName && branchName !== task.name ? fuzzyMatch(branchName, q) : null;
      const projMatch = projName ? fuzzyMatch(projName, q) : null;
      const combined = `${projName} ${task.name}`;
      const combinedMatch = fuzzyMatch(combined, q);

      if (!nameMatch && !branchMatch && !projMatch && !combinedMatch) continue;

      let score = 0;
      if (nameMatch) score = Math.max(score, nameMatch.score * 1.5);
      if (branchMatch) score = Math.max(score, branchMatch.score * 1.2);
      if (projMatch) score = Math.max(score, projMatch.score);
      if (combinedMatch) score = Math.max(score, combinedMatch.score);

      score += recencyBonus(task.id);
      if (isCurrent) score += 2;

      scored.push({
        task,
        project,
        score,
        nameMatches: nameMatch ? nameMatch.matches : [],
        branchMatches: branchMatch ? branchMatch.matches : [],
        projectMatches: projMatch ? projMatch.matches : [],
        isCurrent,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS);
  }, [tasks, projects, recentTasks, activeTaskId, query]);

  // Keep active index clamped and reset when search results change.
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    if (activeIdx > results.length - 1) {
      setActiveIdx(Math.max(0, results.length - 1));
    }
  }, [results.length, activeIdx]);

  // Scroll active row into view on keyboard navigation.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  function pick(taskId: string) {
    close();
    const app = useApp.getState();
    app.setActiveTask(taskId);
    const activeTabId = app.activeTab[taskId];
    if (activeTabId) focusMainTab(activeTabId);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[activeIdx];
      if (r) pick(r.task.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={v => { if (!v) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="termic-backdrop fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          data-testid="task-finder"
          onOpenAutoFocus={() => {
            returnFocusRef.current = document.activeElement as HTMLElement | null;
          }}
          onCloseAutoFocus={(e) => {
            if (returnFocusRef.current) {
              e.preventDefault();
              returnFocusRef.current.focus();
            }
          }}
          className="termic-pop fixed left-1/2 top-12 z-50 w-[min(760px,92vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] shadow-2xl outline-none"
          onKeyDown={onKeyDown}
        >
          <Dialog.Title className="sr-only">{t("taskFinder.srTitle")}</Dialog.Title>
          <Dialog.Description className="sr-only">{t("taskFinder.srDesc")}</Dialog.Description>

          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
            <Search className="h-4 w-4 shrink-0 text-[var(--color-fg-faint)]" />
            <input
              autoFocus
              data-testid="task-finder-input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              placeholder={t("taskFinder.placeholder")}
              className="w-full bg-transparent pl-1 text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:outline-none"
            />
            {query !== "" && (
              <button
                type="button"
                tabIndex={-1}
                aria-label={t("taskFinder.clear")}
                onClick={() => setQuery("")}
                className="rounded p-0.5 text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div ref={listRef} className="max-h-[70vh] overflow-y-auto py-1">
            {results.length === 0 && (
              <div className="px-3 py-6 text-center text-[13px] text-[var(--color-fg-faint)]">
                {query.trim() ? t("taskFinder.noMatching") : t("taskFinder.noTasks")}
              </div>
            )}
            {results.map((r, i) => {
              const grpName = r.project ? groupOf(r.project) : "";
              const grpColor = grpName ? groupColors[grpName] : undefined;
              const hasDiffBranch = r.task.branch && r.task.branch !== r.task.name;

              return (
                <button
                  key={r.task.id}
                  data-row={i}
                  data-active={r.isCurrent || undefined}
                  onClick={() => pick(r.task.id)}
                  onMouseMove={() => setActiveIdx(i)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors",
                    i === activeIdx
                      ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]"
                      : "text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-2)]",
                  )}
                >
                  {/* Project badge with group color dot */}
                  {r.project && (
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-muted)]">
                      {grpColor && (
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: accentCss(grpColor) }}
                        />
                      )}
                      <span className="max-w-[120px] truncate">
                        <Highlighted text={r.project.name} matches={r.projectMatches} />
                      </span>
                    </span>
                  )}

                  {/* Task kind / Location icon */}
                  <TaskLocationIcon isMainCheckout={r.task.is_main_checkout} size="h-3.5 w-3.5" />

                  {/* Task name */}
                  <span className="min-w-0 truncate font-medium text-[var(--color-fg)]">
                    <Highlighted text={r.task.name} matches={r.nameMatches} />
                  </span>

                  {/* Branch name if different from task name */}
                  {hasDiffBranch && (
                    <span className="max-w-[160px] truncate font-mono text-[11.5px] text-[var(--color-fg-faint)]">
                      <Highlighted text={r.task.branch} matches={r.branchMatches} />
                    </span>
                  )}

                  {/* Spacer */}
                  <span className="flex-1" />

                  {/* Agent CLI icon */}
                  <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(r.task.cli, agents)] || "text-[var(--color-fg-dim)]")}>
                    <CliIcon cli={resolveIconId(r.task.cli, agents)} className="h-3.5 w-3.5" />
                  </span>

                  {/* Current task pill */}
                  {r.isCurrent && (
                    <span className="shrink-0 rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
                      {t("taskFinder.current")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-t border-[var(--color-border-soft)] px-3 py-1.5 text-[11px] text-[var(--color-fg-faint)]">
            <span>{t("taskFinder.count", { count: results.length })}</span>
            <span className="flex items-center gap-2.5">
              <span><kbd className="rounded border border-[var(--color-border)] px-1 py-0.5 text-[10px]">↑↓</kbd> {t("taskFinder.navigate")}</span>
              <span><kbd className="rounded border border-[var(--color-border)] px-1 py-0.5 text-[10px]">↵</kbd> {t("taskFinder.switch")}</span>
              <span><kbd className="rounded border border-[var(--color-border)] px-1 py-0.5 text-[10px]">esc</kbd> {t("taskFinder.dismiss")}</span>
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
