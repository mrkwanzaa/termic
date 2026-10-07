# Future work: browser tab via a real-`src` iframe (proposal 2)

Deferred, not built. The pragmatic alternative to [the child-webview
approach](browser-tab-child-webview.md), which research found gated behind
Tauri v2's `unstable` feature flag with a real core bug history and an
unresolved IPC-isolation question — not something to build a sandboxed
agent-execution tool's browser tab on today.

Triggered by the same gap #374 left open: `HtmlPane`'s `<iframe sandbox=""
srcdoc>` runs no JavaScript at all (`script-src 'self'` blocks it twice over,
per `src/lib/htmlPreview.ts`), so a Chart.js report renders blank. Simion
wants real JS, real back/forward/refresh, and the ability to point at either
a running dev server (`http://localhost:PORT`) or a static HTML file from the
task's own repo.

## The core idea

Same primitive termic already reaches for — an iframe — but pointed at a real
`src` URL instead of fed `srcdoc`. A `src` navigation is a genuinely
cross-origin load (unlike srcdoc, which — per `HtmlPane.tsx`'s own comment —
shares the app's `tauri://localhost` origin, and with it `__TAURI_INTERNALS__`,
unless `sandbox=""` is present). Two distinct `src` targets cover both of
Simion's cases:

- **Running dev server** — `src="http://localhost:PORT"` directly.
  `RunControls.tsx` already resolves this exact URL today
  (`targets.find(t => t.member === "")?.previewUrl`) to open it in an
  *external* browser via `openWebUrlForProject`; this reuses the same
  resolved URL, just renders it in-app instead of shelling out.
- **Local repo HTML file** — not `file://` (Tauri doesn't serve raw
  filesystem URLs into a webview by default) but a custom scheme, the same
  pattern termic already ships for PDFs: `PreviewPane.tsx` serves PDFs
  through a `taskpdf:` URI handled in `src-tauri`, specifically because an
  `<embed>` needs a real `application/pdf` resource, not a data URL. An HTML
  file has the identical need — real JS and relative resource loads (CSS,
  images, a sibling `chart.js`) only work against a real resource URL, never
  a data: or srcdoc blob. Either a new `taskhtml:` scheme mirroring
  `taskpdf:`, or Tauri's built-in asset protocol
  (<https://v2.tauri.app/security/asset-protocol/>, `convertFileSrc` +
  `app.security.assetProtocol.enable=true` + an explicit path-glob scope)
  does this. Prefer the built-in asset protocol unless it can't be scoped
  tightly enough to "files under this task's working directory" — a custom
  scheme can enforce that at the Rust layer trivially, same as `taskpdf:`
  already does per-task.

