// The sidebar's STATUS section, above PROJECTS (docs/ui.md "The sidebar's
// status section"): the Kanban board's attention half, compressed and always
// on screen. It is a COPY: every task keeps its one home in the project tree,
// and this lists the actionable subset of the same tasks again.
//
// Buckets are the board's columns, from the board's own precedence
// (src/lib/sidebarStatus.ts over boardColumnFromFacts). Nothing is stored.
//
// Rendering discipline (bear traps 5 and 8):
// - The section reads three raw facts per task from a record of its own
//   (useStatusTabFacts), never `tabs`, so an output stamp or a live title
//   re-renders nothing here. The PR snapshot is read non-reactively; a tiny
//   usePr subscription is the re-render trigger, the way BoardView does it.
// - Each row selects its own badge as a VALUE and its own active flag as a
//   boolean, so a task switch re-renders two rows and a working agent's title
//   churn re-renders none.
//
// Identity: a row carries `data-status-task-id` and NONE of the tree's
// `data-sidebar-task-*` attributes, and its badges use their own testids. The
// task drag, SpawnLinksOverlay and the e2e helpers all assume one
// `[data-sidebar-task-id]` per task. Rows are mouse-only: keyboard navigation
// walks the tree's project order, which this section shares but does not own.

import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { usePr } from "@/store/pr";
import { selectStatusRowBadge, selectStatusRowDelegated, useStatusTabFacts } from "@/store/sidebarTabs";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { TaskWorkBadge } from "@/components/TaskWorkBadge";
import { TaskPrBadge } from "@/components/TaskPrBadge";
import { cn } from "@/lib/utils";
import { taskLabel } from "@/lib/taskLabel";
import { isStatusBucketCollapsed, statusBuckets, type StatusBucket } from "@/lib/sidebarStatus";
import type { WorkStatePrefs } from "@/lib/taskWorkState";
import type { Agent, Task } from "@/lib/types";

/** Literal keys, so usedKeys.test.ts can see them. The board's own labels:
 *  a bucket and its column must not be called two different things. */
function bucketLabel(bucket: StatusBucket, t: TFunction<"sidebar">): string {
  switch (bucket) {
    case "attention": return t("chrome:board.colAttention");
    case "working": return t("chrome:board.colWorking");
    case "review": return t("chrome:board.colReview");
    case "settled": return t("chrome:board.colSettled");
    case "backlog": return t("chrome:board.colBacklog");
  }
}

