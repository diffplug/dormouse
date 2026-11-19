//! docs/specs/webview-pane.md: the native child webviews that render a
//! `webview` browser Surface, one per Surface id, built with wry directly on
//! the app window. Every view, and the registry, live on the main thread.
//! A command from a window that does not own the view does nothing: a panel
//! unmounting in the source of a move must not hide the view its target
//! adopted.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Webview};

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct PageState {
    url: String,
    title: String,
    can_go_back: bool,
    can_go_forward: bool,
    loading: bool,
}

/// Logical pixels from the top-left of the window's content view.
#[derive(Deserialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[tauri::command]
pub fn pane_webview_supported() -> bool {
    imp::supported()
}

#[tauri::command]
pub fn pane_webview_open(webview: Webview, id: String, url: String) -> Result<PageState, String> {
    imp::open(webview, id, url)
}

#[tauri::command]
pub fn pane_webview_place(webview: Webview, id: String, rect: Option<Rect>) -> Result<(), String> {
    imp::place(webview, id, rect)
}

#[tauri::command]
pub fn pane_webview_navigate(webview: Webview, id: String, url: String) -> Result<(), String> {
    imp::navigate(webview, id, url)
}

#[tauri::command]
pub fn pane_webview_history(webview: Webview, id: String, dir: String) -> Result<(), String> {
    imp::history(webview, id, dir)
}

#[tauri::command]
pub fn pane_webview_focus(webview: Webview, id: Option<String>) -> Result<(), String> {
    imp::focus(webview, id)
}

#[tauri::command]
pub fn pane_webview_close(webview: Webview, id: String) -> Result<(), String> {
    imp::close(webview, id)
}

#[tauri::command]
pub fn pane_webview_reset(webview: Webview) -> Result<(), String> {
    imp::reset(webview)
}

