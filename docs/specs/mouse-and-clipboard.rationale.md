# Mouse and Clipboard — Rationale

> Informative companion to [mouse-and-clipboard.md](mouse-and-clipboard.md): the platform quirks, measurements, and provenance behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## 3.1 Initiating a Selection

**How a mouse-up outside the iframe still reaches us.** Capture is taken on mouse-down, and Chromium delivers the captured `pointerup` across the frame boundary even when the button comes up over host chrome. Engines that do not honor cross-frame capture deliver nothing, so a window `mousemove` reporting `buttons === 0` stands in for the missed mouse-up: a pointer still holding the button reports `buttons === 1`, so the heal cannot fire mid-drag, but it does need the pointer to re-enter the frame. Against double-finalizing, the captured-pointerup path defers to a macrotask and stands down if the compatibility mouseup for an *inside* release arrives first.

## 5.1 Detection

**Why trailing punctuation is stripped before the patterns run.** Terminal output puts tokens inside sentences: `Error at src/foo.ts:42.` ends in a period no path pattern matches, so matching first leaves nothing to trim afterward. Stripped first it becomes `src/foo.ts:42`, which the error-location pattern recognizes — the `:line[:col]` digits are not trailing punctuation and survive. Matched bracket pairs are exempt for the mirror case: `https://en.wikipedia.org/wiki/Foo_(bar)` really does end in `)`, and trimming truncates the URL.

## 8.2 Paste Keybindings

**Why paste breaks the clean macOS separation that copy keeps.** On macOS `⌘C` is copy and `Ctrl+C` is SIGINT, and honoring that split costs nothing — a Mac user reaching for copy reaches for `⌘`. Paste is not symmetric: `Ctrl+V` is the universal expectation on every platform, so a macOS build that ignored it would read as broken rather than principled. Intercepting all four combinations everywhere buys that, at the known cost of `0x16` — §8.3's `Ctrl+Q` covers the shells, and nothing covers a program implementing neither.

## 8.6 Paste Content

**Why native text reads outrank `navigator.clipboard`.** On macOS WKWebView, `navigator.clipboard.readText()` pops a `Paste from <App>` confirmation menu at the cursor on *every* invocation, not once per grant; a paste shortcut that then needs a second click on a menu appearing under the mouse defeats its own purpose. The `navigator` call stays as the fallback for hosts that ship no native reader.

**Why the image temp file lives ~5 minutes.** Long enough for whatever command the user launches against the pasted path to have opened it — the path lands at a prompt they still have to finish typing and submit — and short enough that a long session of screenshot pastes does not accumulate one file per paste in a private temp directory nobody ever cleans. Nothing in the code depends on the exact number.

**The Windows console-window flicker.** The sidecar runs as a windowless GUI child, so a console subprocess spawned without `CREATE_NO_WINDOW` allocates its own console window that flashes on screen and steals focus — and one paste spawns several (the file-reference, text, and image probes), a burst enough to freeze the GUI. That same flicker drove the Windows Tauri build off the subprocess entirely and onto the direct Win32 read; `pbpaste`/`wl-paste`/`xclip` have no equivalent problem, so the non-Windows hosts kept the shell-out.

**PowerShell quoting (dormouse#430).** `shellEscapePath` picked cmd-style quoting from `IS_WINDOWS` alone, so a PowerShell pane got a double-quoted path — and PowerShell's double-quoted strings are expandable. A file named `$(calc.exe).txt` staged as `"$(calc.exe).txt"` ran the subexpression the moment the user pressed Enter, the very keystroke the drop was aimed at. Git Bash and WSL panes on Windows had the same mismatch, minus the execution.

**Why posix backslash-escapes instead of quoting.** A single-quoted whole path is correct for the shell and wrong for the program: TUIs like `claude` read a backslash-escaped token as a filesystem path and an opaque quoted string as pasted text. macOS Terminal's drag-and-drop produces the backslash form for the same reason, so matching it is what makes a dropped or pasted path behave the way users already expect.

## 8.7 Drag-to-Paste

**`dragDropEnabled: false` is no longer load-bearing.** The flag was set back when pane dragging depended on HTML5 drag-and-drop working inside the webview; Lath's pane dragging is pointer-based and does not, so nothing in the current layout stack needs it off. Flipping it hands the drop to Tauri's native `WindowEvent::DragDrop` handler — already written and wired — and re-enables drag-to-paste in the standalone build; it stays off only because that is a behavior change to schedule deliberately, not a side effect of an unrelated edit.

## 8.9 Clipboard Chords Inside Dormouse's Own Text Fields

**Why the standalone build has no native chords at all.** macOS routes `⌘C`/`⌘X`/`⌘V` into a WKWebView through the application's Edit menu; the standalone build replaces the default macOS menu and ships none, so the Edit items — and with them the only native path to those chords — went away.

**Why `readClipboardText` is the gate.** It is a proxy for "this is the menu-less standalone build", and it over-reaches to `standalone/src/browser-sidecar-adapter.ts`, whose Chrome webview *does* have working native chords — there the JS path replaces a working one rather than standing down. Worth knowing when a chord misbehaves only in the browser sidecar: the suspect is the JS handler, not the webview.
