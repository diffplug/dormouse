# Pane Webview — Rationale

Evidence behind [webview-pane.md](webview-pane.md), keyed by its headings. Measured 2026-11-19 on macOS 27 with tao 0.37.2 and wry 0.57.0, in a scratch app posting synthesized `NSEvent`s to its own queue.

## Host capability

**Why wry directly.** Tauri's `unstable` feature builds a window's own webview as a child too (`WebviewKind::WindowChild` in `tauri-runtime-wry`), and wry answers `performKeyEquivalent:` with NO for every child view. A chord bound to a menu item then reaches the menu before any page: ⌘C raised the page's `copy` event and no `keydown`. The app webview must see that `keydown` first to cancel it (`docs/specs/standalone.md` -> "Application menu"). Building only the pane view as a child leaves the app webview a content view, where every chord reached its page.

**Why macOS 14.** A data store apart from the app's own is `WKWebsiteDataStore(forIdentifier:)`, which that release added.

## Lifetime

Removing the view from its window and adding it back kept the page: no reload, form state intact.

A first load that fails leaves the view with no page at all, and `open` adopts an existing view without navigating it, so Reload would adopt an empty view.

## Visibility

Hiding the view kept its page, raised `visibilitychange`, stopped `requestAnimationFrame`, and slowed a 100 ms timer to about one tick a second.

## Keyboard and pointer

An app-level `NSEvent` local monitor saw every `keyDown` and `flagsChanged` before either webview, told left ⌘ from right by key code, and removed a key it returned `nil` for from both pages. In the child view's page, plain keys, a chord bound to no menu item, and either ⌘ alone all raised `keydown`.

Hiding a view that held first responder left the window itself holding it, not the app webview.

## Page boundary

**Why a page may frame `about:`, `blob:`, and `data:`.** wry's navigation handler hears every frame and cannot tell the top one, and pages frame those documents routinely; none reaches outside the engine, where `file:` reads the disk and any other scheme starts another app.

**Why the permission handler is explicit.** wry grants a media-capture request outright when no handler is set.

**Why no network gate.** Neither engine shows a host the address a request resolves to, nor its fetches, sockets, and workers; a gate on top-level navigations alone would promise more than it holds.
