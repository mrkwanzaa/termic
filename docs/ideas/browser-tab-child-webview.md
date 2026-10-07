# Future work: browser tab via Tauri's child Webview

Deferred, not built. Researched as the "real browser tab inside a task"
option — back/forward/refresh, real JS, loads either a running dev server or
a local HTML file from the task's repo — triggered by #374's srcdoc iframe
preview not being enough for agent-generated HTML that uses real JS (Chart.js
etc. render blank under #374; see its "Known limits").

**Verdict: not mature enough to ship on today.** See [proposal 2](browser-tab-iframe-nav.md)
for the approach this points to instead.

## What it actually is

`tauri::webview::WebviewBuilder` + `window.add_child(builder, position, size)`
(Rust) / `new Webview(...)` (JS,
<https://v2.tauri.app/reference/javascript/api/namespacewebview/>) creates a
**second native webview surface** (WKWebView on macOS via WRY) layered inside
an existing window. Not an iframe — a real second browser engine instance,
with its own process/rendering, positioned and sized independently of the
app's own React webview.

Confirmed directly from `docs.rs`/`v2.tauri.app` and cross-checked by
adversarial verification (3/3 agents agreed):

- Creating one requires the `unstable` Cargo feature on the `tauri` crate
  (`tauri = { version = "2", features = ["unstable"] }`). As of current v2
  releases this is still how it's gated — it has not graduated to stable.
- The JS/Rust surface covers lifecycle (create, close, resize, reposition)
  and an `on_navigation` closure hook (called on navigate attempts;
  returning `false` cancels). There is no dedicated `back()` / `forward()` /
  `reload()` method — a real back/forward stack would have to be built by
  hand (track history, re-navigate), exactly the work #374's srcdoc approach
  also doesn't do for you.
- Local files load through the same `asset://` custom protocol as the main
  webview (`convertFileSrc`), not raw `file://` — requires
  `app.security.assetProtocol.enable=true` plus an explicit scope of glob
  patterns for allowed paths. This part transfers cleanly to either approach.

## Why it's not ready

- **A real core bug, not a cosmetic one.** Child webviews created via
  `add_child` were, at one point, incorrectly treated as full/independent
  webview *windows* rather than embedded child surfaces on macOS and Windows
  — wrong enough to need a dedicated core fix (`fix(core): fix child
  webviews on macOS and Windows treated as full webview window`). That's the
  kind of bug that says the embedding primitive itself wasn't solid yet, not
  a one-off edge case.
- **A maintainer called the whole feature area out.** nothingismagick
  (Tauri core) stated multiple/embedded webviews were outside the original
  design goals and explicitly used the words "feature creep," estimating
  "thousands of hours of engineering effort" to sandbox properly
  (tauri-apps/tauri#2975). Multi-webview-per-window only shipped later via a
  dedicated PR (#8280) — it's a relatively recent addition, not a
  long-proven path.
- **It has been done, barely.** One GitHub user (nileshtrivedi,
  tauri-apps/tauri#2975) built "a very rough POC of a Tauri-based browser/os
  thingie" on `multiwebview` — real evidence it's *possible*, but "very
  rough POC" is the only public production-adjacent data point we found, not
  a track record.
- IPC exposure to content loaded in a child webview wasn't something we
  could pin down with confidence — several claims about exact default IPC
  scoping for child surfaces were made in the raw research pass but did not
  survive adversarial verification (killed 0-3 / 1-2), so treat "does a
  child webview get `window.__TAURI__` by default" as genuinely open, not
  settled either way. That's a second unknown stacked on top of the first.

A few other claims surfaced in initial research (a resize bug where child
webviews stop tracking the parent's horizontal size after repeated resizes;
a position-shift bug after maximize/restore; dropdowns/headers getting
visually covered by a child webview per wry/wry#458) were **not confirmed**
under adversarial re-verification — don't repeat them as fact, they didn't
hold up when checked against the primary source.

## What would have to be true before revisiting this

- `unstable` flag removed / feature marked stable upstream.
- A documented, reproducible way to get real back/forward/reload state
  (even hand-rolled) without fighting `on_navigation`'s cancel-only shape.
- A clear, source-backed answer on IPC exposure for child-webview content —
  termic is a sandboxed agent-execution tool; an accidental IPC leak from
  arbitrary agent-generated or dev-server content into `window.__TAURI__`
  is a real vulnerability, not a UX bug.
- Evidence of at least one other shipping app running multi-webview-per-window
  in production, not just a "rough POC."

## What NOT to do

- Do not build on `add_child` while it's behind `unstable` — that flag is
  Tauri's own signal, not termic being overly cautious.
- Do not assume IPC isolation "probably works like the iframe did" — it's
  unverified, and the failure mode (agent-generated HTML touching Tauri
  commands) is worse than anything #374's sandboxed iframe could do.

## Sources

- <https://v2.tauri.app/reference/javascript/api/namespacewebview/>
- <https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html>
- <https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html>
- <https://github.com/tauri-apps/tauri/issues/2975> (feature-creep quote, POC report)
- <https://v2.tauri.app/security/asset-protocol/> (asset protocol / local file scope)
