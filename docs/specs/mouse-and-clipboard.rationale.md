# Mouse and Clipboard — Rationale

> Informative companion to [mouse-and-clipboard.md](mouse-and-clipboard.md): the platform quirks, measurements, and provenance behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## 3.1 Initiating a Selection

**How a mouse-up outside the iframe still reaches us.** Pointer capture is taken on mouse-down, and Chromium delivers the captured `pointerup` across the frame boundary even when the button comes up over the host chrome, so the drag finalizes once at the real release. Engines that do not honor cross-frame capture deliver no such event, so a window `mousemove` reporting `buttons === 0` is treated as the mouse-up that was missed: a pointer still holding the button reports `buttons === 1`, so the heal never fires mid-drag, and it only needs the pointer to re-enter the frame. The two paths do not double-finalize: the captured-pointerup path defers to a macrotask and stands down if the compatibility mouseup for an *inside* release arrives first.

## 5.1 Detection

**Why trailing punctuation is stripped before the patterns run, not after.** Terminal output puts tokens inside sentences: `Error at src/foo.ts:42.` ends in a period that no path pattern will match, so matching first and trimming after finds nothing to trim. Stripping first leaves `src/foo.ts:42`, which the error-location pattern recognizes — the `:line[:col]` digits survive because they are not trailing punctuation. Matched bracket pairs are preserved for the mirror-image case: `https://en.wikipedia.org/wiki/Foo_(bar)` really does end in `)`, and trimming it truncates the URL.

## 8.2 Paste Keybindings

**Why paste breaks the clean macOS separation that copy keeps.** On macOS, `⌘C` is copy and `Ctrl+C` is SIGINT, and honoring that split costs nothing — a Mac user reaching for copy reaches for `⌘`. Paste is not symmetric: `Ctrl+V` is the universal expectation on every platform, so a macOS build that ignored it would read as broken rather than principled. Intercepting all four combinations everywhere is the cost of that, and the cost is real: `Ctrl+V` is also readline's `quoted-insert` and vim's literal-next, so the raw `0x16` byte can no longer be typed with the key that means it. §8.3's `Ctrl+Q` covers the shells; nothing covers a program that implements neither.

## 8.6 Paste Content

**Why native text reads outrank `navigator.clipboard`.** On macOS WKWebView, `navigator.clipboard.readText()` pops a `Paste from <App>` confirmation menu at the cursor on *every* invocation, not once per grant. A paste shortcut that then needs a second click on a menu appearing under the mouse defeats its own purpose, so the adapter's native read is tried first wherever one exists; the `navigator` call is the fallback for hosts that ship no native reader (VSCode, whose shim wires only tiers 1 and 3).

**Why the image temp file lives ~5 minutes.** The window has to be long enough for whatever command the user launched against the pasted path to have opened it — the path is pasted at a prompt the user still has to finish typing and submit — and short enough that a long session pasting screenshots does not accumulate one file per paste in a private temp directory nobody ever cleans. Five minutes is the compromise; nothing in the code depends on the exact number.

**The Windows console-window flicker.** The sidecar runs as a windowless GUI child on Windows, and a console subprocess spawned from it without `CREATE_NO_WINDOW` allocates its own console window: it flashes on screen and steals focus. One paste spawns several of these (the file-reference, text, and image probes), and the burst was enough to freeze the GUI. That flicker is also the reason the Tauri build on Windows dropped the subprocess entirely for a direct Win32 read in `standalone/src-tauri/src/clipboard_win.rs`; the non-Windows hosts kept the shell-out in `standalone/sidecar/clipboard-ops.js` because `pbpaste`/`wl-paste`/`xclip` have no equivalent problem.

**PowerShell quoting (dormouse#430).** `shellEscapePath` picked cmd-style quoting from `IS_WINDOWS` alone, so a PowerShell pane got a double-quoted path — and PowerShell's double-quoted strings are expandable. Dropping a file named `$(calc.exe).txt` staged `"$(calc.exe).txt"`, which ran the subexpression the moment the user pressed Enter, which is the whole reason they dropped the file in. Git Bash and WSL panes on Windows had the same mismatch, minus the execution. That is the bug the per-Session `shellKind` dispatch exists to prevent; the rule is restated at the code in `lib/src/lib/shell-escape.ts`.

**Why posix backslash-escapes instead of quoting.** A single-quoted whole path is correct for the shell and wrong for the program: TUIs like `claude` read a backslash-escaped token as a filesystem path and an opaque quoted string as pasted text. macOS Terminal's drag-and-drop produces the backslash form for the same reason, so matching it is what makes a dropped or pasted path behave the way users already expect. Newline/CR is the one case the format cannot express — bash reads `\<newline>` as a line continuation and swallows both characters — so those paths fall back to single quotes.

## 8.7 Drag-to-Paste

**`dragDropEnabled: false` is no longer load-bearing.** The flag was set so HTML5 drag-and-drop kept working inside the webview, back when pane dragging depended on it. Lath's pane dragging is pointer-based and does not, so nothing in the current layout stack needs the flag off — flipping it would hand the drop back to Tauri's native `WindowEvent::DragDrop` handler, which is already written and wired, and re-enable drag-to-paste in the standalone build. It is left alone because that is a behavior change to schedule deliberately, not a side effect of an unrelated edit.

## 8.9 Clipboard Chords Inside Dormouse's Own Text Fields

**Why the standalone build has no native chords at all.** macOS routes `⌘C`/`⌘X`/`⌘V` into a WKWebView through the application's Edit menu; the standalone build replaces the default macOS menu and ships none, so the Edit items — and with them the only native path to those chords — went away. Every other host leaves the webview's own chords working, which is why the JS handler exists for exactly one build.

**Why `readClipboardText` is the gate.** Gating on "the adapter implements `readClipboardText`" is a proxy for "this is the menu-less standalone build", and it over-reaches slightly: it also matches `standalone/src/browser-sidecar-adapter.ts`, whose Chrome webview *does* have working native chords, so there the JS path replaces a working one rather than standing down. Worth knowing when a chord misbehaves only in the browser sidecar — the suspect is the JS handler, not the webview.
