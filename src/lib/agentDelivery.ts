// Typing a prompt into a task's agent with nobody at the keyboard, and
// knowing whether it landed. Shared by the CLI's `termic new` / `send`
// (lib/cliRpc.ts, which reports the result to the CLI server) and the
// schedule runner (lib/schedules/runner.ts, which records it in the
// schedule's history). One implementation, so the readiness rules cannot
// drift between the two.
//
// Wall-clock timers throughout, never rAF: occluded windows freeze rAF, and
// for both callers the window is usually in the background.

import { useApp } from "@/store/app";
import { waitForAgentReady, hooksOwnStartupReadiness } from "@/lib/agentReady";
import { ptyAlive } from "@/lib/ipc";
import { deliverMessage } from "@/lib/agentSend";
import { isTerminalCli } from "@/lib/agents";
import type { TerminalTab } from "@/lib/types";

const SPAWN_DEADLINE_MS = 15_000;
const POLL_MS = 150;

const sleep = (ms: number) => new Promise<void>(r => { window.setTimeout(r, ms); });

export function defaultAgentTab(taskId: string): TerminalTab | undefined {
  return (useApp.getState().tabs[taskId] ?? []).find(
    (t): t is TerminalTab => t.type === "terminal" && !!t.is_default,
  );
}

/** The injection target: a specific tab when given (send --fresh /
 *  --resume respawn), the default agent tab otherwise; a restored set
 *  with no surviving default falls back to its first agent tab so the
 *  injection still lands somewhere real. */
export function agentTabFor(taskId: string, tabId?: string): TerminalTab | undefined {
  if (!tabId) {
    return (
      defaultAgentTab(taskId)
      ?? (useApp.getState().tabs[taskId] ?? []).find(
        (t): t is TerminalTab => t.type === "terminal" && !t.runTab && !isTerminalCli(t.cli)
          && t.cli !== "shell" && t.cli !== "custom",
      )
    );
  }
  return (useApp.getState().tabs[taskId] ?? []).find(
    (t): t is TerminalTab => t.id === tabId && t.type === "terminal",
  );
}

/** Wait for the target agent tab to hold a live PTY ("spawn"). */
export async function waitForAgentPty(taskId: string, tabId?: string): Promise<boolean> {
  const deadline = Date.now() + SPAWN_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (agentTabFor(taskId, tabId)?.ptyId) return true;
    await sleep(POLL_MS);
  }
  return false;
}

export type DeliveryResult = { ok: true; tabId: string } | { ok: false; error: string };

/** Type `prompt` into the agent once it is ready, and say whether it landed.
 *  Every exit returns a result; nothing here reports anywhere, so a caller
 *  decides what a failure means. `spawned` is `waitForAgentPty`'s answer. */
export async function deliverPromptWhenReady(
  taskId: string,
  prompt: string,
  spawned: boolean,
  tabId?: string,
): Promise<DeliveryResult> {
  const fail = (error: string): DeliveryResult => ({ ok: false, error });
  if (!spawned) return fail("the agent PTY never spawned");
  // Wait for the TUI to reach its input box, so the prompt lands there
  // and not in a splash screen that discards it; then RE-READ the tab (it
  // may have restarted onto a fresh PTY while we waited - never type into
  // a stale pty). Same readiness rules as seedPrompt's race path: an agent
  // that owns its own ready signal and never sends it is showing a startup
  // prompt, where typing + Enter confirms whatever is highlighted.
  const cli = agentTabFor(taskId, tabId)?.cli;
  const hooksOwnReadiness = hooksOwnStartupReadiness(cli, !!cli && useApp.getState().agentHooksInstalled[cli] === true);
  const ready = await waitForAgentReady(() => agentTabFor(taskId, tabId), { hooksOwnReadiness });
  if (ready === "blocked") return fail(`${cli} never reported ready; not typing (startup prompt?)`);
  const tab = ready === "lost" ? undefined : agentTabFor(taskId, tabId);
  if (!tab?.ptyId) return fail("the agent tab lost its PTY before the prompt could be typed");
  try {
    // Clear any STALE done/attention state first (a real keyboard Enter
    // clears these via term.onData; a direct PTY write does not), so the
    // wait's own-prompt settle logic can never trust a "done" that
    // predates this prompt.
    useApp.getState().patchTab(taskId, tab.id, { workState: "idle", unread: null });
    // Resolves only after text AND the submit CR are written. Echo-verify
    // unless the agent itself claimed ready (same protection as
    // seedPrompt: a missing echo means the paste went somewhere that is
    // not an input box).
    await deliverMessage(tab.ptyId, prompt, { verifyEcho: ready !== "ready" });
    // pty_write silently no-ops on a dead id, so "the writes resolved"
    // is not "the agent received them": delivered means the SAME tab
    // still holds the SAME, still-live PTY after both writes.
    const still = agentTabFor(taskId, tabId);
    const samePty = still?.id === tab.id && still.ptyId === tab.ptyId;
    const alive = samePty && (await ptyAlive(tab.ptyId).catch(() => false));
    if (!alive) return fail("the agent PTY exited while the prompt was being typed");
    useApp.getState().patchTab(taskId, tab.id, { lastInputAt: Date.now() });
    return { ok: true, tabId: tab.id };
  } catch (e) {
    return fail(String((e as Error)?.message ?? e));
  }
}
