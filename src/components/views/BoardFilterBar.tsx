// The task filter bar (docs/ui.md "Kanban view" > Filtering): one input
// holding a GitHub Projects style query, parsed and matched in
// src/lib/boardFilter.ts. Two surfaces draw it, the board and the top of
// the sidebar (`variant`), each with its own query text in the ui store; this
// component only edits that text and offers completions. One component, so
// the two bars cannot come to look or behave differently.
//
// The funnel icon opens the filter MENU: every facet the query language
// knows, as chips with counts. A chip click edits the query text
// (`cycleBoardClause`), so the menu is a way to WRITE queries, not a second
// filter state, and what it did is spelled out in the bar.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ListFilter, Minus, X } from "lucide-react";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { bindingMatches, type Binding } from "@/lib/shortcuts";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/Popover";
import { Highlighted } from "@/lib/fuzzy";
import {
  boardClauseState,
  boardSuggestions,
  cycleBoardClause,
  isBoardQueryActive,
  parseBoardQuery,
  type BoardClauseState,
  type BoardQualifier,
} from "@/lib/boardFilter";
import { cn } from "@/lib/utils";

/** ⌘F (Ctrl+F off macOS, `bindingMatches` folds them). Not a SHORTCUT_DEFS
 *  entry: it only means something while the board is up. */
const FIND_BINDING: Binding = { cmd: true, shift: false, alt: false, key: "f" };

/** One chip in the filter menu: the clause it writes, and how it looks. */
export interface FilterFacetOption {
  key: BoardQualifier;
  value: string;
  label: string;
  /** Cards the current query leaves with this chip included: what a click
   *  on an off chip leaves, what the board shows for an included one. An
   *  excluded chip shows the same "if included" number, not what its next
   *  click (back to off) leaves. */
  count?: number;
  /** A colour dot, as a CSS colour (theme tokens only). */
  swatch?: string;
  icon?: ReactNode;
}

export interface FilterFacetSection {
  id: string;
  title: string;
  options: FilterFacetOption[];
}

/** Memoized: BoardView re-renders per pointermove during a drag, and every
 *  prop here is identity-stable across one (`sections` is a constant while
 *  the menu is closed). */
