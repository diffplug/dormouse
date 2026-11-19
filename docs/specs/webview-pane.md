# Pane Webview

> - See `docs/specs/glossary.md` for canonical Surface / Session / Pane / Door vocabulary.
> - Owns the `webview` render mode of the browser Surface, a native view that loads the page at its real origin. `docs/specs/dor-browser.md` owns the browser Surface, its other renderers, and render swaps; `docs/specs/standalone.md` the host it runs in; `docs/specs/security-local.md` -> "Webview panes" what a page may reach.
> - A *pane webview* is the native view this spec describes; the *app webview* is the one that runs Dormouse.

## Host capability

A host offers the mode by setting `PlatformAdapter.paneWebview` before the first render; standalone sets it on macOS 14 and later and on Windows (rationale). **Must send one view's commands to the host one at a time, in order**, a still request aside (rationale). On Windows `open` answers before the view exists, and its page follows as events (rationale). **Must render a `webview` Surface with the iframe renderer on a host without it, keeping `renderMode` stored**, so the Surface returns to its mode on a host that has it.

Every pane webview is built with wry directly on the app window, in one Rust file, never through Tauri's `unstable` multiwebview (`docs/specs/security-local.md` -> "Webview panes"; rationale).

Source of truth: `PaneWebviewHost` in `lib/src/lib/platform/types.ts`; `initPaneWebview` in `standalone/src/tauri-adapter.ts`; `rendersInIframe` in `lib/src/components/wall/browser-surface.ts`; `standalone/src-tauri/src/pane_webview.rs`.

## Entry points

A webview pane opens from `dor webview` (`docs/specs/dor-cli.md` -> "Browser Open Target Resolution"), a render swap, a page's new-window request, and the iframe renderer's refusals (`docs/specs/dor-browser.md` -> "Iframe Renderer"). A Client frames its local `http:` page as an iframe pane's (`docs/specs/remote-api.md` -> "Frames").

Source of truth: `webviewCommand` in `dor/src/commands/iframe.ts`; `pageOf` in `lib/src/remote/burrow/embedded-pages.ts`.

## Lifetime

**The host keys a pane webview by Surface id; a panel that mounts opens or adopts its Surface's view, and one that unmounts only hides it.** A move between Workspaces therefore reloads nothing, and a move to another window reparents the view (rationale). **Only `closeBrowserSurface`, the end of its window, a reload of that window's app webview, or a first load that fails destroys one** (rationale); on Windows a failed load shows the engine's error page, and only a view that cannot be built is destroyed.

`url` in params is every top-level `http(s)` URL the host reports. A restart is a cold load there; the profile's cookies and storage survive it.

Source of truth: `WebviewPanel` in `lib/src/components/wall/WebviewPanel.tsx`; `closeBrowserSurface` in `lib/src/components/wall/agent-browser-surface-controller.ts`; `forget_window` in `standalone/src-tauri/src/pane_webview.rs`.

## Visibility

A pane webview paints above everything the app webview draws, and takes neither transform nor clip.

- **Must show a pane webview only while its pane is in sight** (`docs/specs/dor-browser.md` -> "Resource Policy"); a hidden one keeps its page, which the engine throttles (rationale).
- Every modal, menu, and prompt hides them all first (`docs/specs/security-local.md` -> "Webview panes").
- A hidden view's placeholder shows a still of its open page, taken only while the view is shown. **Never wait for a still to hide a view.** A new URL or a closed view drops it.

Source of truth: `useOccludePaneWebviews` in `lib/src/lib/pane-webview-occlusion.ts`.

## Keyboard and pointer

The app webview receives no key or pointer event while a pane webview holds focus.

- **Must give a pane webview the keyboard only while it is shown and its pane is the passthrough pane**; hiding or closing one that holds it returns focus to the app webview (rationale), and a pane's release moves nothing unless its own view holds the keyboard.
- The host observes keys and presses natively, never through the page, and reports the leader, presses, and the pointer leaving as events (`docs/specs/security-local.md` -> "Webview panes"; rationale). **Must detect the leader exactly as `dualTap` does** (`docs/specs/layout.md` -> "Mode switching"); a press enters its pane like a click.
- **Must report which pane webview holds focus**: that is no real blur (`docs/specs/layout.md` -> "Corner cases" #2), and keeps presence (`docs/specs/alert.md` -> "Engagement").
- On macOS a chord bound to a menu item reaches the menu, never the page (rationale); the Edit submenu is the page's clipboard path (`docs/specs/standalone.md` -> "Application menu").

Source of truth: `install` and `on_raw_input` in `standalone/src-tauri/src/pane_webview.rs`; `paneWebviewHoldsFocus` in `lib/src/lib/window-focus.ts`.

## Page boundary

- A page may also frame its own `about:`, `blob:`, and `data:` documents (rationale), and its permission requests meet an explicit handler, and its fullscreen never leaves its pane (rationale).
- A new-window request takes a press (rationale), opens nothing itself, and counts only from a page on screen: the panel asks while its pane is in sight, then opens the URL in a new webview pane beside its own.
- One persistent profile serves every pane webview.
- The network policy does not gate a pane webview: it is the user's own connection, as a terminal's is (rationale).

Source of truth: `may_load` in `standalone/src-tauri/src/pane_webview.rs`; `onOpenBrowserPane` in `lib/src/components/Wall.tsx`.

## Future

**Scope: webview-panes** — what remains, in staged order:

1. The pane context menu and a Tool's Break opening a webview pane.
2. Surviving an app-webview reload, by adoption.

Not planned: Linux, VS Code, a Client rendering one, an agent driving one.