#[cfg(target_os = "macos")]
pub use imp::install;
pub use imp::{close_all, forget_window};

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    const UNSUPPORTED: &str = "pane webviews need macOS 14 or later";

    pub fn supported() -> bool {
        false
    }
    pub fn open(_: Webview, _: String, _: String) -> Result<PageState, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn place(_: Webview, _: String, _: Option<Rect>) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn navigate(_: Webview, _: String, _: String) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn history(_: Webview, _: String, _: String) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn focus(_: Webview, _: Option<String>) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn close(_: Webview, _: String) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn reset(_: Webview) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn forget_window(_: &AppHandle, _: &str) {}
    pub fn close_all(_: &AppHandle) {}
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventType, NSResponder, NSView, NSWindow};
    use objc2_foundation::{NSOperatingSystemVersion, NSProcessInfo};
    use serde_json::{json, Value};
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tauri::{Emitter, Manager};
    use wry::dpi::{LogicalPosition, LogicalSize};
    use wry::raw_window_handle::{
        AppKitWindowHandle, HandleError, HasWindowHandle, RawWindowHandle, WindowHandle,
    };
    use wry::{
        NewWindowResponse, PermissionResponse, WebView, WebViewBuilder, WebViewBuilderExtDarwin,
        WebViewExtMacOS, WryWebView,
    };

    const EVENT: &str = "dormouse://pane-webview";
    /// The one profile every pane webview shares; never the app webview's.
    const STORE: [u8; 16] = [
        0x6b, 0x1e, 0x2f, 0x4a, 0x93, 0xd0, 0x4c, 0x51, 0x8e, 0x27, 0x0b, 0xa6, 0x5d, 0x71, 0xc3, 0x9f,
    ];
    const POLL: Duration = Duration::from_millis(250);

    fn scheme(url: &str) -> Option<String> {
        url.split_once(':').map(|(scheme, _)| scheme.to_ascii_lowercase())
    }

    fn is_web(url: &str) -> bool {
        matches!(scheme(url).as_deref(), Some("http" | "https"))
    }

    /// The handler hears every frame's navigation, and pages frame their own
    /// `about:`, `blob:` and `data:` documents. Anything else would leave the
    /// engine: a file, or a scheme another app answers.
    fn may_load(url: &str) -> bool {
        matches!(scheme(url).as_deref(), Some("http" | "https" | "about" | "blob" | "data"))
    }

    struct Pane {
        view: WebView,
        owner: String,
        page: PageState,
        focused: bool,
    }

    thread_local! {
        static PANES: RefCell<HashMap<String, Pane>> = RefCell::default();
    }
    /// Whether any pane exists, so the poll leaves the main thread alone otherwise.
    static ANY: AtomicBool = AtomicBool::new(false);

    pub fn supported() -> bool {
        let floor = NSOperatingSystemVersion { majorVersion: 14, minorVersion: 0, patchVersion: 0 };
        NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(floor)
    }

    /// Run `f` on the main thread with the registry, then report what changed.
    fn on_main<T: Send + 'static>(
        app: &AppHandle,
        f: impl FnOnce(&mut HashMap<String, Pane>) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let result = PANES.with(|panes| {
                let mut panes = panes.try_borrow_mut().map_err(|_| "pane webviews are busy".to_string())?;
                let result = f(&mut panes);
                ANY.store(!panes.is_empty(), Ordering::Relaxed);
                result
            });
            sync(&handle);
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
        rx.recv().map_err(|_| "the main thread dropped the call".to_string())?
    }

    fn label(webview: &Webview) -> String {
        webview.window().label().to_string()
    }

    fn owned<'a>(panes: &'a HashMap<String, Pane>, id: &str, owner: &str) -> Option<&'a WebView> {
        panes.get(id).filter(|pane| pane.owner == owner).map(|pane| &pane.view)
    }

    /// The window handle tao gives Tauri names its own view, which the app
    /// webview replaced as content view; wry needs a view inside the window.
    struct ContentView(NonNull<c_void>);

    impl HasWindowHandle for ContentView {
        fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
            let raw = RawWindowHandle::AppKit(AppKitWindowHandle::new(self.0));
            // SAFETY: the content view outlives this builder call.
            Ok(unsafe { WindowHandle::borrow_raw(raw) })
        }
    }

    fn ns_window(webview: &Webview) -> Result<Retained<NSWindow>, String> {
        let ptr = webview.window().ns_window().map_err(|e| e.to_string())?;
        // SAFETY: Tauri hands out its live NSWindow, and this runs on the main thread.
        unsafe { Retained::retain(ptr.cast::<NSWindow>()) }.ok_or_else(|| "no window".to_string())
    }

    fn build(app: &AppHandle, webview: &Webview, id: &str, url: &str) -> Result<WebView, String> {
        let window = ns_window(webview)?;
        let content = window.contentView().ok_or("the window has no content view")?;
        let parent = ContentView(NonNull::from(&*content).cast());
        let (app, id) = (app.clone(), id.to_string());
        WebViewBuilder::new()
            .with_url(url)
            .with_visible(false)
            .with_navigation_handler(|url| may_load(&url))
            .with_new_window_req_handler(move |url, _| {
                if is_web(&url) {
                    let owner = PANES.with(|panes| {
                        panes.try_borrow().ok()?.get(&id).map(|pane| pane.owner.clone())
                    });
                    if let Some(owner) = owner {
                        emit(&app, &owner, &id, "open-window", json!({ "url": url }));
                    }
                }
                NewWindowResponse::Deny
            })
            .with_download_started_handler(|_, _| false)
            // wry grants media capture when no handler is set.
            .with_permission_handler(|_| PermissionResponse::Deny)
            .with_data_store_identifier(STORE)
            .build_as_child(&parent)
            .map_err(|e| e.to_string())
    }

    pub fn open(webview: Webview, id: String, url: String) -> Result<PageState, String> {
        if !supported() {
            return Err("pane webviews need macOS 14 or later".into());
        }
        let app = webview.app_handle().clone();
        on_main(&app.clone(), move |panes| {
            let owner = label(&webview);
            if let Some(pane) = panes.get_mut(&id) {
                if pane.owner != owner {
                    let window = ns_window(&webview)?;
                    pane.view.set_visible(false).map_err(|e| e.to_string())?;
                    pane.view.reparent(Retained::as_ptr(&window).cast_mut()).map_err(|e| e.to_string())?;
                    pane.owner = owner;
                }
                pane.page = page_state(&pane.view.webview());
                return Ok(pane.page.clone());
            }
            if !is_web(&url) {
                return Err(format!("not an http(s) URL: {url}"));
            }
            let view = build(&app, &webview, &id, &url)?;
            let page = page_state(&view.webview());
            panes.insert(id, Pane { view, owner, page: page.clone(), focused: false });
            Ok(page)
        })
    }

    pub fn place(webview: Webview, id: String, rect: Option<Rect>) -> Result<(), String> {
        on_main(&webview.app_handle().clone(), move |panes| {
            let Some(view) = owned(panes, &id, &label(&webview)) else { return Ok(()) };
            match rect {
                Some(rect) => {
                    let bounds = wry::Rect {
                        position: LogicalPosition::new(rect.x, rect.y).into(),
                        size: LogicalSize::new(rect.width, rect.height).into(),
                    };
                    view.set_bounds(bounds).map_err(|e| e.to_string())?;
                    view.set_visible(true).map_err(|e| e.to_string())
                }
                None => {
                    // AppKit would leave the window itself holding the keyboard.
                    if holds_focus(&view.webview()) {
                        focus_app(&webview);
                    }
                    view.set_visible(false).map_err(|e| e.to_string())
                }
            }
        })
    }

    pub fn navigate(webview: Webview, id: String, url: String) -> Result<(), String> {
        if !is_web(&url) {
            return Err(format!("not an http(s) URL: {url}"));
        }
        on_main(&webview.app_handle().clone(), move |panes| match owned(panes, &id, &label(&webview)) {
            Some(view) => view.load_url(&url).map_err(|e| e.to_string()),
            None => Ok(()),
        })
    }

    pub fn history(webview: Webview, id: String, dir: String) -> Result<(), String> {
        on_main(&webview.app_handle().clone(), move |panes| {
            let Some(view) = owned(panes, &id, &label(&webview)) else { return Ok(()) };
            match dir.as_str() {
                "back" => view.go_back(),
                "forward" => view.go_forward(),
                "reload" => view.reload(),
                _ => return Err(format!("unknown history direction: {dir}")),
            }
            .map_err(|e| e.to_string())
        })
    }

    pub fn focus(webview: Webview, id: Option<String>) -> Result<(), String> {
        on_main(&webview.app_handle().clone(), move |panes| {
            match id {
                // A hidden view never holds focus.
                Some(id) => match owned(panes, &id, &label(&webview)) {
                    Some(view) if !view.webview().isHidden() => view.focus().map_err(|e| e.to_string())?,
                    _ => {}
                },
                None => focus_app(&webview),
            }
            Ok(())
        })
    }

    pub fn close(webview: Webview, id: String) -> Result<(), String> {
        on_main(&webview.app_handle().clone(), move |panes| {
            let owner = label(&webview);
            remove(panes, |pane_id, pane| pane_id == id && pane.owner == owner, Some(&webview));
            Ok(())
        })
    }

    pub fn reset(webview: Webview) -> Result<(), String> {
        on_main(&webview.app_handle().clone(), move |panes| {
            let owner = label(&webview);
            remove(panes, |_, pane| pane.owner == owner, Some(&webview));
            Ok(())
        })
    }

    /// The window is gone, so nothing is left to focus.
    pub fn forget_window(app: &AppHandle, label: &str) {
        let label = label.to_string();
        let _ = on_main(app, move |panes| {
            remove(panes, |_, pane| pane.owner == label, None);
            Ok(())
        });
    }

    pub fn close_all(app: &AppHandle) {
        let _ = on_main(app, |panes| {
            panes.clear();
            Ok(())
        });
    }

    fn remove(
        panes: &mut HashMap<String, Pane>,
        doomed: impl Fn(&str, &Pane) -> bool,
        refocus: Option<&Webview>,
    ) {
        let ids: Vec<String> = panes.iter().filter(|(id, pane)| doomed(id, pane)).map(|(id, _)| id.clone()).collect();
        for id in ids {
            let Some(pane) = panes.remove(&id) else { continue };
            if let Some(webview) = refocus.filter(|_| holds_focus(&pane.view.webview())) {
                focus_app(webview);
            }
        }
    }

    fn focus_app(webview: &Webview) {
        let _ = webview.with_webview(|platform| {
            // SAFETY: both are the live app window and its WKWebView, on the main thread.
            let window = unsafe { &*platform.ns_window().cast::<NSWindow>() };
            let view = unsafe { &*platform.inner().cast::<NSResponder>() };
            window.makeFirstResponder(Some(view));
        });
    }

    /// A window keeps its first responder while another app has the keyboard.
    fn holds_focus(view: &WryWebView) -> bool {
        view.window()
            .filter(|window| window.isKeyWindow())
            .and_then(|window| window.firstResponder())
            .and_then(|responder| responder.downcast::<NSView>().ok())
            .is_some_and(|responder| responder.isDescendantOf(view))
    }

    fn page_state(view: &WryWebView) -> PageState {
        // SAFETY: plain property reads on a live WKWebView, on the main thread.
        unsafe {
            PageState {
                url: view.URL().and_then(|url| url.absoluteString()).map(|url| url.to_string()).unwrap_or_default(),
                title: view.title().map(|title| title.to_string()).unwrap_or_default(),
                can_go_back: view.canGoBack(),
                can_go_forward: view.canGoForward(),
                loading: view.isLoading(),
            }
        }
    }

    fn emit(app: &AppHandle, owner: &str, id: &str, kind: &str, mut payload: Value) {
        payload["id"] = id.into();
        payload["kind"] = kind.into();
        let _ = app.emit_to(owner, EVENT, payload);
    }

    /// Report every page and focus change since the last call.
    fn sync(app: &AppHandle) {
        let mut events = Vec::new();
        PANES.with(|panes| {
            let Ok(mut panes) = panes.try_borrow_mut() else { return };
            for (id, pane) in panes.iter_mut() {
                let view = pane.view.webview();
                let page = page_state(&view);
                if page != pane.page {
                    let payload = serde_json::to_value(&page).unwrap_or_default();
                    events.push((pane.owner.clone(), id.clone(), "page", payload));
                    pane.page = page;
                }
                let focused = holds_focus(&view);
                if focused != pane.focused {
                    events.push((pane.owner.clone(), id.clone(), "focus", json!({ "focused": focused })));
                    pane.focused = focused;
                }
            }
        });
        for (owner, id, kind, payload) in events {
            emit(app, &owner, &id, kind, payload);
        }
    }

    /// From `RunEvent::Ready`: the change poll, and the one event monitor that
    /// sees a pane webview's keys and presses before the page does.
    pub fn install(app: &AppHandle) {
        if !supported() {
            return;
        }
        let poll = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(POLL);
            if ANY.load(Ordering::Relaxed) {
                let app = poll.clone();
                let _ = poll.run_on_main_thread(move || sync(&app));
            }
        });

        let app = app.clone();
        let left = Cell::new(None);
        let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit hands the monitor a live event, on the main thread.
            let (ev, mtm) = unsafe { (event.as_ref(), MainThreadMarker::new_unchecked()) };
            on_event(&app, ev, mtm, &left);
            event.as_ptr()
        });
        let mask = NSEventMask::KeyDown | NSEventMask::FlagsChanged | NSEventMask::LeftMouseDown;
        // SAFETY: the block returns the event it was given.
        let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };
        // Never removed: it lives as long as the app.
        std::mem::forget(monitor);
    }

    fn on_event(app: &AppHandle, event: &NSEvent, mtm: MainThreadMarker, left: &Cell<Option<(Key, f64)>>) {
        let Some(window) = event.window(mtm) else { return };
        let kind = event.r#type();
        let hit = PANES.with(|panes| {
            let panes = panes.try_borrow().ok()?;
            let in_window = |view: &WryWebView| view.window().is_some_and(|w| std::ptr::eq(&*w, &*window));
            if kind == NSEventType::LeftMouseDown {
                let point = event.locationInWindow();
                panes.iter().find_map(|(id, pane)| {
                    let view = pane.view.webview();
                    let local = view.convertPoint_fromView(point, None);
                    (in_window(&view) && !view.isHidden() && view.mouse_inRect(local, view.bounds()))
                        .then(|| (id.clone(), pane.owner.clone()))
                })
            } else {
                let responder = window.firstResponder()?.downcast::<NSView>().ok()?;
                panes.iter().find_map(|(id, pane)| {
                    let view = pane.view.webview();
                    (in_window(&view) && responder.isDescendantOf(&view)).then(|| (id.clone(), pane.owner.clone()))
                })
            }
        });
        if kind == NSEventType::LeftMouseDown {
            if let Some((id, owner)) = hit {
                emit(app, &owner, &id, "pointerdown", json!({}));
            }
            return;
        }
        let Some((id, owner)) = hit else {
            left.set(None);
            return;
        };
        let flags = event.modifierFlags().bits() as u64;
        let Some(key) = pressed(kind == NSEventType::FlagsChanged, event.keyCode(), flags) else { return };
        let mut state = left.take();
        if dual_tap(&mut state, key, event.timestamp() * 1000.0) {
            emit(app, &owner, &id, "leader", json!({}));
        }
        left.set(state);
    }

    #[derive(Clone, Copy, Debug, PartialEq)]
    enum Key {
        LeftMeta,
        RightMeta,
        LeftShift,
        RightShift,
        Other,
    }

    /// What a key event presses, or `None` for a modifier's release, which
    /// raises no `keydown`. The masks are IOKit's device-dependent bits, set
    /// while that one key is down, so releasing one Shift with the other held
    /// is still a release.
    fn pressed(flags_changed: bool, key_code: u16, flags: u64) -> Option<Key> {
        if !flags_changed {
            return Some(Key::Other);
        }
        let (key, mask) = match key_code {
            55 => (Key::LeftMeta, 0x8),
            54 => (Key::RightMeta, 0x10),
            56 => (Key::LeftShift, 0x2),
            60 => (Key::RightShift, 0x4),
            59 => (Key::Other, 0x1),
            62 => (Key::Other, 0x2000),
            58 => (Key::Other, 0x20),
            61 => (Key::Other, 0x40),
            _ => return Some(Key::Other),
        };
        (flags & mask != 0).then_some(key)
    }

    /// `dualTap` in lib/src/lib/dual-tap.ts, which this must match: true when
    /// `key` completes left-then-right Meta, or Shift, under 500 ms apart.
    fn dual_tap(left: &mut Option<(Key, f64)>, key: Key, now_ms: f64) -> bool {
        let previous = left.take();
        let pair = match key {
            Key::LeftMeta | Key::LeftShift => {
                *left = Some((key, now_ms));
                return false;
            }
            Key::RightMeta => Key::LeftMeta,
            Key::RightShift => Key::LeftShift,
            Key::Other => return false,
        };
        previous.is_some_and(|(key, time)| key == pair && now_ms - time < 500.0)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use Key::*;

        /// The cases of lib/src/lib/dual-tap.test.ts: each press with its ms
        /// since the previous one.
        fn leaders(presses: &[(Key, f64)]) -> usize {
            let (mut left, mut now) = (None, 1000.0);
            presses
                .iter()
                .filter(|(key, ms)| {
                    now += ms;
                    dual_tap(&mut left, *key, now)
                })
                .count()
        }

        #[test]
        fn dual_tap_matches_the_webview_gesture() {
            let cases: &[(&str, &[(Key, f64)], usize)] = &[
                ("left-then-right Meta", &[(LeftMeta, 0.0), (RightMeta, 200.0)], 1),
                ("left-then-right Shift", &[(LeftShift, 0.0), (RightShift, 100.0)], 1),
                ("the right press at 500ms (exclusive)", &[(LeftMeta, 0.0), (RightMeta, 500.0)], 0),
                ("right-then-left", &[(RightMeta, 0.0), (LeftMeta, 100.0)], 0),
                ("left Meta then right Shift", &[(LeftMeta, 0.0), (RightShift, 100.0)], 0),
                ("the other modifier between the taps", &[(LeftShift, 0.0), (LeftMeta, 50.0), (RightShift, 50.0)], 0),
                ("another key between the taps", &[(LeftShift, 0.0), (Other, 50.0), (Other, 50.0), (RightShift, 50.0)], 0),
                ("a third right press after a completed gesture", &[(LeftMeta, 0.0), (RightMeta, 100.0), (RightMeta, 100.0)], 1),
            ];
            for (name, presses, want) in cases {
                assert_eq!(leaders(presses), *want, "{name}");
            }
        }

        #[test]
        fn a_page_loads_only_what_stays_in_the_engine() {
            for url in ["https://a.test/", "HTTP://a.test/", "about:srcdoc", "blob:https://a.test/1", "data:text/html,x"] {
                assert!(may_load(url), "{url}");
            }
            for url in ["file:///etc/passwd", "mailto:a@b.test", "zoommtg://x", "javascript:1", "no-scheme"] {
                assert!(!may_load(url), "{url}");
            }
            assert!(!is_web("about:blank") && !is_web("data:text/html,x"));
        }

        #[test]
        fn only_presses_count() {
            assert_eq!(pressed(true, 55, 0x8), Some(LeftMeta));
            assert_eq!(pressed(true, 54, 0x10), Some(RightMeta));
            // Releasing left Shift while right Shift is held.
            assert_eq!(pressed(true, 56, 0x4), None);
            assert_eq!(pressed(true, 59, 0), None);
            assert_eq!(pressed(true, 59, 0x1), Some(Other));
            assert_eq!(pressed(false, 0, 0), Some(Other));
        }
    }
}
