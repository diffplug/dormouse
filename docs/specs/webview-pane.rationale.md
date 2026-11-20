# Pane Webview — Rationale

Evidence behind [webview-pane.md](webview-pane.md), keyed by its headings. Measured 2026-11-19 with tao 0.37.2 and wry 0.57.0: on macOS 27 in a scratch app posting synthesized `NSEvent`s to its own queue; on Windows 11 26300 with WebView2 157 over RDP, input by `SendInput`.

## Host capability

**Why wry directly.** Tauri's `unstable` feature builds a window's own webview as a child too (`WebviewKind::WindowChild` in `tauri-runtime-wry`), and wry answers `performKeyEquivalent:` with NO for every child view. A chord bound to a menu item then reaches the menu before any page: ⌘C raised the page's `copy` event and no `keydown`. The app webview must see that `keydown` first to cancel it (`docs/specs/standalone.md` -> "Application menu"). Building only the pane view as a child leaves the app webview a content view, where every chord reached its page.

**Why macOS 14.** A data store apart from the app's own is `WKWebsiteDataStore(forIdentifier:)`, which that release added.

**Why one command at a time.** WebView2 delivered unawaited invokes out of order: a burst of 20 `place` calls was reordered in 14 of 15 runs; calls 16 ms apart kept their order.

**Why Windows answers `open` first.** A sync command runs on the main thread inside the app webview's IPC callback, and building a view there deadlocked every time: `CreateCoreWebView2Controller` never completed (20 s watchdog), and `run_on_main_thread` from the main thread runs inline. A build posted from a spawned thread took 157–250 ms the first time, about 30 ms after.

## Lifetime

Removing the view from its window and adding it back kept the page: no reload, form state intact.

A first load that fails leaves the view with no page at all, and `open` adopts an existing view without navigating it, so Reload would adopt an empty view.

**Why a Windows view is never dropped.** wry's `Drop` for a child view sends its parent the message that removes the app webview's own subclass; after one drop the app webview no longer followed window resizes or took the keyboard on activation. Closing the controller and destroying its container still ended the profile's browser processes.

## Visibility

Hiding the view kept its page, raised `visibilitychange`, stopped `requestAnimationFrame`, and slowed a 100 ms timer to about one tick a second.

On Windows `SetIsVisible(false)` throttles (no `requestAnimationFrame`, a 100 ms timer at 1 Hz); hiding the container alone throttles nothing.

On Windows `CapturePreview` of a shown view took 70–170 ms; a capture started just before its view hid completed only once the view showed again, 2.3 s later.

## Keyboard and pointer

An app-level `NSEvent` local monitor saw every `keyDown` and `flagsChanged` before either webview, told left ⌘ from right by key code, and removed a key it returned `nil` for from both pages. In the child view's page, plain keys, a chord bound to no menu item, and either ⌘ alone all raised `keydown`.

Hiding a view that held first responder left the window itself holding it, not the app webview.

The monitor saw each `⌘=` `keyDown` twice with one timestamp: WebKit sends a key its page left unhandled through the app again. A synthesized `⌘=` arrived with the keypad's key code, so the zoom chords match the character (measured on macOS 27, 2026-11).

On Windows `AcceleratorKeyPressed` never fired for Shift alone, and no `WM_KEYDOWN` reached the process while a webview held focus. Raw Input under tao's existing registration, flags 0, saw all 70 test keys while either webview held focus and none while another app was foreground; left and right Shift differ by make code. `WM_PARENTNOTIFY` on a view's container fired once per press, any button, focused or not. WebView2's focus events are not one per transition and arrive before `GetFocus` moves, while `GetFocus` with `IsChild`, read after a focus command, matched where keys went every time. Hiding a focused view stranded the keyboard in it, and a press from one pane into another let the first pane's release blur the second for 6 ms.

No mouse report reached tao's mouse Raw Input registration on Windows for injected moves or presses, and no mouse message reaches the process from over a view, so the pointer leaving a shown view is polled.

## Page boundary

**Why a page may frame `about:`, `blob:`, and `data:`.** wry's navigation handler hears every frame and cannot tell the top one, and pages frame those documents routinely; none reaches outside the engine, where `file:` reads the disk and any other scheme starts another app. On Windows wry's handler hears only the top frame, so the frames have a handler of their own; the external-scheme cancel caught `mailto:` and `ms-settings:` from the top frame, a link, and an iframe.

**Why the permission handler is explicit.** wry grants a media-capture request outright when no handler is set.

**Why no network gate.** Neither engine shows a host the address a request resolves to, nor its fetches, sockets, and workers; a gate on top-level navigations alone would promise more than it holds.

**Why no fullscreen leaves a pane.** WebKit's element fullscreen is a window of its own, over every Dormouse prompt, so macOS turns it off. WebView2 granted `requestFullscreen` in a child view but kept it there: the page reported its pane's size, the container did not change, and Esc ended it.

**Why the panel asks a page's dialogs.** wry 0.57's UI delegate implements none of WebKit's three JavaScript panel methods, and without them WebKit dismisses an `alert` and answers a `confirm` false and a `prompt` null, unseen. WebKit raises an Objective-C exception for a panel's completion handler released uncalled. Read from wry's source and Apple's documentation; with the methods in place a page's `confirm` got the user's answer both ways, and a pane killed with one pending raised nothing (macOS 27, 2026-11).

**Why a new window takes a press.** On Windows `window.open` from a timer raised `NewWindowRequested` with `IsUserInitiated` false, and from a press true; on macOS `javaScriptCanOpenWindowsAutomatically` off leaves a scripted one unraised.
