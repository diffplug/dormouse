# Playground Tutorial

> See `docs/specs/glossary.md` for Session / Pane vocabulary, used here for the playground's pane layout and detection wiring.

Device routes (`website/src/routes.ts`):

- **`/playground`** — dispatcher: Pocket for coarse pointers or narrow viewports, Desktop otherwise, then **replaces** the history entry, preserving search + hash (query in `website/src/lib/playground-routing.ts`).
- **`/playground/desktop`** — desktop tiling tutorial; where the dispatcher would pick Pocket, a link to `/playground/pocket` instead of `Wall`.
- **`/playground/pocket`** — mobile Pocket playground; on desktop, the temporary Pocket marketing/share page.
- **`/pocket`** — temporary redirect to `/playground/pocket`. **Keep the real tethering surface off the playground URL.**

**Must hydrate the desktop prerender, then reconcile browser media.** **Must dispatch using browser media, never the hydration fallback.** **Must skip desktop runtime loading when browser media selects Pocket.** Pinned by `website/src/pages/Playground.test.tsx`.

## Profiles

`DESKTOP_TUTORIAL_PROFILE` and `POCKET_TUTORIAL_PROFILE` open inside their `initialSectionId`; desktop's is Make it yours, a single change-the-theme item (rationale). Pocket's Copy paste is desktop's minus `cp-override` ([Pocket Copy paste specifics](#pocket-copy-paste-specifics)).

