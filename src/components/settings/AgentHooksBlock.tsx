// Settings → Agents & Terminals → Agent hooks.
//
// It sits with the AGENTS because it writes into an agent's own config and
// changes how that agent reports its state. It lived under Notifications
// first, on the reasoning that the four indicators there are all downstream of
// work-state detection: true, and beside the point, since Notifications is
// where you choose whether to be TOLD rather than how termic KNOWS. The tell
// was that the arrangement needed a signpost on the Agents page pointing at
// it, and a cross reference is usually evidence a thing is in the wrong place.
//
// This block is the FLEET control, above the per-agent tabs: the one decision
// that spans agents ("install for every agent"), the coverage count, and, when
// some agent is still being guessed at, which ones. It deliberately carries no
// per-agent action any more. Install, remove and the disclosure of what an
// install writes live on each agent's own card (AgentHookSource), next to the
// terminal patterns they replace: with the actions up here and the patterns
// down there, nothing on the page said the first makes the second dormant.
//
// The coverage list stays, as rows that JUMP to the agent's card. The
// per-agent statuses only read as coverage when they sit next to each other.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Check, CircleAlert } from "lucide-react";
import { agentHooksAutoGet, agentHooksAutoSet, agentHooksSync } from "@/lib/ipc";
import { Toggle } from "@/components/settings/Controls";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";
import { agentDisplayName } from "@/lib/agents";

/** Anchor the Agents section's link targets, so the jump lands ON the block
 *  rather than at the top of Notifications with the reader hunting for it. */
export const AGENT_HOOKS_HIGHLIGHT = "agent-hooks";