export const BoardFilterBar = memo(function BoardFilterBar({ text, onTextChange: setText, variant = "board", shown, total, unknownKeys, valuesFor, sections, menuOpen, onMenuOpenChange }: {
  text: string;
  onTextChange: (q: string) => void;
  /** The sidebar's bar stacks its count under the input, opens the menu to
   *  the right, and takes no `/` or ⌘F: those stay the board's. */
  variant?: "board" | "sidebar";
  /** Tasks the query lets through (the board counts Archived). */
  shown: number;
  /** Tasks listed with no query. */
  total: number;
  unknownKeys: readonly string[];
  /** Live values for the free-valued keys (project names, agents, ...). */
  valuesFor: (key: BoardQualifier) => readonly string[];
  /** Built by BoardView only while the menu is open, which is also when it
   *  widens its pr / diffStat subscriptions so the counts stay live. */
  sections: FilterFacetSection[];
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("chrome");
  const sidebar = variant === "sidebar";
  const tid = sidebar ? "sidebar-filter" : "board-filter";
  // A textarea, not an input, so the SIDEBAR's field can wrap while focused
  // (see `grown` below). It never holds a newline: Enter is swallowed and a
  // pasted one becomes a space, so everywhere else it behaves as one line.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Sidebar only. A query of more than a clause or two does not fit the
  // sidebar's width, and a clipped query cannot be read or edited. Focused,
  // the field wraps and grows DOWN OVER the chips: it is out of flow, so
  // nothing under it moves (the row jumping on focus would be the same shift
  // the always-drawn chips were built to stop). Blurred, it is one clipped
  // line again. `grown` is its measured height, which the list hangs below.
  //
  // Measured against the ROW, never a pixel constant: the row is h-7, which
  // is rem, and this app's root font size is 14px, so it is 24.5px and not
  // the 28 a hardcoded "h-7 = 28" assumed. With that constant a focused
  // one-line field stood 3.5px taller than its row.
  const [focused, setFocused] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const [grown, setGrown] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = inputRef.current;
    const row = rowRef.current;
    if (!el || !row || !sidebar || !focused) { setGrown(null); return; }
    const base = row.getBoundingClientRect().height;
    // Collapse first: scrollHeight never shrinks below the current height.
    el.style.height = `${base}px`;
    const h = el.scrollHeight + 2; // + the 1px borders
    el.style.height = "";
    // Null while it still fits one line, so nothing is overridden then.
    setGrown(h > base + 1 ? h : null);
  }, [text, focused, sidebar]);
  // The palette's "Filter sidebar tasks" (useUI.focusSidebarFilter).
  const focusPending = useUI(s => sidebar && s.sidebarFilterFocusPending);
  useEffect(() => {
    if (!focusPending) return;
    useUI.getState().consumeSidebarFilterFocus();
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusPending]);
  // Completions show while typing; Esc or a pick closes them until the next
  // keystroke reopens them.
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const suggestions = useMemo(
    () => (suggestOpen ? boardSuggestions(text, valuesFor) : []),
    [suggestOpen, text, valuesFor],
  );
  // Clamped at read, so a list that shrank under the selection still marks
  // (and Enter still picks) a row that exists.
  const cur = Math.min(sel, Math.max(0, suggestions.length - 1));

  // `/` and ⌘F focus the bar. Contextual (docs/shortcuts.md): the board is
  // mounted only while it is the view, and no task owns find while it is up
  // (the overlay clears activeTaskId), so the only things to stand down for
  // are an editable control already holding the keyboard, a modal, and the
  // Settings overlay, which traps nothing and is only visible in the store.
  // ⌘F also stands down when the user has bound it to a command: the
  // capture-phase stopPropagation below would otherwise swallow it before
  // useShortcuts' bubble listener ever ran.
  useEffect(() => {
    // Both bars are mounted while the board is up; only the board's binds keys.
    if (sidebar) return;
    const onKey = (e: KeyboardEvent) => {
      const slash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey;
      const find = bindingMatches(e, FIND_BINDING)
        && !Object.values(usePrefs.getState().shortcuts).some(b => bindingMatches(e, b));
      if (!slash && !find) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest('[role="dialog"]') || useApp.getState().view.settingsOpen) return;
      if (slash && el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, .cm-editor')) return;
      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sidebar]);

  const pick = (next: string) => {
    setText(next);
    setSel(0);
    // A picked key (`project:`) wants its values next; a picked value ends
    // the token with a space, and the list stays shut until more is typed.
    setSuggestOpen(next.endsWith(":"));
    inputRef.current?.focus();
  };

  // Parsed, not raw text: `project:` mid-typing filters nothing, and the bar
  // should not claim otherwise.
  const active = useMemo(() => isBoardQueryActive(parseBoardQuery(text)), [text]);
  return (
    <div
      // Sidebar: no vertical padding. The sidebar's head spaces its rows
      // with one gap (Sidebar.tsx), so the bar does not pick its own.
      className={sidebar ? "flex shrink-0 flex-col gap-0.5 px-2" : "flex shrink-0 items-center gap-2 px-3 pt-3"}
      data-testid={tid}
      data-no-drag
    >
      {/* The sidebar's bar is a COLUMN, where `flex-1` means "basis 0 on the
          vertical axis": with the field out of flow this row then has no
          content and collapses to nothing, and the field lands on top of the
          chips. It worked only while the input was in flow and gave the row
          its height. So the row takes its height from h-7 and does not flex
          there; on the board (a row) flex-1 is its width, as before. */}
      <div ref={rowRef} className={cn("relative flex h-7 min-w-0 items-center", sidebar ? "shrink-0" : "flex-1")}>
        <BoardFilterMenu
          text={text}
          setText={setText}
          tid={tid}
          side={sidebar ? "right" : "bottom"}
          focusHint={!sidebar}
          sections={sections}
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
          active={active}
          // Hand the keyboard back to the bar on close, so a menu pick can
          // be followed by typing without a click. Only when focus has
          // nowhere better to be: a close caused by clicking another input
          // (the sidebar filter) leaves focus where that click put it.
          onClosed={() => {
            const el = document.activeElement;
            if (!el || el === document.body || el.closest(`[data-testid="${tid}"]`)) inputRef.current?.focus();
          }}
        />
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          style={grown ? { height: grown } : undefined}
          onFocus={() => setFocused(true)}
          placeholder={t(sidebar ? "sidebar:filterBar.placeholder" : "board.filterPlaceholder")}
          data-testid={`${tid}-input`}
          onChange={e => { setText(e.target.value.replace(/[\r\n]+/g, " ")); setSel(0); setSuggestOpen(true); }}
          onBlur={() => { setFocused(false); setSuggestOpen(false); }}
          onKeyDown={e => {
            // An IME composing (pinyin `pr`) owns Enter and the arrows until
            // it commits; same guard as TerminalPane / AuxTerminal.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (suggestions.length > 0) {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((cur + 1) % suggestions.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((cur - 1 + suggestions.length) % suggestions.length); return; }
              // Tab accepts like Enter; it frees up once a value pick closes
              // the list, so it never traps focus for more than a token.
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pick(suggestions[cur].next);
                return;
              }
            } else if (e.key === "ArrowDown" && !suggestOpen && text !== "") {
              // Esc shut the list; ArrowDown brings it back without typing.
              e.preventDefault();
              setSel(0);
              setSuggestOpen(true);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              // Peel one layer per press: completions, then the text, then focus.
              if (suggestions.length > 0) setSuggestOpen(false);
              else if (text !== "") setText("");
              else inputRef.current?.blur();
            }
            // One line, always: Enter that picked nothing must not start a
            // second one.
            if (e.key === "Enter") e.preventDefault();
          }}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          className={cn(
            "w-full resize-none overflow-hidden rounded-md border py-1 pl-8 pr-6 text-[12.5px] leading-[calc(1.25rem-2px)] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-faint)]",
            // The line height is the row's content box exactly (h-7 less the
            // 1px borders and py-1), so ONE line is one row tall and a
            // focused, unwrapped field does not grow. In rem like the row:
            // the root font size here is 14px, not 16.
            // Out of flow in the sidebar (the wrapper holds the row's height),
            // so growing never moves what is under it. Wrapping only while
            // focused; otherwise, and always on the board, one clipped line.
            sidebar && "absolute inset-x-0 top-0",
            // overflow-wrap, not break-all: lines break at the spaces between
            // clauses first, and only a clause wider than the field is cut.
            // break-all cut every line at the edge, mid-word ("stat" / "us:").
            sidebar && focused ? "z-30 whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre",
            // One row tall unless `grown` (inline) says otherwise.
            !grown && "h-7",
            // Opaque once it covers the chips, or they show through the text.
            sidebar && grown !== null && "bg-[var(--color-bg-1)]",
            // The board's bar sits on --color-bg, so that fill is invisible
            // there: an outlined field on its own surface. The sidebar is one
            // step lighter (bg-1, or a profile wash), where the same fill
            // became a black slot at the top of the list. No fill in the
            // sidebar gives it the look the board always had, and matches the
            // outlined chips under it.
            sidebar ? (grown !== null ? "" : "bg-transparent") : "bg-[var(--color-bg)]",
            // Sidebar, list open: square the bottom and quiet its edge, so
            // the field and the list under it draw as ONE outlined shape with
            // a hairline between them (see the listbox below).
            sidebar && suggestions.length > 0 && "rounded-b-none border-b-[var(--color-border-soft)]",
            // Half-strength accent, not the full token: at full strength a
            // focused or filtering bar was the loudest thing in the sidebar,
            // and louder still once the list hangs off it and doubles the
            // outline's length. The funnel already turns accent to say a
            // filter is on.
            active ? "border-[var(--color-accent)]/50" : "border-[var(--color-border-soft)] focus:border-[var(--color-accent)]/50",
          )}
        />
        {text !== "" && (
          <button
            type="button"
            aria-label={t("board.filterClear")}
            data-testid={`${tid}-clear`}
            onMouseDown={e => e.preventDefault()}
            onClick={() => setText("")}
            // Filled with the surface behind the field. A textarea clips its
            // text at the PADDING edge, not the content edge an input uses,
            // so a clipped query ran on underneath this button.
            className={cn(
              "absolute right-1 z-40 rounded p-0.5 text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]",
              sidebar ? "bg-[var(--color-bg-1)]" : "bg-[var(--color-bg)]",
            )}
          ><X className="h-3.5 w-3.5" /></button>
        )}
        {suggestions.length > 0 && (
          <div
            role="listbox"
            data-testid={`${tid}-suggestions`}
            // Below the field's CURRENT bottom: a wrapped field is taller
            // than the row the list is anchored to.
            style={sidebar && grown ? { top: grown } : undefined}
            // The sidebar clips at its edge, so its list is the input's width.
            // Two shapes, by where the bar is.
            //
            // Sidebar: the list is the input's own width, so it HANGS OFF the
            // field: no gap, no top edge, the field's accent outline carried
            // down its sides and round its bottom. As a separate bordered box
            // 4px below, it was a second outlined rectangle stacked under the
            // first, and read as another input rather than this one's list.
            //
            // Board: the list is narrower than the field, so it cannot join
            // it and stays a menu, in the app's menu chrome (ui/Dropdown.tsx).
            className={cn("absolute left-0 top-full z-40 overflow-hidden bg-[var(--color-bg-1)] p-1 shadow-xl",
              sidebar
                ? "w-full rounded-b-md border border-t-0 border-[var(--color-accent)]/50"
                : "mt-1 w-[260px] rounded-md border border-[var(--color-border)]")}
          >
            {suggestions.map((s, i) => (
              <div
                key={s.next}
                role="option"
                aria-selected={i === cur}
                data-board-filter-suggestion={s.label}
                // mousedown, not click: the input's blur closes the list first.
                onMouseDown={e => { e.preventDefault(); pick(s.next); }}
                onMouseEnter={() => setSel(i)}
                className={cn(
                  "cursor-pointer truncate rounded-sm px-2 py-1 font-mono text-[12px]",
                  i === cur ? "bg-[var(--color-bg-3)] text-[var(--color-fg)]" : "text-[var(--color-fg-dim)]",
                )}
              >
                <Highlighted text={s.label} matches={s.matches} />
              </div>
            ))}
          </div>
        )}
      </div>
      {sidebar ? (
        // the sidebar draws its count beside the status chips (Sidebar.tsx),
        // so a filter turning on never moves the chips under the pointer
        unknownKeys.length > 0 && (
          <div className="flex min-w-0 items-center gap-2 px-1">
            {unknownKeys.length > 0 && (
              <span data-testid={`${tid}-unknown`} className="min-w-0 truncate text-[11.5px] text-[var(--color-warn)]">
                {t("board.filterUnknown", { keys: unknownKeys.map(k => `${k}:`).join(", ") })}
              </span>
            )}
          </div>
        )
      ) : (
        <>
          {active && (
            <span data-testid={`${tid}-count`} className="shrink-0 text-[11.5px] tabular-nums text-[var(--color-fg-faint)]">
              {t("board.filterCount", { shown, total })}
            </span>
          )}
          {unknownKeys.length > 0 && (
            <span data-testid={`${tid}-unknown`} className="min-w-0 truncate text-[11.5px] text-[var(--color-warn)]">
              {t("board.filterUnknown", { keys: unknownKeys.map(k => `${k}:`).join(", ") })}
            </span>
          )}
        </>
      )}
    </div>
  );
});