export function StatusSection() {
  const { t } = useTranslation("sidebar");
  const projects = useApp(s => s.projects);
  const tasks = useApp(s => s.tasks);
  const agents = useApp(s => s.agents);
  const facts = useStatusTabFacts();
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const attentionIndicator = usePrefs(s => s.attentionIndicator);
  const useBranchAsTaskName = usePrefs(s => s.useBranchAsTaskName);
  const bucketCollapsed = usePrefs(s => s.statusBucketCollapsed);
  const setBucketCollapsed = usePrefs(s => s.setStatusBucketCollapsed);
  // The board's pref set, so the same toggles fill the same buckets. Stable
  // identity: it keys every row's badge selector.
  const workPrefs: WorkStatePrefs = useMemo(
    () => ({ settledHighlight, workingIndicator, attentionIndicator }),
    [settledHighlight, workingIndicator, attentionIndicator],
  );

  // Re-render trigger for PR polls, nothing more: the pr store lives outside
  // useApp so its 60s tick re-renders nobody by default, and an open ->
  // merged transition moves a task out of In review. Same key as BoardView.
  const prKey = usePr(s => Object.values(s.byTask).map(e => e.lookup?.pr?.state ?? "?").join("|"));

  const groups = useMemo(
    () => statusBuckets(projects, tasks, facts, usePr.getState().byTask, workPrefs),
    // prKey stands in for the snapshot read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, tasks, facts, workPrefs, prKey],
  );
  const projectName = useMemo(() => new Map(projects.map(p => [p.id, p.name])), [projects]);

  return (
    <div data-testid="status-section" className="mb-1">
      {/* A label, exactly like the PROJECTS header, and NOT a fold: the
          on/off switch is how the section goes away, and a chevron here made
          it the odd one out next to PROJECTS. It stays when every bucket is
          empty, so the section cannot silently vanish. */}
      <div
        data-testid="status-section-header"
        className="flex items-center px-2 py-1 text-[12px] uppercase tracking-wider text-[var(--color-fg-dim)]"
      >
        <span>{t("statusHeader")}</span>
      </div>
      {groups.map(g => {
        const open = !isStatusBucketCollapsed(g.bucket, bucketCollapsed);
        const count = g.tasks.length;
        const countLabel = count === 1
          ? t("statusBucketCount_one", { count })
          : t("statusBucketCount_other", { count });
        return (
          <div key={g.bucket} data-status-bucket={g.bucket} className="flex flex-col">
            <button
              type="button"
              data-testid="status-bucket-header"
              aria-expanded={open}
              onClick={() => setBucketCollapsed(g.bucket, open)}
              className="ml-1 flex h-[var(--task-row-h)] items-center gap-1 rounded-md px-1 text-[12.5px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] transition-colors"
            >
              {open
                ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />}
              <span className="min-w-0 truncate font-medium">{bucketLabel(g.bucket, t)}</span>
              <span
                data-testid="status-bucket-count"
                title={countLabel}
                aria-label={countLabel}
                className="ml-auto pr-1 text-[11px] tabular-nums text-[var(--color-fg-faint)]"
              >
                {count}
              </span>
            </button>
            {open && g.tasks.map(w => (
              <StatusTaskRow
                key={w.id}
                task={w}
                projectName={projectName.get(w.project_id) ?? ""}
                agents={agents}
                useBranchAsTaskName={useBranchAsTaskName}
                workPrefs={workPrefs}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** A lighter row than the tree's TaskRow, modelled on the dashboard's: no
 *  terminal children, no drag, no rename, no run controls, no menu. TaskRow
 *  is NOT reused: its rename and auto-expand effects would run twice per
 *  task, and every auto-expand would be a second whole-state write. */
const StatusTaskRow = memo(function StatusTaskRow({ task: w, projectName, agents, useBranchAsTaskName, workPrefs }: {
  task: Task;
  projectName: string;
  agents: Agent[];
  useBranchAsTaskName: boolean;
  workPrefs: WorkStatePrefs;
}) {
  const { t } = useTranslation("sidebar");
  const setActive = useApp(s => s.setActiveTask);
  const isActive = useApp(s => s.activeTaskId === w.id);
  const selectBadge = useMemo(() => selectStatusRowBadge(w.id, workPrefs), [w.id, workPrefs]);
  const selectDelegated = useMemo(() => selectStatusRowDelegated(w.id, workPrefs), [w.id, workPrefs]);
  const badge = useApp(selectBadge);
  const delegated = useApp(selectDelegated);
  const label = taskLabel(w, useBranchAsTaskName);
  const labelIsBranch = label !== w.name;
  const icon = resolveIconId(w.cli, agents);

  return (
    // A div with a button role, not a <button>: the PR chip is itself a
    // button, and a button inside a button is invalid content WebKit
    // reparents. Same reason as the tree's row and the dashboard's.
    <div
      data-status-task-id={w.id}
      data-active={isActive || undefined}
      role="button"
      tabIndex={0}
      onClick={() => setActive(w.id)}
      onKeyDown={ev => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setActive(w.id); }
      }}
      className={cn(
        "ml-3 flex h-[var(--task-row-h)] cursor-pointer select-none items-center gap-1.5 rounded-md px-1 text-[13px] transition-colors",
        isActive
          ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
          : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
      )}
    >
      <span className={cn("shrink-0", CLI_BRAND_COLOR[icon] || "text-[var(--color-fg-faint)]")}>
        <CliIcon cli={icon} className="h-3.5 w-3.5" />
      </span>
      <span
        title={labelIsBranch ? t("taskNameTitle", { name: w.name }) : undefined}
        className={cn("min-w-0 shrink truncate font-medium", labelIsBranch && "font-mono text-[12px]")}
      >
        {label}
      </span>
      {/* Which project, since a bucket mixes them. Faint and shrinks first:
          the task's own name is what the row is for. */}
      <span className="min-w-0 shrink-[2] truncate text-[11.5px] text-[var(--color-fg-faint)]">{projectName}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
        <TaskPrBadge task={w} testId="status-pr-badge" />
        <span className="flex h-[18px] w-[18px] items-center justify-center">
          {badge && <TaskWorkBadge reason={badge} delegated={delegated} testId="status-work-badge" />}
        </span>
      </span>
    </div>
  );
});