export function AgentHooksBlock({ onSelectAgent }: {
  /** Open one agent's card on its state section. The rows and the gap line
   *  are links to where that agent is actually configured. */
  onSelectAgent: (id: string) => void;
}) {
  const { t } = useTranslation("settings");
  const detectedClis = useApp(s => s.detectedClis);
  const agents = useApp(s => s.agents);
  // Installed and supported come from the STORE, the same read every live tab
  // uses to decide whether the title may still end a turn, so this block, the
  // cards and the terminals cannot disagree about who is wired.
  const installed = useApp(s => s.agentHooksInstalled);
  const supported = useApp(s => s.agentHooksSupported);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  // COLLAPSED by default. Expanded, this pushed the per-agent tabs (the reason
  // anyone opens this page) below the fold behind two paragraphs of protocol
  // detail. That detail is right for someone deciding to let termic write into
  // their agent config and wrong as the first thing on the page, so it lives
  // behind the toggle and the collapsed row carries only what it is and how
  // many agents are wired.
  const [expanded, setExpanded] = useState(false);
  /** "Install all hooks", or null until read. */
  const [auto, setAuto] = useState<boolean | null>(null);
  // Read by the mount/detection effect without being one of its deps: the
  // switch installs through its own call, and re-running that effect on the
  // flip started a SECOND sync racing the first over the same config files.
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const autoLoaded = auto !== null;
  useEffect(() => {
    void agentHooksAutoGet().then(setAuto).catch(() => setAuto(false));
  }, []);
  // Arriving from the Agents section's link: scroll to this block and flash it
  // once. Same one-shot contract as GeneralSection's, so a later manual visit
  // to Notifications does not re-flash something the reader is already on.
  const settingsHighlight = useApp(s => s.view.settingsHighlight);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (settingsHighlight !== AGENT_HOOKS_HIGHLIGHT) return;
    useApp.getState().clearSettingsHighlight();
    // Expanded as well: whoever sent the reader here (the usage chip's
    // "Install hooks", the Notifications link) wants to see which agents are
    // wired, and the rows that lead to each one are behind the toggle. Scrolled on the NEXT frame so the jump
    // measures the block at its expanded height, and to its top, because
    // centred the expanded block starts above the fold.
    setExpanded(true);
    const raf = window.requestAnimationFrame(() =>
      document.getElementById(`setting-${AGENT_HOOKS_HIGHLIGHT}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" }));
    setFlash(true);
    const th = window.setTimeout(() => setFlash(false), 1600);
    return () => { window.clearTimeout(th); window.cancelAnimationFrame(raf); };
  }, [settingsHighlight]);

  // Only agents actually on PATH. Offering to wire an agent the user does not
  // have is noise, and the row would have nothing true to say.
  const present = agents
    .filter(a => a.id !== "shell" && detectedClis[a.id]?.found)
    .map(a => a.id);

  // ...and of those, only the ones this can actually wire. A row reading
  // "not supported yet" or "not needed, its terminal already reports this" is
  // a row you can do nothing with, and there were more of those than real ones,
  // which made the list read as mostly unavailable. The unsupported agents are
  // still described in docs/agent-hooks.md, where the reasoning belongs.
  const wirable = present.filter(id => supported[id]);
  const guessing = wirable.filter(id => !installed[id]);
  const installedCount = wirable.length - guessing.length;
  /** Some wired, some not. A gap the user can close, which is what earns the
   *  warning colour. An agent blocked by `disableAllHooks` counts as a gap on
   *  purpose: its hooks genuinely are not reporting, and the fix (removing
   *  that setting) is theirs to make, so hiding it would be the dishonest
   *  half of "5 of 5". */
  const partial = installedCount > 0 && installedCount < wirable.length;

  // With "install all hooks" on, an agent that appeared since the last sync
  // (newly on PATH, or just added here) is wired before its row is read, so
  // the list never shows a gap the setting promised to close.
  useEffect(() => {
    if (!present.length || !autoLoaded) return;
    void (async () => {
      if (autoRef.current) {
        const wired = await agentHooksSync().catch(() => [] as string[]);
        if (wired.length) await useApp.getState().refreshAgentHooks();
      }
    })();
  },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [present.join(","), autoLoaded]);

  const setAutoInstall = async (on: boolean) => {
    setAuto(on);
    setBusy(true);
    setFailure("");
    try {
      await agentHooksAutoSet(on);
      await useApp.getState().refreshAgentHooks();
    } catch (e) {
      setFailure(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Text sizes here are explicit px, matching Controls.tsx (label 14, hint
  // 12.5, dense 12). Tailwind's `text-sm` / `text-xs` is a SECOND scale that
  // resolves against the root font size, so using it rendered this whole block
  // a notch below its neighbours and drew a "why did you introduce a new text
  // size" straight away. Match the surrounding settings, do not invent.
  // Nothing to offer, so nothing to show. Also covers the moment before
  // status resolves, where every row would say "checking...".
  if (!wirable.length) return null;

  return (
    <div
      id={`setting-${AGENT_HOOKS_HIGHLIGHT}`}
      className={cn(
        "rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-4 py-3",
        flash && "ring-2 ring-[var(--color-accent)]",
      )}
    >
      {/* The whole thing collapsed is ONE row: what it is, how many agents are
          wired, and a way in. Everything else is behind the toggle. */}
      <button
        type="button"
        data-testid="agent-hooks-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <ChevronRight className={cn("h-4 w-4 shrink-0 text-[var(--color-fg-faint)] transition-transform", expanded && "rotate-90")} />
        <span className="text-[14px] font-semibold text-[var(--color-fg)]">{t("agents.hooks.title")}</span>
        {/* Collapsed, this line is the only thing reporting coverage, and the
            count alone made "5 of 5" and "3 of 5" look identical at a glance:
            both are dim grey text ending in "installed", and the digit doing
            all the work is the easiest character on the row to skim past.
            State reads faster as colour and shape than as arithmetic.

            Three states, not two. Nothing installed is the untouched default
            and gets the invitation, NOT a warning: a fresh install has done
            nothing wrong, and amber on first sight is a nag. The warning is
            for a coverage GAP, which only exists once some agents are wired
            and others are not. */}
        <span
          data-testid="agent-hooks-summary"
          data-state={installedCount === 0 ? "none" : partial ? "partial" : "complete"}
          title={partial
            ? t("agents.hooks.partialTip")
            : undefined}
          className={cn(
            "ml-auto flex items-center gap-1.5 text-[12.5px]",
            // Amber carries the gap; the complete and empty cases stay in the
            // section's ordinary dim, so the row only pulls the eye when
            // there is something to act on.
            partial ? "text-[var(--color-warn)]" : "text-[var(--color-fg-dim)]",
          )}
        >
          {installedCount > 0 && (
            partial
              // Not AlertTriangle: this is "incomplete", not "something broke",
              // and the triangle is the shape this app uses for real trouble.
              ? <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
              // The tick is the whole signal for the good case, which is why
              // the text beside it stays dim rather than turning green too.
              : <Check className="h-3.5 w-3.5 shrink-0 text-[var(--color-ok)]" aria-hidden />
          )}
          {installedCount > 0
            ? t("agents.hooks.summaryCount", { installed: installedCount, total: wirable.length })
            : t("agents.hooks.summaryNone")}
        </span>
      </button>

      {/* Outside the collapsed part on purpose: the one decision most people
          make here is "all of them", and it should not take an expand. */}
      <div data-testid="agent-hooks-auto" data-on={auto ? "1" : "0"} className="mt-3">
        <Toggle
          label={t("agents.hooks.autoLabel")}
          hint={t("agents.hooks.autoHint")}
          value={!!auto}
          onChange={v => { if (!busy) void setAutoInstall(v); }}
        />
        {failure && (
          <div className="mt-1 text-[12px] text-[var(--color-err)]">{failure}</div>
        )}
      </div>

      {/* The recommendation, visible without expanding and only while there
          is something to recommend: which agents are still being guessed at,
          each a link to the card where its hooks are installed. Amber for a
          gap among wired agents; the untouched install gets the same sentence
          in the ordinary dim, because a fresh install has done nothing wrong. */}
      {guessing.length > 0 && (
        <div
          data-testid="agent-hooks-gap"
          className={cn(
            "mt-3 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[12.5px] leading-snug",
            partial ? "text-[var(--color-warn)]" : "text-[var(--color-fg-dim)]",
          )}
        >
          <span>{t("agents.hooks.gap", { count: guessing.length })}</span>
          {guessing.map(id => (
            <button
              key={id}
              type="button"
              data-testid={`agent-hooks-gap-${id}`}
              onClick={() => onSelectAgent(id)}
              className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-fg)]"
            >
              {agentDisplayName(id, agents)}
            </button>
          ))}
        </div>
      )}

      {expanded && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
            {t("agents.hooks.desc")}
          </p>
          <div className="flex flex-col overflow-hidden rounded-md border border-[var(--color-border)]">
            {wirable.map((id, i) => (
              <button
                key={id}
                type="button"
                data-testid={`agent-hooks-row-${id}`}
                data-installed={installed[id] ? "1" : "0"}
                onClick={() => onSelectAgent(id)}
                className={cn(
                  "flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-[var(--color-hover)]",
                  i > 0 && "border-t border-[var(--color-border-soft)]",
                )}
              >
                <span className="text-[13.5px] font-medium">{agentDisplayName(id, agents)}</span>
                <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
                  {installed[id]
                    ? <Check className="h-3.5 w-3.5 text-[var(--color-ok)]" aria-hidden />
                    : <CircleAlert className="h-3.5 w-3.5 text-[var(--color-warn)]" aria-hidden />}
                  {installed[id] ? t("agents.hooks.rowHooks") : t("agents.hooks.rowTerminal")}
                  <ChevronRight className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" aria-hidden />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