**Item ids are stable** — they are the localStorage payload entries ([Storage](#storage)).

## Architecture

**Must run the tutorial as a browser-side xterm alt-screen program behind `FakePtyAdapter`, never Node `terminal-kit`.**

**Must derive progress from app events and semantic snapshots, never touch the tiling engine.**

- **Must credit a keyboard split before its automatic passthrough transition**, and tell the user to re-enter command mode for the following navigation item (rationale).
- **Must credit `kb-arrows` only on command-mode selection of a distinct pane**; an arrow or click counts, a swap's resulting focus does not.
- **Must credit `al-spreads` only when newly enabled WATCHING shares a command key with another live pane.**
- **Must credit the `dor open` section from the command lines the shells report**, never from a hook in the playground `dor` or its viewers.

Source of truth: `TutRunner` in `website/src/lib/tut-runner.ts`; `TutDetector` in `website/src/lib/tut-detector.ts`; `TutorialState` in `website/src/lib/tutorial-state.ts`; profiles in `website/src/lib/tut-items.ts`.

## Layout

- **The desktop page must restore its own theme** with `useRestoredTheme(WEBSITE_DEFAULT_THEME_ID)` (`website/src/lib/website-theme.ts`), which also declares the host fallback the Settings picker re-resolves through; its `SiteHeader` carries no controls (rationale).
- `/playground/desktop` runs `Wall` (`FakePtyAdapter`, `initialMode="passthrough"`). **Must seed its three-pane L-shape as an explicit Lath snapshot** — `restoredLathLayout` from `DESKTOP_PLAYGROUND_LAYOUT` — never the synchronous `initialPaneIds` path (rationale); `website/src/lib/playground-desktop-layout.test.ts` pins it. `DESKTOP_PANES` in the same file owns each seed's id, command, and title; **`tut-boxed` is the Auto-copy + `cp-override` target** (rationale). **Titles are seeded as pending shell opts** (`setPendingShellOpts(id, { title })`) before the Wall mounts, and a user-pin outranks the engine fallback (`docs/specs/terminal-state.md` → "Header Derivation").

Every visible pane gets a `TutorialShell` via `PlaygroundShellRegistry`. **`ensureShell` must stay idempotent** — `paneAdded` covers every pane that becomes visible, and `FakePtyAdapter.onPtySpawn` covers the seed panes again, auto-launching each seed's command exactly once (rationale). The page's `startProgram` knows `tutorial` (`TutRunner`), `ascii-splash`/`splash`, `changelog`, and `dor` ([Playground filesystem](#playground-filesystem)).

`/playground/pocket` runs `MobileWall` with **`pocket-tut`** (active, `TutRunner` on `POCKET_TUTORIAL_PROFILE`) and **`pocket-changelog`** (`ChangelogRunner`), and starts a `TutDetector` over the same shared stores. **Must credit Pocket gesture items only on the active tutorial Session's Gesture navigation screen**, through `MobileTerminalUi.onGestureScroll` and `onGestureInput`.

Source of truth: `PlaygroundDesktop` in `website/src/pages/PlaygroundDesktop.tsx`; `PocketPlayground` in `website/src/pages/PocketPlayground.tsx`.

### Pocket gesture opening screen

**Must credit both edge-scroll directions (`gn-scroll`), then all four arrows
(`gn-arrows`), then Enter, then Escape, each only once its predecessor is
complete**; an arrow sent before scrolling completes does not count.
**Must clear partial direction counts on tutorial reset.** Keyboard input and
native wheels never grant gesture credit.

**Must capture the mouse only on this screen**, where vertical wheels scroll its
starfield, and **must stop animation and release capture on leaving or
disposal.** Reduced motion disables idle animation, retaining scroll movement.

Source of truth: `TutRunner` and `GestureStarfield` in
`website/src/lib/tut-runner.ts`; `GESTURE_NAVIGATION_SECTION` in
`website/src/lib/tut-items.ts`.

## Menu and navigation behavior

**Must consume unsupported CSI/SS3 key sequences without treating their prefix as Esc**; arrows accept CSI and application-mode SS3. Pinned by `website/src/lib/tut-runner.test.ts`. **`Reset progress` requires the user type `reset`**, then clears storage ([Storage](#storage)) and returns to the profile's initial screen.

Extras: `Starred on GitHub` (persisted separately), FlappyTerm, `Reset progress` — **none of the three ever counts toward a section's progress**. FlappyTerm stays locked until every section checklist item is complete.

### Runner-local intercepts

**`TutRunner` intercepts four keys while a specific section is open; they are not real Dormouse shortcuts.** The three alert demos report fake commands as `OSC 633 ; E / C / D` through `FakePtyAdapter.sendOutput`, which the real `TerminalProtocolParser` strips from visible output (rationale). **Must snapshot the live inactivity timeout at demo launch; the run outlasts it and the BUSY-confirm floor.** Each demo's countdown, page timer, and re-press guard run the same snapshotted duration — longer for `s`, whose fake command must outlive WATCHING's silence chain. Pinned by `website/src/lib/tut-runner.test.ts`.

- **`s`** (Alerts) — reports `longtask` on both alert panes so command-keyed WATCHING demonstrates `al-spreads`, pumping only the quiet `tut-boxed` (rationale). **A press while that command is still running is ignored**, and **the page cancels any prior pump and exit timer** — the runner's guard is per instance, so a re-run `tutorial` would otherwise stack them.
- **`n`** (Alerts) — writes a raw `OSC 777` notification to `tut-boxed`, exercising a terminal report, which needs no WATCHING rule.
- **`x`** (Alerts) — starts a fake `slowbuild` on `tut-splash` and reports its exit after the captured duration. **The command name must stay unwatched**, so a command exit rather than WATCHING raises the ring (rationale). **The page must cancel the prior exit timer across runner instances.**
- **`p`** (Copy paste) — toggles the **Place To Paste** scratch modal (`website/src/components/PlaceToPaste.tsx`). Desktop only.

### Pocket Copy paste specifics

Pocket reuses `cp-select` / `cp-raw` / `cp-rewrap` but drops `cp-override`: Select mode auto-overrides mouse capture for every Pocket session whose TUI captures the mouse (`docs/specs/mobile-terminal-ui.md` → "Touch mode selector"), so it never asks the user to click the cursor icon. A live prompt above the checklist reflects the touch mode, neither stored nor counted.

## Fake shell behavior

`TutorialShell` ([Layout](#layout)):

* **Shell integration must be reported for every command it runs** — `OSC 633 ; A/B` around the prompt, `633 ; E` + `633 ; C` on launch, `633 ; D` on exit. WATCHING is keyed on the running command's name (`docs/specs/alert.md`), and the OSCs also keep `docs/specs/terminal-state.md`'s keystroke fallback from engaging here (rationale).
* **While a program runs, every input byte goes to it** — `\x03` included, which the runners treat as quit — as do bytes left in the chunk after the Enter that launched it. On exit the terminal returns to the prompt instead of restarting the program. At the prompt, `\x03` abandons the line for a new prompt and runs nothing. Tab completes the last word: a command name, and on the desktop `dor`'s verb or a snapshot path.

**The only commands are the ones `startProgram` knows** ([Layout](#layout)) and the desktop's `cd`, `ls`, and `pwd`; anything else prints an "Unknown command" line and exits `127`.

## Playground filesystem

The desktop shells share one read-only filesystem: the tracked files of `dor-tools-lib/`, inlined at build time and mounted at `/home/demo/dor-tools-lib`, every shell's starting directory. Beside it sits the playground's own user config at `~/.config/dormouse/dormouse.yml`, **inert**: shown, never read for rules. `website/src/lib/playground-fs/playground-fs.test.ts` pins the snapshot to `git ls-files dor-tools-lib` and the config to a warning-free user Tool file.

- **Must report the shell's directory with every prompt (`OSC 633 ; P ; Cwd=`)**: take-over and launch matching compare it (`docs/specs/dor-tool.md` → Take-over). `cd`, `ls`, and `pwd` are the filesystem builtins; nothing writes.
- **Must print each spawned non-helper terminal's first prompt from `PlaygroundShellRegistry`**; no scenario plays on the desktop, and a split Tool waits on that prompt's integration (rationale).
- **Must name `/bin/fake` as the default shell**, so a Windows visitor's Tool commands quote as posix rather than being refused as `cmd` (rationale).
- **The playground `dor` must run the real CLI's commands that load without Node** — through `dor/src/cli-app.ts` and a `ControlClient` that sends each request to the Wall — **print its help** (the snapshots `dor/test/cli-help.test.mjs` pins), **and serve `open` / `o` (with the real picker), `version`, `skill`, and the `__view-*` entries; what needs Node must fail `UNSUPPORTED IN PLAYGROUND`.** `FakePtyAdapter.toolControl` answers `open` and `open-handlers` from the snapshot as a host with no user `dormouse.yml` does.
- **A `__view-*` entry must report its port before announcing it, and withdraw it on exit.**
- **Must serve the real viewer pages and CSPs on the Node viewers' routes, answered from the snapshot**; `save`, `image`, and `rename` answer `403`. The editors are unchanged, so edits stay in the page.
- **`createIframeProxyUrl` must map only a `localhost` URL under `/playground-fs/` to the page's own origin**, refusing others (`scheme`). The viewer pages carry the shim from `instrumentHtml`, so theme and the save channel connect as behind a proxy, and are same-origin with the Wall: first-party pages over a fixed snapshot.
- **The `/playground-fs/` service worker must stay stateless**: it serves `assets/*` from the static `/builtin-viewer/` build and relays every other request to the top-level playground windows, where the one holding the URL's token answers (rationale). It registers when the first viewer starts; without one, `__view-*` exits `1`.

Source of truth: `installPlaygroundFs` in `website/src/lib/playground-fs/index.ts`; `TutorialShell` in `website/src/lib/tutorial-shell.ts`; `website/public/playground-fs/sw.js`; `website/scripts/build-builtin-viewer.js`.

## Storage

`TutorialState` persists to `localStorage`. **Unknown ids in a stored payload are filtered on load**, so renaming an id is a one-way reset. **Both profiles share the completion key**, so **`markComplete` must reject an id outside the profile's own sections** — a Pocket detection that names a desktop-only item would otherwise arrive pre-checked. **Must share completed common items across profiles; keep absent-profile ids stored but exclude them from that profile's totals.**

**Must keep progress and reset working without storage**, pinned by `website/src/lib/tutorial-state.test.ts`.

- `dormouse-tut-v3` — JSON array of completed item ids.
- `dormouse-tut-star-v1` — `"true"` after `Starred on GitHub`.
- `dormouse-flappy-high-v1` — high score.

**Must remove all three on `TutorialState.reset()`, even when rejected stored values left progress empty.** Legacy `dormouse-tutorial-step-N` / `dormouse-tut-v2-*` keys are never read.

## Lib hooks backing the tutorial

Hooks in `dormouse-lib` / `MobileTerminalUi` that exist for tutorial observability:

- **`WallEvent.kill` / `move` / `paneAdded`** — discriminants on the `WallEvent` union. `kill` fires from `killPaneImmediately`, so every kill path credits `kb-kill`. **`move` must fire from both** the Cmd/Ctrl-Arrow swap in `lib/src/components/wall/keyboard/handle-pane-shortcuts.ts` **and** the center-drop swap in `Wall.onProposeMove` (rationale). **`paneAdded` fires once per pane that becomes visible** — seed ids, splits, dor surfaces, restores, auto-spawn — with seeds announced explicitly.
- **`FakePtyAdapter.pumpActivity`** — drives the alert manager for a fixed duration with no data output (the `s` demo). Returns a cancel handle; stops on its own if the pty dies mid-duration.
- **`FakePtyAdapter.sendOutput`** — pushes data through the real protocol parser as if the PTY produced it (rationale). **Unlike `writePty` it is not suppressed while a scenario is playing.**
- **`FakePtyAdapter.onPtySpawn`** — fires synchronously inside `spawnPty`, before the scenario plays, so a page attaches a shell without racing `TerminalPane`'s mount.
- **`subscribeToWatchedCommands` / `getWatchedCommands`** (`lib/src/lib/watched-commands.ts`, re-exported from `terminal-registry`) — the WATCHING rule set; **must credit `al-watch-cmd` only once `longtask` is watched**.
- **`MobileTerminalUi.onGestureInput`** — optional, reports radial-menu input only; **must fire before the input is sent**, so the final Escape is credited before it leaves the tutorial screen. Pinned by `lib/src/components/MobileTerminalUi.test.tsx`.
- **`MobileTerminalUi.onGestureScroll`** — optional, reports signed line counts only for edge scrolling.
- **`subscribeToActiveTheme` / `getActiveThemeId`** (`lib/src/lib/themes/`) — the active theme, watched to credit `th-theme`. **Must seed the detector's previous theme at `start()` and compare consecutive ids**, so boot-time restore cannot grant the item and choosing the startup theme after a reset still can. Pinned by `website/src/lib/tut-detector.test.ts` (rationale).

Source of truth: `WallEvent` in `lib/src/components/wall/wall-types.ts`, emitted from `lib/src/components/Wall.tsx`; `FakePtyAdapter` in `lib/src/lib/platform/fake-adapter.ts`; `MobileTerminalUi` in `lib/src/components/MobileTerminalUi.tsx`.

## Future

Two `tut-boxed` scenarios close the playground's `docs/specs/mouse-and-clipboard.md` coverage gaps, needing no section change:

1. **`SCENARIO_BRACKETED_PASTE_TUI`** — closes [§8.5](mouse-and-clipboard.md#85-bracketed-paste). Emits `\x1b[?2004h` and an idle ANSI-framed view.
2. **`SCENARIO_SMART_TOKENS`** — closes the [§3.3](mouse-and-clipboard.md#33-selection-hint-text) hint and [§5.1–§5.3](mouse-and-clipboard.md#51-detection). Prints one of each shape from `lib/src/lib/smart-token.ts`'s `PATTERNS`.
