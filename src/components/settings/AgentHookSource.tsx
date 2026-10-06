// Where one agent's state comes from, as the first thing in its card's
// "Agent state" section (Settings → Agents & Terminals).
//
// Hooks and the terminal patterns are two answers to one question, and they
// were configured in two places that never mentioned each other: a table above
// the tabs, and four regex fields at the bottom of every card that looked live
// whether or not hooks had made them dormant. This row is the join. It names
// the source in use, and for an agent that could report its own state and does
// not, it carries the install right here instead of pointing somewhere else.
//
// The page-level block (AgentHooksBlock) keeps the one decision that spans
// agents, "install for all of them", and the coverage count. Everything about
// ONE agent lives here: its status, its install and remove, and the disclosure
// of exactly what an install writes.
//
// Each install covers both of the agent's targets, host and its Docker config
// dir. Docker needs no separate consent because termic owns that directory,
// but a user who declines for an agent must never find hooks installed for it
// inside a container. See docs/agent-hooks.md.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, CircleAlert, Terminal } from "lucide-react";
import { agentHooksInstall, agentHooksPlan, agentHooksRemove, agentHooksStatus, cachedHomeDir } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { tildePath } from "@/lib/pathMatch";
import { builtinBaseId } from "@/lib/agents";
import type { AgentHookStatus, HookPlan } from "@/lib/types";

/** What the card says about an agent's state source.
 *  - `hooks`: installed, the agent reports its own state.
 *  - `available`: termic can install hooks and has not. The one state that
 *    recommends something.
 *  - `blocked`: the agent's own config has `disableAllHooks`, so an install
 *    would never fire. Saying "installed" there would be a lie.
 *  - `terminal`: no hooks exist for this agent (or on this OS), so the
 *    terminal patterns ARE the mechanism.
 *  - `absent`: the CLI is not on PATH. Offering to wire an agent the user
 *    does not have is noise. */
export type HookSourceState = "hooks" | "available" | "blocked" | "terminal" | "absent";

export function hookSourceState(o: {
  supported: boolean; installed: boolean; blocked: boolean; detected: boolean;
}): HookSourceState {
  if (!o.supported) return "terminal";
  if (o.blocked) return "blocked";
  if (o.installed) return "hooks";
  return o.detected ? "available" : "absent";
}

