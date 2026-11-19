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

/// A `data:image/jpeg;base64,` URL of the view's current rendering. Async:
/// the main thread answers it, so waiting there would never end.
#[tauri::command(async)]
pub fn pane_webview_snapshot(webview: Webview, id: String) -> Result<String, String> {
    imp::snapshot(webview, id)
}

#[cfg(target_os = "macos")]
pub use imp::install;
pub use imp::{close_all, forget_window};

const UNSUPPORTED: &str = "pane webviews need macOS 14 or later";

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

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
    pub fn snapshot(_: Webview, _: String) -> Result<String, String> {
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
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSEvent, NSEventMask, NSEventType, NSImage, NSImageCompressionFactor,
        NSResponder, NSView, NSWindow,
    };
    use objc2_foundation::{
        NSDataBase64EncodingOptions, NSDictionary, NSError, NSNumber, NSOperatingSystemVersion, NSProcessInfo,
    };
    use objc2_web_kit::WKSnapshotConfiguration;
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

    fn web_only(url: &str) -> Result<(), String> {
        is_web(url).then_some(()).ok_or_else(|| format!("not an http(s) URL: {url}"))
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

    type Panes = HashMap<String, Pane>;
    thread_local! {
        static PANES: RefCell<Panes> = RefCell::default();
    }
    /// Whether any pane exists, so the poll leaves the main thread alone otherwise.
    static ANY: AtomicBool = AtomicBool::new(false);

    pub fn supported() -> bool {
        let floor = NSOperatingSystemVersion { majorVersion: 14, minorVersion: 0, patchVersion: 0 };
        NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(floor)
    }

    /// Run `f` on the main thread with the registry; with `report`, then
    /// report what changed rather than waiting for the poll.
    fn on_main<T: Send + 'static>(
        app: &AppHandle, report: bool, f: impl FnOnce(&mut Panes) -> Result<T, String> + Send + 'static,
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
            if report {
                sync(&handle);
            }
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
        rx.recv().map_err(|_| "the main thread dropped the call".to_string())?
    }

    /// A command from `webview`, with the label of the window it came from.
    fn command<T: Send + 'static>(
        webview: Webview, report: bool, f: impl FnOnce(&mut Panes, &Webview, &str) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let app = webview.app_handle().clone();
        on_main(&app, report, move |panes| {
            let owner = webview.window().label().to_string();
            f(panes, &webview, &owner)
        })
    }

    /// A command on `id`'s view, which does nothing unless `webview`'s window owns it.
    fn on_view(
        webview: Webview, id: String, report: bool, f: impl FnOnce(&WebView, &Webview) -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        command(webview, report, move |panes, webview, owner| match panes.get(&id).filter(|pane| pane.owner == owner) {
            Some(pane) => f(&pane.view, webview),
            None => Ok(()),
        })
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

    fn build(webview: &Webview, id: &str, url: &str) -> Result<WebView, String> {
        let window = ns_window(webview)?;
        let content = window.contentView().ok_or("the window has no content view")?;
        let parent = ContentView(NonNull::from(&*content).cast());
        let (app, id) = (webview.app_handle().clone(), id.to_string());
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
            return Err(UNSUPPORTED.into());
        }
        command(webview, true, move |panes, webview, owner| {
            if let Some(pane) = panes.get_mut(&id) {
                if pane.owner != owner {
                    let window = ns_window(webview)?;
                    pane.view.set_visible(false).map_err(|e| e.to_string())?;
                    pane.view.reparent(Retained::as_ptr(&window).cast_mut()).map_err(|e| e.to_string())?;
                    pane.owner = owner.to_string();
                }
                pane.page = page_state(&pane.view.webview());
                return Ok(pane.page.clone());
            }
            web_only(&url)?;
            let view = build(webview, &id, &url)?;
            let page = page_state(&view.webview());
            panes.insert(id, Pane { view, owner: owner.to_string(), page: page.clone(), focused: false });
            Ok(page)
        })
    }

    /// Showing a view moves neither page nor focus, so only a hide reports at
    /// once; the panel places a moving view every frame.
    pub fn place(webview: Webview, id: String, rect: Option<Rect>) -> Result<(), String> {
        on_view(webview, id, rect.is_none(), move |view, webview| match rect {
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
                    focus_app(webview);
                }
                view.set_visible(false).map_err(|e| e.to_string())
            }
        })
    }

    pub fn navigate(webview: Webview, id: String, url: String) -> Result<(), String> {
        web_only(&url)?;
        on_view(webview, id, true, move |view, _| view.load_url(&url).map_err(|e| e.to_string()))
    }

    pub fn history(webview: Webview, id: String, dir: String) -> Result<(), String> {
        on_view(webview, id, true, move |view, _| {
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
        match id {
            // A hidden view never holds focus.
            Some(id) => on_view(webview, id, true, |view, _| {
                if view.webview().isHidden() { Ok(()) } else { view.focus().map_err(|e| e.to_string()) }
            }),
            None => command(webview, true, |_, webview, _| Ok(focus_app(webview))),
        }
    }

    pub fn close(webview: Webview, id: String) -> Result<(), String> {
        command(webview, true, move |panes, webview, owner| {
            Ok(remove(panes, |pane_id, pane| pane_id == id && pane.owner == owner, Some(webview)))
        })
    }

    pub fn reset(webview: Webview) -> Result<(), String> {
        command(webview, true, |panes, webview, owner| Ok(remove(panes, |_, pane| pane.owner == owner, Some(webview))))
    }

    /// A snapshot's longest side in pixels: a Retina pane's full size would be
    /// megabytes of base64 for a stand-in.
    const SNAPSHOT_MAX_PX: f64 = 1600.0;
    const SNAPSHOT_QUALITY: f64 = 0.7;
    const SNAPSHOT_WAIT: Duration = Duration::from_secs(2);

    /// The snapshot width in points that keeps a `width` by `height` point view,
    /// at `scale` pixels per point, within `SNAPSHOT_MAX_PX`.
    fn snapshot_width(width: f64, height: f64, scale: f64) -> f64 {
        let longest = width.max(height) * scale;
        if longest <= SNAPSHOT_MAX_PX { width } else { width * SNAPSHOT_MAX_PX / longest }
    }

    pub fn snapshot(webview: Webview, id: String) -> Result<String, String> {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        command(webview, false, move |panes, _, owner| {
            let pane = panes.get(&id).filter(|pane| pane.owner == owner).ok_or("no such pane webview")?;
            let view = pane.view.webview();
            let size = view.bounds().size;
            let scale = view.window().map_or(1.0, |window| window.backingScaleFactor());
            // SAFETY: this runs on the main thread.
            let config = unsafe { WKSnapshotConfiguration::new(MainThreadMarker::new_unchecked()) };
            let width = NSNumber::new_f64(snapshot_width(size.width, size.height, scale));
            // The handler runs later, on the main thread, so encoding never
            // holds the registry.
            let handler = RcBlock::new(move |image: *mut NSImage, _: *mut NSError| {
                // SAFETY: WebKit passes a live image or null.
                let _ = tx.send(unsafe { image.as_ref() }.and_then(jpeg_data_url));
            });
            // SAFETY: a property write and a call on a live WKWebView, on the main thread.
            unsafe {
                config.setSnapshotWidth(Some(&width));
                view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
            }
            Ok(())
        })?;
        rx.recv_timeout(SNAPSHOT_WAIT).ok().flatten().ok_or_else(|| "no snapshot".to_string())
    }

    fn jpeg_data_url(image: &NSImage) -> Option<String> {
        let bitmap = NSBitmapImageRep::imageRepWithData(&*image.TIFFRepresentation()?)?;
        let quality = NSNumber::new_f64(SNAPSHOT_QUALITY);
        // SAFETY: a framework constant, and the compression factor it keys is a number.
        let jpeg = unsafe {
            let properties = NSDictionary::from_slices(&[NSImageCompressionFactor], &[quality.as_ref() as &AnyObject]);
            bitmap.representationUsingType_properties(NSBitmapImageFileType::JPEG, &properties)?
        };
        let base64 = jpeg.base64EncodedStringWithOptions(NSDataBase64EncodingOptions::empty());
        Some(format!("data:image/jpeg;base64,{base64}"))
    }

    /// The window is gone, so nothing is left to focus.
    pub fn forget_window(app: &AppHandle, label: &str) {
        let label = label.to_string();
        let _ = on_main(app, true, move |panes| Ok(remove(panes, |_, pane| pane.owner == label, None)));
    }

    pub fn close_all(app: &AppHandle) {
        let _ = on_main(app, false, |panes| Ok(panes.clear()));
    }

    fn remove(panes: &mut Panes, doomed: impl Fn(&str, &Pane) -> bool, refocus: Option<&Webview>) {
        panes.retain(|id, pane| {
            if !doomed(id, pane) {
                return true;
            }
            if let Some(webview) = refocus.filter(|_| holds_focus(&pane.view.webview())) {
                focus_app(webview);
            }
            false
        });
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
        let (left, over) = (Cell::new(None), Cell::new(None));
        let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit hands the monitor a live event, on the main thread.
            let (ev, mtm) = unsafe { (event.as_ref(), MainThreadMarker::new_unchecked()) };
            on_event(&app, ev, mtm, &left, &over);
            event.as_ptr()
        });
        // tao's windows accept mouse-moved events, so the monitor sees every move.
        let mask = NSEventMask::KeyDown | NSEventMask::FlagsChanged | NSEventMask::LeftMouseDown | NSEventMask::MouseMoved;
        // SAFETY: the block returns the event it was given.
        let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };
        // Never removed: it lives as long as the app.
        std::mem::forget(monitor);
    }

    /// `over` is the id and owner of the shown view the pointer was last over.
    fn on_event(
        app: &AppHandle, event: &NSEvent, mtm: MainThreadMarker, left: &Cell<Option<(Key, f64)>>,
        over: &Cell<Option<(String, String)>>,
    ) {
        let Some(window) = event.window(mtm) else { return };
        // The id and owner of this window's view that `test` picks.
        let find = |test: &dyn Fn(&WryWebView) -> bool| {
            PANES.with(|panes| {
                panes.try_borrow().ok()?.iter().find_map(|(id, pane)| {
                    let view = pane.view.webview();
                    (view.window().is_some_and(|w| std::ptr::eq(&*w, &*window)) && test(&view))
                        .then(|| (id.clone(), pane.owner.clone()))
                })
            })
        };
        let kind = event.r#type();
        if kind == NSEventType::LeftMouseDown || kind == NSEventType::MouseMoved {
            let point = event.locationInWindow();
            let hit = find(&|view| !view.isHidden() && view.mouse_inRect(view.convertPoint_fromView(point, None), view.bounds()));
            if kind == NSEventType::MouseMoved {
                // The app webview hears no move while a pane webview is under the pointer.
                if let Some((id, owner)) = over.replace(hit.clone()).filter(|was| Some(was) != hit.as_ref()) {
                    emit(app, &owner, &id, "pointerleave", json!({}));
                }
            } else if let Some((id, owner)) = hit {
                emit(app, &owner, &id, "pointerdown", json!({}));
            }
            return;
        }
        let responder = window.firstResponder().and_then(|responder| responder.downcast::<NSView>().ok());
        let Some((id, owner)) = responder.and_then(|responder| find(&|view| responder.isDescendantOf(view))) else {
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
        fn a_snapshot_is_capped_on_its_longest_side() {
            assert_eq!(snapshot_width(400.0, 300.0, 2.0), 400.0);
            assert_eq!(snapshot_width(800.0, 600.0, 2.0), 800.0);
            assert_eq!(snapshot_width(1600.0, 900.0, 2.0), 800.0);
            // A tall view is capped by its height.
            assert_eq!(snapshot_width(500.0, 1600.0, 1.0), 500.0);
            assert_eq!(snapshot_width(500.0, 3200.0, 1.0), 250.0);
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