Both targets land the iframe content on an origin that is NOT
`tauri://localhost` (a real `http://localhost:PORT` origin, or the asset
protocol's `asset.localhost` / custom-scheme origin) — so, unlike srcdoc
without `sandbox=""`, real JS execution does not imply same-origin access to
the app's own globals. That's the security story this proposal rests on.

## Sandbox attribute: different rules than #374's

#374's iframe needs `sandbox=""` (empty) because its content was same-origin
(srcdoc). This proposal's content is cross-origin by construction, so the
goal flips: **we want JS to run**, so `sandbox="allow-scripts"` at minimum.
Whether to add `allow-same-origin` needs a real decision, not a reflex:

- Without it, the frame keeps an opaque origin per navigation — scripts run,
  but any client-side storage (localStorage, IndexedDB) the dev server's app
  relies on breaks across reloads, and `postMessage`-based dev tooling (HMR
  overlays, some dev-server-to-page reload channels) may misbehave.
  Strictly safer.
- With it, the frame gets its REAL origin (`http://localhost:PORT` or the
  asset origin) rather than opaque — normal web-app behavior, matching what
  opening the same URL in an actual browser tab would do. Still cannot reach
  `tauri://localhost` or `__TAURI_INTERNALS__`, because that's a different
  origin regardless of this flag; `allow-same-origin` only restores the
  iframe's OWN origin identity, it does not grant cross-origin reach into
  the parent app.

Given Simion wants this to behave like "a browser tab," default to
`allow-same-origin` (dev servers expect normal web behavior) but keep
`allow-top-navigation` and `allow-popups` OFF — a dev server redirecting the
whole frame to some external auth flow, or spawning child windows, is not
part of the ask and widens what an agent-controlled page can do inside
termic's window.

## Back / forward / refresh

Real navigation inside the iframe (clicking a link, the dev server's own
client-side router) is invisible to the parent unless tracked. There is no
free "listen to iframe history" API across origins — same limitation the
child-webview research found for `on_navigation`. Minimum viable version:

- Maintain the history stack in React state (termic side), pushing the
  current URL whenever the tab is first opened or the user explicitly types
  a new address.
- "Refresh" is trivial — reset `iframe.src` to its current value (or bump a
  cache-busting key).
- "Back"/"Forward" against same-origin content CAN use `iframe.contentWindow
  .history.back()/.forward()` — reachable only when the iframe content is
  same-origin-with-parent, which it deliberately is NOT here. So back/forward
  across cross-origin navigations has to be termic-tracked: re-set `src` to
  the previous/next URL in the stack. Simpler than it sounds, and it's
  exactly the same shape of problem the child-webview approach also has
  (neither approach gets free browser history for free) — but without the
  `unstable`-flag and core-bug baggage.
- In-page link clicks are invisible from outside without instrumentation.
  Full fidelity (every in-page navigation pushed onto the history stack)
  needs either `on_navigation`-style cooperation (not available for a plain
  iframe) or periodic polling of `contentWindow.location.href`, which throws
  across origin. Realistic MVP: track explicit URL-bar navigations and treat
  in-page link clicks as "the dev server's own business" (same as any real
  browser tab navigating within an SPA) — only resync the address bar on tab
  focus using whatever signal is available (e.g. a `postMessage` convention
  the dev server's HMR client might already emit), not by reaching into
  `contentWindow`.

## UI integration (per Simion's spec)

- New tab type in the `Tab` union (`src/lib/types.ts`, alongside `terminal /
  diff / edit / dir / scratch / external`) — e.g. `BrowserTab`, holding the
  current URL + a termic-side history stack.
- `NewTabMenuItems.tsx`: a "Browser" row in the "+" menu, same tier as
  "Scratchpad" (`onScratchpad` already follows this exact pattern — spawn an
  untitled tab in the active pane).
- `RunControls.tsx`: today's `previewUrl` Globe button calls
  `openWebUrlForProject` (opens the user's EXTERNAL configured browser).
  Change its default action to open/focus a `BrowserTab` pointed at
  `previewUrl` instead; keep the external-browser option one click away
  (chevron dropdown), not removed — some users will still want their real
  browser (devtools, extensions).
- Every `BrowserTab` (and, inside it, ideally every outbound link — at least
  at the "open current URL externally" granularity, full per-link
  interception would need injecting a content script, likely out of scope
  for v1) gets an "open in external browser" icon reusing
  `openWebUrlForProject`, so the built-in tab is never a dead end.

## Known limits (be upfront about these, same spirit as #374's doc)

- Back/forward is termic-tracked, not native browser history — see above.
- In-page SPA navigation inside the dev server won't update termic's address
  bar automatically without extra plumbing.
- `allow-same-origin` + `allow-scripts` together is the standard "basically a
  real tab" sandbox combo, but it DOES mean an agent-controlled dev server
  page can, e.g., open its own alerts/dialogs, use clipboard APIs subject to
  browser permission prompts, etc. — normal web page capabilities, scoped to
  its own cross-origin sandbox, never termic's.
- Local HTML file serving needs the asset-protocol scope (or a new
  `taskhtml:` scheme) restricted to the task's own working directory,
  mirrored off the existing `taskpdf:` per-task scoping — do not widen it to
  "any path on disk."

## What NOT to do

- Do not reuse `srcdoc` for this — the whole point is a real resource origin
  so JS and relative resources work; `srcdoc` is same-origin-with-app
  without `sandbox=""`, which is the wrong direction entirely.
- Do not add `allow-top-navigation` / `allow-popups` for v1.
- Do not serve local HTML over raw `file://` — follow the `taskpdf:` /
  asset-protocol precedent, scoped per task.

## Open questions

- `taskhtml:`-style custom scheme vs. Tauri's built-in asset protocol — pick
  based on how tightly the asset protocol's glob scope can be bound to a
  single task's working directory at runtime (one global scope vs. one
  scope entry per active task).
- Exact sandbox flag set — ship `allow-same-origin` by default, or make it a
  per-project setting like `preview_browser` already is?
- Whether partial in-page navigation tracking (via a `postMessage`
  convention) is worth building for v1, or whether "address bar reflects
  only explicit navigations" ships first and gets revisited.
