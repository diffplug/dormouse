# Mouse and Clipboard — Rationale

> Informative companion to [mouse-and-clipboard.md](mouse-and-clipboard.md): the platform quirks, measurements, and provenance behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## 8.6 Paste Content

**Why native text reads outrank `navigator.clipboard`.** On macOS WKWebView, `navigator.clipboard.readText()` pops a `Paste from <App>` confirmation menu at the cursor on *every* invocation, not once per grant. A paste shortcut that then needs a second click on a menu appearing under the mouse defeats its own purpose, so the adapter's native read is tried first wherever one exists; the `navigator` call is the fallback for hosts that ship no native reader (VSCode, whose shim wires only tiers 1 and 3).

**Why the image temp file lives ~5 minutes.** The window has to be long enough for whatever command the user launched against the pasted path to have opened it — the path is pasted at a prompt the user still has to finish typing and submit — and short enough that a long session pasting screenshots does not accumulate one file per paste in a private temp directory nobody ever cleans. Five minutes is the compromise; nothing in the code depends on the exact number.

**The Windows console-window flicker.** The sidecar runs as a windowless GUI child on Windows, and a console subprocess spawned from it without `CREATE_NO_WINDOW` allocates its own console window: it flashes on screen and steals focus. One paste spawns several of these (the file-reference, text, and image probes), and the burst was enough to freeze the GUI. That flicker is also the reason the Tauri build on Windows dropped the subprocess entirely for a direct Win32 read in `standalone/src-tauri/src/clipboard_win.rs`; the non-Windows hosts kept the shell-out in `standalone/sidecar/clipboard-ops.js` because `pbpaste`/`wl-paste`/`xclip` have no equivalent problem.

**PowerShell quoting (dormouse#430).** `shellEscapePath` picked cmd-style quoting from `IS_WINDOWS` alone, so a PowerShell pane got a double-quoted path — and PowerShell's double-quoted strings are expandable. Dropping a file named `$(calc.exe).txt` staged `"$(calc.exe).txt"`, which ran the subexpression the moment the user pressed Enter, which is the whole reason they dropped the file in. Git Bash and WSL panes on Windows had the same mismatch, minus the execution. That is the bug the per-Session `shellKind` dispatch exists to prevent; the rule is restated at the code in `lib/src/lib/shell-escape.ts`.

## 8.7 Drag-to-Paste

**`dragDropEnabled: false` is no longer load-bearing.** The flag was set so HTML5 drag-and-drop kept working inside the webview, back when pane dragging depended on it. Lath's pane dragging is pointer-based and does not, so nothing in the current layout stack needs the flag off — flipping it would hand the drop back to Tauri's native `WindowEvent::DragDrop` handler, which is already written and wired, and re-enable drag-to-paste in the standalone build. It is left alone because that is a behavior change to schedule deliberately, not a side effect of an unrelated edit.

## 8.9 Clipboard Chords Inside Dormouse's Own Text Fields

**Why `readClipboardText` is the gate.** The JS chord handler exists for one host: the menu-less macOS standalone build, where replacing the default macOS menu also removed the native Paste item that WKWebView routes `⌘C`/`⌘X`/`⌘V` through. Gating on "the adapter implements `readClipboardText`" is a proxy for that, and it over-reaches slightly: it also matches `standalone/src/browser-sidecar-adapter.ts`, whose Chrome webview *does* have working native chords, so there the JS path replaces a working one rather than standing down. Worth knowing when a chord misbehaves only in the browser sidecar — the suspect is the JS handler, not the webview.
