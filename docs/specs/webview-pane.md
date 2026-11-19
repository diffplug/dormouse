# Pane Webview

> Status: design — nothing here is implemented yet.
>
> - See `docs/specs/glossary.md` for canonical Surface / Session / Pane / Door vocabulary.
> - Owns the `webview` render mode of the browser Surface: the native view, its host boundary, its visibility, keyboard, and storage. `docs/specs/dor-browser.md` owns the browser Surface, its other renderers, and render swaps; `docs/specs/standalone.md` owns the host it runs in.
> - A *pane webview* is the native view this spec describes; the *app webview* is the one that runs Dormouse.

## Future

**Scope: webview-panes** — a browser Surface rendered by a native child webview that loads the page at its real origin, where the iframe renderer shows a proxied copy. Staged order:

1. macOS: the host boundary, the panel, sight-driven visibility, the native leader.
2. Snapshot stand-ins under motion and overlays.
3. `dor webview <url>`, and the entry points that default to it.
4. A Client's frame of a local `http:` page whatever the laptop renders with (`docs/specs/remote-api.md` -> "Frames").
5. Windows.
6. Surviving an app-webview reload, by adoption.

Not planned: Linux, VS Code, a Client rendering one, an agent driving one.

### Host capability

A host offers the mode by setting `PlatformAdapter.paneWebview`; `PaneWebviewHost` and `PaneWebviewEvent` in `lib/src/lib/platform/types.ts` own the shape. Standalone sets it on macOS 14 and later. **Must render a `webview` Surface with the iframe renderer on a host without it, keeping `renderMode` stored**, so the Surface returns to its mode on a host that has it.

**Must build every pane webview with wry directly on the app window, in one Rust file; never through Tauri's `unstable` multiwebview** (rationale). `docs/specs/security-local.md` -> "Browser panes" owns what that file may hand a page.

### Lifetime

**The host keys a pane webview by Surface id, and only `closeBrowserSurface` or the end of its window destroys one.** A panel that mounts opens or adopts its Surface's view; a panel that unmounts hides it. A move between Workspaces therefore reloads nothing, and a move to another window reparents the view. An app-webview reload destroys that window's views until stage 6.

`url` in params is every committed top-level `http(s)` URL, as the host reports it. A restart is a cold load there; the profile's cookies and storage survive it.

### Visibility

A pane webview paints above everything the app webview draws, and takes neither transform nor clip.

- **Must show a pane webview only while its pane is in sight** (`docs/specs/dor-browser.md` -> "Resource Policy") **and nothing Dormouse draws overlaps it**; a hidden one keeps its page, which the engine throttles.
- **Must hide every pane webview before a modal, menu, or prompt renders**: a page that covered one could imitate it.
- While shown, its bounds follow its pane's laid-out rect every frame.

### Keyboard and pointer

The app webview receives no key or pointer event while a pane webview holds focus.

- **The host detects the leader natively, only while a pane webview holds focus, and reports it as an event**; the page sees no injected script and can neither forge nor block it. The gesture is `dualTap`'s (`docs/specs/layout.md` -> "Mode switching").
- **Must report a press inside a pane webview**, which enters its pane like a click.
- **Must report which pane webview holds focus**, so a focused one is not app backgrounding (`docs/specs/alert.md` -> "Engagement").
- **A hidden pane webview never holds focus**: hiding one returns focus to the app webview.
- On macOS a chord bound to a menu item reaches the menu, never the page (rationale); the Edit submenu is the page's clipboard path (`docs/specs/standalone.md` -> "Application menu").

### Page boundary

- One persistent storage profile serves every pane webview, never the app webview's own.
- **Must open and navigate a pane webview only at `http:` and `https:`, and refuse a page any navigation outside those and the `about:`, `blob:`, and `data:` documents it frames itself** (rationale). A new-window request is reported as an event and opens nothing itself.
- **Must deny every permission request and every download.**
- The network policy does not gate a pane webview: it is the user's own connection, as a terminal's is.