export function AgentHookSource({ agentId }: { agentId: string }) {
  const { t } = useTranslation("settings");
  const agents = useApp(s => s.agents);
  // `undefined` until the first status read lands. Kept apart from `false`:
  // "no hooks for this agent" is a claim, and it is not one to make for the
  // frame before anything is known.
  const supported = useApp(s => s.agentHooksSupported[agentId]);
  const installed = useApp(s => s.agentHooksInstalled[agentId] === true);
  const detected = useApp(s => s.detectedClis[agentId]?.found === true);
  const [status, setStatus] = useState<AgentHookStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [plan, setPlan] = useState<HookPlan | null>(null);
  const [open, setOpen] = useState(false);
  /** Which FILE of the plan is showing. An install touches the agent's config
   *  plus one script per signal, and dumping all of them end to end made a
   *  disclosure you had to scroll past rather than read. */
  const [planFile, setPlanFile] = useState(0);
  const [home, setHome] = useState("");
  useEffect(() => { void cachedHomeDir().then(setHome); }, []);

  // The store knows installed and supported; only this read knows WHY an
  // install is not reporting (`disableAllHooks`, an unreadable config). Re-read
  // when the installed bit moves, so the page-level "install for every agent"
  // switch is reflected here without a reload.
  useEffect(() => {
    let stale = false;
    agentHooksStatus(agentId).then(s => { if (!stale) setStatus(s); }).catch(() => {});
    return () => { stale = true; };
  }, [agentId, installed]);

  if (supported === undefined) return null;

  const state = hookSourceState({
    supported, installed, detected, blocked: !!status?.host.disabled_all,
  });
  const err = failure || status?.host.error || "";

  const act = async (install: boolean) => {
    setBusy(true);
    setFailure("");
    try {
      setStatus(install ? await agentHooksInstall(agentId) : await agentHooksRemove(agentId));
      // Live tabs read this to decide whether the title may still end a turn,
      // so it has to change with the install rather than at the next restart.
      await useApp.getState().refreshAgentHooks();
    } catch (e) {
      setFailure(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleDetails = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (!plan) {
      try { setPlan(await agentHooksPlan(agentId)); } catch { /* the row still works without the disclosure */ }
    }
  };

  // Antigravity prompts for permission with no title, no OSC and no bell, so
  // its hooks cover working and done and "needs you" still comes off the
  // screen (docs/agent-hooks.md). The one agent where "hooks replace the
  // terminal" needs a footnote, and it would be a lie without it.
  const screenAttention = state === "hooks" && builtinBaseId(agentId, agents) === "agy";

  const copy = {
    hooks: { title: t("agents.state.hooksTitle"), body: t("agents.state.hooksBody") },
    available: { title: t("agents.state.availableTitle"), body: t("agents.state.availableBody") },
    blocked: { title: t("agents.state.blockedTitle"), body: t("agents.state.blockedBody") },
    terminal: { title: t("agents.state.terminalTitle"), body: t("agents.state.terminalBody") },
    absent: { title: t("agents.state.absentTitle"), body: t("agents.state.absentBody") },
  }[state];

  return (
    <div
      data-testid="agent-state-source"
      data-state={state}
      className={cn(
        "flex flex-col gap-1.5 rounded-md border px-3 py-2.5",
        // Amber only where there is something to do about it. A custom CLI
        // with no hooks has done nothing wrong and gets no warning colour.
        state === "available" || state === "blocked"
          ? "border-[var(--color-warn)]/50"
          : "border-[var(--color-border)]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-[3px] shrink-0">
            {state === "hooks" ? <Check className="h-3.5 w-3.5 text-[var(--color-ok)]" aria-hidden />
              : state === "available" || state === "blocked"
                // Not AlertTriangle: this is "could be better", not "something
                // broke", and the triangle is this app's shape for real trouble.
                ? <CircleAlert className="h-3.5 w-3.5 text-[var(--color-warn)]" aria-hidden />
                : <Terminal className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" aria-hidden />}
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-[var(--color-fg)]">{copy.title}</div>
            <div className="mt-0.5 text-[12px] leading-snug text-[var(--color-fg-dim)]">{copy.body}</div>
            {screenAttention && (
              <div className="mt-1 text-[12px] leading-snug text-[var(--color-fg-dim)]">{t("agents.state.agyNote")}</div>
            )}
          </div>
        </div>
        {(state === "hooks" || state === "available") && (
          <Button
            variant={state === "hooks" ? "ghost" : "primary"}
            disabled={busy}
            data-testid={state === "hooks" ? "agent-state-remove" : "agent-state-install"}
            onClick={() => void act(state !== "hooks")}
            className="shrink-0"
          >
            {busy ? "..." : state === "hooks" ? t("common:remove") : t("agents.hooks.install")}
          </Button>
        )}
      </div>
      {/* Name the files BEFORE writing, not after, and offer the whole thing
          rather than a summary of it. These users read shell for a living. */}
      {(state === "hooks" || state === "available") && (
        <button
          type="button"
          onClick={() => void toggleDetails()}
          className="self-start pl-[22px] text-[12px] text-[var(--color-fg-dim)] underline decoration-dotted hover:text-[var(--color-fg)]"
        >
          {open ? t("agents.hooks.hideInstalls") : t("agents.hooks.showInstalls")}
        </button>
      )}
      {open && plan && (() => {
        // One tab per FILE. Several events share a script (a working hook
        // fires on both UserPromptSubmit and PreToolUse), so the scripts are
        // grouped by path and the events that use them are listed on the tab's
        // own page.
        const scripts: { path: string; body: string; events: string[] }[] = [];
        for (const en of plan.entries) {
          const hit = scripts.find(f => f.path === en.script_path);
          if (hit) hit.events.push(`${en.event} (${en.reports})`);
          else scripts.push({ path: en.script_path, body: en.script_body, events: [`${en.event} (${en.reports})`] });
        }
        const files = [
          { path: plan.config_path, body: plan.config_fragment, events: [] as string[], config: true },
          ...scripts.map(f => ({ ...f, config: false })),
        ];
        const active = Math.min(planFile, files.length - 1);
        const file = files[active];
        return (
          <div className="flex flex-col gap-2 rounded bg-[var(--color-bg)] p-2 text-[12px]">
            <div className="flex flex-wrap gap-1">
              {files.map((f, i) => (
                <button
                  key={f.path}
                  type="button"
                  title={tildePath(f.path, home)}
                  onClick={() => setPlanFile(i)}
                  className={cn(
                    "rounded px-2 py-1 text-[11.5px] transition-colors",
                    i === active
                      ? "bg-[var(--color-bg-3)] text-[var(--color-fg)]"
                      : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                  )}
                >
                  {f.path.replace(/^.*\//, "")}
                </button>
              ))}
            </div>
            <div className="break-all text-[var(--color-fg-dim)]">
              <code>{tildePath(file.path, home)}</code>
              {file.config && plan.config_is_shared && ` (${t("agents.hooks.yoursMerges")})`}
            </div>
            {file.events.length > 0 && (
              <div className="text-[var(--color-fg-dim)]">
                {t("agents.hooks.runsOn", { events: file.events.join(", ") })}
              </div>
            )}
            <pre className="max-h-[320px] overflow-auto whitespace-pre">{file.body}</pre>
            {file.config && plan.notes.map((n, i) => (
              <p key={i} className="text-[var(--color-fg-dim)]">{n}</p>
            ))}
          </div>
        );
      })()}
      {err && <p className="pl-[22px] text-[12px] text-[var(--color-err)]">{err}</p>}
    </div>
  );
}