/** The funnel button and its menu. */
function BoardFilterMenu({ text, setText, tid, side, focusHint, sections, open, onOpenChange, active, onClosed }: {
  text: string;
  setText: (q: string) => void;
  tid: string;
  side: "bottom" | "right";
  /** The `/` hint: only the board's bar answers it. */
  focusHint: boolean;
  sections: FilterFacetSection[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  active: boolean;
  onClosed: () => void;
}) {
  const { t } = useTranslation("chrome");
  const query = useMemo(() => parseBoardQuery(text), [text]);

  return (
    <PopoverRoot open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("board.filterMenuOpen")}
          data-testid={`${tid}-menu-trigger`}
          className={cn(
            "absolute left-1 z-40 flex rounded p-1 hover:bg-[var(--color-bg-3)]",
            "data-[state=open]:bg-[var(--color-bg-3)]",
            active ? "text-[var(--color-accent)]" : "text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]",
          )}
        >
          <ListFilter className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align="start"
        className="flex max-h-[min(70vh,560px)] w-[460px] max-w-[calc(100vw-32px)] flex-col gap-0 p-0"
        onCloseAutoFocus={e => { e.preventDefault(); onClosed(); }}
      >
        <div data-testid={`${tid}-menu`} className="flex min-h-0 flex-col">
          <header className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-soft)] px-3 py-2">
            <ListFilter className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
            <span className="text-[12.5px] font-semibold">{t("board.filterMenuTitle")}</span>
            {active && (
              <button
                type="button"
                data-testid={`${tid}-menu-clear`}
                onClick={() => setText("")}
                className="ml-auto rounded px-1.5 py-0.5 text-[11.5px] text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
              >
                {t("board.filterMenuClear")}
              </button>
            )}
          </header>

          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-3 py-3">
            {sections.filter(sec => sec.options.length > 0).map(sec => (
              <section key={sec.id} data-board-filter-section={sec.id} className="flex flex-col gap-1.5">
                <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--color-fg-faint)]">
                  {sec.title}
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {sec.options.map(o => (
                    <FacetChip
                      key={`${o.key}:${o.value}`}
                      option={o}
                      state={boardClauseState(query, o.key, o.value)}
                      onClick={() => setText(cycleBoardClause(text, o.key, o.value))}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>

          <footer className="flex shrink-0 flex-col gap-1.5 border-t border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-2 text-[11px] text-[var(--color-fg-faint)]">
            <span>{t("board.filterMenuCycle")}</span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Syntax code="-agent:x" label={t("board.filterSynExclude")} />
              <Syntax code="agent:a,b" label={t("board.filterSynAny")} />
              <Syntax code={'project:"a b"'} label={t("board.filterSynQuote")} />
              {focusHint && <Syntax code="/" label={t("board.filterSynFocus")} />}
            </span>
          </footer>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

function Syntax({ code, label }: { code: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <code className="rounded bg-[var(--color-bg-3)] px-1 py-px font-mono text-[10.5px] text-[var(--color-fg-dim)]">{code}</code>
      {label}
    </span>
  );
}

/** Off, included (accent), or excluded (error tint, struck through). The
 *  chip carries its state as `data-state` for specs; the visible difference
 *  is border, fill and the minus mark, never colour alone. */
function FacetChip({ option: o, state, onClick }: {
  option: FilterFacetOption;
  state: BoardClauseState;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-board-filter-chip={`${o.key}:${o.value}`}
      data-state={state ?? "off"}
      aria-pressed={state === "include" ? true : state === "exclude" ? "mixed" : false}
      title={`${state === "exclude" ? "-" : ""}${o.key}:${o.value}`}
      onClick={onClick}
      className={cn(
        "flex h-6 max-w-full items-center gap-1.5 rounded-full border px-2 text-[11.5px]",
        state === null && "border-[var(--color-border-soft)] text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]",
        state === "include" && "border-[var(--color-accent)] text-[var(--color-fg)]",
        state === "exclude" && "border-[var(--color-err)] text-[var(--color-err)]",
      )}
      style={
        state === "include" ? { backgroundColor: "color-mix(in srgb, var(--color-accent) 14%, transparent)" }
        : state === "exclude" ? { backgroundColor: "color-mix(in srgb, var(--color-err) 10%, transparent)" }
        : undefined
      }
    >
      {state === "exclude" && <Minus className="h-3 w-3 shrink-0" />}
      {o.swatch && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: o.swatch }} />}
      {o.icon && <span className="flex shrink-0">{o.icon}</span>}
      <span className={cn("min-w-0 truncate", state === "exclude" && "line-through")}>{o.label}</span>
      {o.count !== undefined && (
        <span className={cn("shrink-0 tabular-nums", state === null ? "text-[var(--color-fg-faint)]" : "opacity-70")}>
          {o.count}
        </span>
      )}
    </button>
  );
}
