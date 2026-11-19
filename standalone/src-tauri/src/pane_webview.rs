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
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
pub struct PageState {
    url: String,
    title: String,
    can_go_back: bool,
    can_go_forward: bool,
    loading: bool,
}

/// Logical pixels from the top-left of the window's content view.
#[derive(Deserialize)]
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
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

/// With no `id`, the app webview takes the keyboard back; `from` names the
/// pane giving it up, which must still hold it for anything to move.
#[tauri::command]
pub fn pane_webview_focus(webview: Webview, id: Option<String>, from: Option<String>) -> Result<(), String> {
    imp::focus(webview, id, from)
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

#[cfg(not(windows))]
const UNSUPPORTED: &str = "pane webviews need macOS 14 or later";

#[cfg(not(any(target_os = "macos", windows)))]
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
    pub fn focus(_: Webview, _: Option<String>, _: Option<String>) -> Result<(), String> {
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
        let view = WebViewBuilder::new()
            .with_url(url)
            .with_visible(false)
            // wry turns devtools on in a debug build.
            .with_devtools(false)
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
            .map_err(|e| e.to_string())?;
        // SAFETY: plain setters on the live view's preferences, on the main thread.
        unsafe {
            let preferences = view.webview().configuration().preferences();
            // A page's fullscreen is a window of its own, over every Dormouse
            // prompt and outside the bounds this file gives the view.
            preferences.setElementFullscreenEnabled(false);
            // A new window then takes a press, which a hidden or minimized view
            // cannot get: wry's handler unwraps the window's screen.
            preferences.setJavaScriptCanOpenWindowsAutomatically(false);
        }
        Ok(view)
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
                if is_first_responder(&view.webview()) {
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

    pub fn focus(webview: Webview, id: Option<String>, from: Option<String>) -> Result<(), String> {
        match (id, from) {
            // A hidden view never holds focus.
            (Some(id), _) => on_view(webview, id, true, |view, _| {
                if view.webview().isHidden() { Ok(()) } else { view.focus().map_err(|e| e.to_string()) }
            }),
            // Its successor may hold the keyboard already, and must keep it.
            (None, Some(from)) => on_view(webview, from, true, |view, webview| {
                if is_first_responder(&view.webview()) {
                    focus_app(webview);
                }
                Ok(())
            }),
            (None, None) => command(webview, true, |_, webview, _| Ok(focus_app(webview))),
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
            if let Some(webview) = refocus.filter(|_| is_first_responder(&pane.view.webview())) {
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

    /// Whether the view is its window's first responder, which a window keeps
    /// while another app has the keyboard.
    fn is_first_responder(view: &WryWebView) -> bool {
        view.window()
            .and_then(|window| window.firstResponder())
            .and_then(|responder| responder.downcast::<NSView>().ok())
            .is_some_and(|responder| responder.isDescendantOf(view))
    }

    /// Whether keys reach the view now.
    fn holds_focus(view: &WryWebView) -> bool {
        is_first_responder(view) && view.window().is_some_and(|window| window.isKeyWindow())
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

/// WebView2 children of the app window. A sync command runs on the main
/// thread inside the app webview's IPC callback, where a new controller never
/// completes, so `open` registers a pending pane and builds it a turn later.
/// Every wry, WebView2, and Win32 call can pump or dispatch messages and so
/// re-enter this module (a command, a page event, a sent window message): no
/// `PANES` borrow is ever held across one.
#[cfg(windows)]
mod imp {
    use super::*;
    use serde_json::{json, Value};
    use std::cell::{Cell, OnceCell, RefCell};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::num::NonZeroIsize;
    use std::path::{Path, PathBuf};
    use std::rc::Rc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::OnceLock;
    use std::time::Instant;
    use tauri::{Emitter, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Settings8, ICoreWebView2_18, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
    };
    use webview2_com::{
        take_pwstr, DocumentTitleChangedEventHandler, FocusChangedEventHandler, HistoryChangedEventHandler,
        LaunchingExternalUriSchemeEventHandler, NavigationCompletedEventHandler, NavigationStartingEventHandler,
        SourceChangedEventHandler,
    };
    use windows::core::{Interface, BOOL, PWSTR};
    use windows::Win32::Foundation::{E_FAIL, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::GetFocus;
    use windows::Win32::UI::Input::{
        GetRawInputData, GetRegisteredRawInputDevices, RegisterRawInputDevices, HRAWINPUT, RAWINPUT,
        RAWINPUTDEVICE, RAWINPUTDEVICE_FLAGS, RAWINPUTHEADER, RID_INPUT, RIM_TYPEKEYBOARD,
    };
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyWindow, GetAncestor, GetForegroundWindow, IsChild, IsWindow, GA_ROOT, WA_INACTIVE, WM_ACTIVATE,
        WM_INPUT, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_NCDESTROY, WM_PARENTNOTIFY, WM_POINTERDOWN, WM_RBUTTONDOWN,
        WM_SETFOCUS, WM_XBUTTONDOWN,
    };
    use wry::dpi::{LogicalPosition, LogicalSize};
    use wry::raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle};
    use wry::{
        NewWindowResponse, PermissionResponse, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows,
        WebViewExtWindows,
    };

    const EVENT: &str = "dormouse://pane-webview";
    const BUSY: &str = "pane webviews are busy";
    /// The navigation in flight when the build returns, which started before
    /// any handler here could hear it: any completion ends it.
    const FIRST_LOAD: u64 = u64::MAX;
    const PRESS_SUBCLASS: usize = 0x646d_7001;
    const WINDOW_SUBCLASS: usize = 0x646d_7002;
    const KEYS_SUBCLASS: usize = 0x646d_7003;
    /// `RAWKEYBOARD.Flags` bits and the overrun code (winuser.h, ntddkbd.h).
    const RI_KEY_BREAK: u16 = 0x1;
    const RI_KEY_E0: u16 = 0x2;
    const KEYBOARD_OVERRUN_MAKE_CODE: u16 = 0xFF;

    fn scheme(url: &str) -> Option<String> {
        url.split_once(':').map(|(scheme, _)| scheme.to_ascii_lowercase())
    }

    fn is_web(url: &str) -> bool {
        matches!(scheme(url).as_deref(), Some("http" | "https"))
    }

    /// Pages frame their own `about:`, `blob:` and `data:` documents.
    /// Anything else would leave the engine: a file, or a scheme another app
    /// answers.
    fn may_load(url: &str) -> bool {
        matches!(scheme(url).as_deref(), Some("http" | "https" | "about" | "blob" | "data"))
    }

    /// The one profile every pane webview shares: beside Dormouse's `state`
    /// and the app webview's `EBWebView` in the local data directory, inside
    /// neither.
    fn profile_dir(local_data: &Path) -> PathBuf {
        local_data.join("pane-webview")
    }

    struct Pane {
        /// `None` while its build is pending.
        view: Option<Rc<WebView>>,
        owner: String,
        /// Tells this pane's build from that of a pane closed and reopened under its id.
        gen: u64,
        /// What a pending build loads.
        url: String,
        /// Last reported.
        page: PageState,
        focused: bool,
        /// Wanted bounds; `None` is hidden.
        rect: Option<(f64, f64, f64, f64)>,
        /// Applied visibility.
        shown: bool,
        /// Take the keyboard once shown.
        want_focus: bool,
        /// Held the keyboard when its window went inactive.
        resume: bool,
        loading: Rc<Cell<Option<u64>>>,
    }

    thread_local! {
        static PANES: RefCell<HashMap<String, Pane>> = RefCell::default();
        static APP: OnceCell<AppHandle> = const { OnceCell::new() };
        static KEYS_HOOKED: Cell<bool> = const { Cell::new(false) };
        static LEFT: Cell<Option<(Key, f64)>> = const { Cell::new(None) };
    }
    static NEXT_GEN: AtomicU64 = AtomicU64::new(1);
    static EPOCH: OnceLock<Instant> = OnceLock::new();

    /// The registry, briefly: `f` must make no wry, WebView2, or Win32 call.
    /// `None` when it is already borrowed, which a callback skips.
    fn with_panes<T>(f: impl FnOnce(&mut HashMap<String, Pane>) -> T) -> Option<T> {
        PANES.with(|panes| panes.try_borrow_mut().ok().map(|mut panes| f(&mut panes)))
    }

    fn app() -> Option<AppHandle> {
        APP.with(|app| app.get().cloned())
    }

    pub fn supported() -> bool {
        wry::webview_version().is_ok()
    }

    fn label(webview: &Webview) -> String {
        webview.window().label().to_string()
    }

    fn no_page(loading: bool) -> PageState {
        PageState { url: String::new(), title: String::new(), can_go_back: false, can_go_forward: false, loading }
    }

    struct Parent(isize);

    impl HasWindowHandle for Parent {
        fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
            let hwnd = NonZeroIsize::new(self.0).ok_or(HandleError::Unavailable)?;
            let raw = RawWindowHandle::Win32(Win32WindowHandle::new(hwnd));
            // SAFETY: the app window outlives this builder call.
            Ok(unsafe { WindowHandle::borrow_raw(raw) })
        }
    }

    fn window_hwnd(app: &AppHandle, owner: &str) -> Result<HWND, String> {
        let window = app.get_webview_window(owner).ok_or("the window is gone")?;
        window.hwnd().map_err(|e| e.to_string())
    }

    pub fn open(webview: Webview, id: String, url: String) -> Result<PageState, String> {
        let app = webview.app_handle().clone();
        APP.with(|cell| {
            let _ = cell.set(app.clone());
        });
        let result = adopt_or_open(&app, label(&webview), id, url);
        sync(&app);
        result
    }

    fn adopt_or_open(app: &AppHandle, owner: String, id: String, url: String) -> Result<PageState, String> {
        let existing = with_panes(|panes| {
            let pane = panes.get_mut(&id)?;
            let from = std::mem::replace(&mut pane.owner, owner.clone());
            let held = pane.view.clone().map(|view| {
                let was_shown = pane.shown;
                if from != owner {
                    (pane.rect, pane.shown, pane.want_focus, pane.resume) = (None, false, false, false);
                }
                (view, was_shown, pane.loading.clone(), !pane.page.url.is_empty())
            });
            Some((held, from, pane.page.clone()))
        })
        .ok_or(BUSY)?;
        match existing {
            // Its build reads the owner it now has.
            Some((None, _, page)) => Ok(page),
            Some((Some((view, was_shown, loading, had_page)), from, _)) => {
                if from != owner {
                    let hwnd = window_hwnd(app, &owner)?;
                    if was_shown {
                        hide(app, &view, &from)?;
                    }
                    view.reparent(hwnd.0 as isize).map_err(|e| e.to_string())?;
                    hook_window(hwnd);
                }
                let page = page_of(&view, &loading, had_page);
                with_panes(|panes| {
                    if let Some(pane) = panes.get_mut(&id) {
                        pane.page = page.clone();
                    }
                });
                Ok(page)
            }
            None => {
                if !is_web(&url) {
                    return Err(format!("not an http(s) URL: {url}"));
                }
                let gen = NEXT_GEN.fetch_add(1, Ordering::Relaxed);
                let pane = Pane {
                    view: None,
                    owner,
                    gen,
                    url,
                    page: no_page(true),
                    focused: false,
                    rect: None,
                    shown: false,
                    want_focus: false,
                    resume: false,
                    loading: Rc::new(Cell::new(Some(FIRST_LOAD))),
                };
                with_panes(|panes| panes.insert(id.clone(), pane)).ok_or(BUSY)?;
                // From the main thread `run_on_main_thread` runs inline, inside
                // this callback; posted from another thread it waits for a
                // later turn, and never runs inside another build.
                let app = app.clone();
                std::thread::spawn(move || {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || build(&handle, &id, gen));
                });
                Ok(no_page(true))
            }
        }
    }

    fn build(app: &AppHandle, id: &str, gen: u64) {
        let wanted = with_panes(|panes| {
            let pane = panes.get(id).filter(|pane| pane.gen == gen && pane.view.is_none())?;
            Some((pane.owner.clone(), pane.url.clone(), pane.loading.clone()))
        });
        let Some(Some((owner, url, loading))) = wanted else { return };
        let view = match create(app, id, &owner, &url, &loading) {
            Ok(view) => view,
            Err(error) => return fail(app, id, gen, &error),
        };
        // Closed, or moved to another window, while it built.
        let now = with_panes(|panes| {
            let pane = panes.get_mut(id).filter(|pane| pane.gen == gen)?;
            pane.view = Some(view.clone());
            Some((pane.owner.clone(), pane.url.clone()))
        });
        let Some(Some((now_owner, now_url))) = now else {
            dispose(app, &view, None);
            return;
        };
        let hwnd = match window_hwnd(app, &now_owner) {
            Ok(hwnd) => hwnd,
            Err(error) => return fail(app, id, gen, &error),
        };
        if now_owner != owner {
            if let Err(error) = view.reparent(hwnd.0 as isize) {
                return fail(app, id, gen, &error.to_string());
            }
        }
        hook_window(hwnd);
        hook_keys(hwnd);
        if now_url != url {
            let _ = view.load_url(&now_url);
        }
        let _ = apply(app, id);
        sync(app);
    }

    /// A pane whose build failed is gone, and its panel hears that it did not load.
    fn fail(app: &AppHandle, id: &str, gen: u64, error: &str) {
        crate::append_log(format!("[pane-webview] {id} did not build: {error}"));
        let gone = with_panes(|panes| match panes.get(id) {
            Some(pane) if pane.gen == gen => panes.remove(id),
            _ => None,
        });
        if let Some(Some(pane)) = gone {
            if let Some(view) = &pane.view {
                dispose(app, view, None);
            }
            emit(app, &pane.owner, id, "page", serde_json::to_value(no_page(false)).unwrap_or_default());
        }
    }

    fn create(
        app: &AppHandle,
        id: &str,
        owner: &str,
        url: &str,
        loading: &Rc<Cell<Option<u64>>>,
    ) -> Result<Rc<WebView>, String> {
        let parent = Parent(window_hwnd(app, owner)?.0 as isize);
        let local = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        // Contexts on one directory share one profile and one browser process.
        let mut context = WebContext::new(Some(profile_dir(&local)));
        let (handle, id) = (app.clone(), id.to_string());
        let view = WebViewBuilder::new_with_web_context(&mut context)
            .with_url(url)
            .with_visible(false)
            // wry focuses a new view by default, taking the keyboard.
            .with_focused(false)
            .with_devtools(false)
            .with_clipboard(false)
            .with_navigation_handler(|url| may_load(&url))
            .with_new_window_req_handler(move |url, _| {
                if is_web(&url) {
                    let owner = with_panes(|panes| panes.get(&id).map(|pane| pane.owner.clone())).flatten();
                    if let Some(owner) = owner {
                        emit(&handle, &owner, &id, "open-window", json!({ "url": url }));
                    }
                }
                NewWindowResponse::Deny
            })
            // wry allows a download when no handler says otherwise.
            .with_download_started_handler(|_, _| false)
            .with_permission_handler(|_| PermissionResponse::Deny)
            // SmartScreen sends every visited URL to Microsoft.
            .with_additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection")
            .build_as_child(&parent)
            .map_err(|e| e.to_string())?;
        let view = Rc::new(view);
        // Never let a pane view drop: wry's `Drop` for a child sends its parent
        // the message that removes the APP webview's own subclass there, after
        // which the app webview no longer follows window resizes or takes the
        // keyboard on activation. This leaked reference keeps every pane view
        // alive; `dispose` closes one instead.
        std::mem::forget(Rc::clone(&view));
        // SAFETY: a live view, on the main thread.
        if let Err(error) = unsafe { guard(app, &view, loading) } {
            dispose(app, &view, None);
            return Err(format!("could not secure the page: {error}"));
        }
        Ok(view)
    }

    /// What wry's builder cannot set, and the handlers that report a page's
    /// state; a view any of them fails on never shows.
    unsafe fn guard(app: &AppHandle, view: &WebView, loading: &Rc<Cell<Option<u64>>>) -> windows::core::Result<()> {
        let core = view.webview();
        let controller = view.controller();
        let mut token = Default::default();
        // An external scheme, from any frame, would start another app.
        core.cast::<ICoreWebView2_18>()?.add_LaunchingExternalUriScheme(
            &LaunchingExternalUriSchemeEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetCancel(true)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
        // wry's navigation handler hears only the top frame.
        core.add_FrameNavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    if !may_load(&take_pwstr(uri)) {
                        args.SetCancel(true)?;
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
        let settings = core.Settings()?;
        settings.cast::<ICoreWebView2Settings8>()?.SetIsReputationCheckingRequired(false)?;
        settings.SetIsWebMessageEnabled(false)?;
        settings.SetAreHostObjectsAllowed(false)?;

        let (handle, cell) = (app.clone(), loading.clone());
        core.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    // wry's navigation handler ran first.
                    let mut cancel = BOOL::default();
                    args.Cancel(&mut cancel)?;
                    if !cancel.as_bool() {
                        let mut navigation = 0;
                        args.NavigationId(&mut navigation)?;
                        cell.set(Some(navigation));
                    }
                }
                sync(&handle);
                Ok(())
            })),
            &mut token,
        )?;
        let (handle, cell) = (app.clone(), loading.clone());
        core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut navigation = 0;
                    args.NavigationId(&mut navigation)?;
                    if matches!(cell.get(), Some(current) if current == navigation || current == FIRST_LOAD) {
                        cell.set(None);
                    }
                }
                sync(&handle);
                Ok(())
            })),
            &mut token,
        )?;
        let handle = app.clone();
        core.add_SourceChanged(
            &SourceChangedEventHandler::create(Box::new(move |_, _| {
                sync(&handle);
                Ok(())
            })),
            &mut token,
        )?;
        let handle = app.clone();
        core.add_HistoryChanged(
            &HistoryChangedEventHandler::create(Box::new(move |_, _| {
                sync(&handle);
                Ok(())
            })),
            &mut token,
        )?;
        let handle = app.clone();
        core.add_DocumentTitleChanged(
            &DocumentTitleChangedEventHandler::create(Box::new(move |_, _| {
                sync(&handle);
                Ok(())
            })),
            &mut token,
        )?;
        // Focus events come in bursts and pairs: they only prompt a look.
        let handle = app.clone();
        controller.add_GotFocus(
            &FocusChangedEventHandler::create(Box::new(move |_, _| {
                sync(&handle);
                Ok(())
            })),
            &mut token,
        )?;
        let handle = app.clone();
        controller.add_LostFocus(
            &FocusChangedEventHandler::create(Box::new(move |_, _| {
                sync(&handle);
                Ok(())
            })),
            &mut token,
        )?;
        if !SetWindowSubclass(view.hwnd(), Some(press_proc), PRESS_SUBCLASS, 0).as_bool() {
            return Err(E_FAIL.into());
        }
        Ok(())
    }

    /// Close a view without dropping it (see `create`), handing the keyboard
    /// back to its window's app webview if it held it and `refocus` names that window.
    fn dispose(app: &AppHandle, view: &WebView, refocus: Option<&str>) {
        let held = refocus.is_some() && thread_focus_in(view.hwnd());
        // SAFETY: a live controller, on the main thread. The container may
        // already be gone with its window.
        unsafe {
            let _ = view.controller().Close();
            let _ = DestroyWindow(view.hwnd());
        }
        if let Some(owner) = refocus.filter(|_| held) {
            focus_app(app, owner);
        }
    }

    /// Bring a built view to its wanted bounds, visibility, and focus.
    fn apply(app: &AppHandle, id: &str) -> Result<(), String> {
        enum Step {
            Show { first: bool, focus: bool },
            Hide,
            Stay,
        }
        let found = with_panes(|panes| {
            let pane = panes.get_mut(id)?;
            let view = pane.view.clone()?;
            let step = match pane.rect {
                Some(_) => {
                    let first = !pane.shown;
                    pane.shown = true;
                    Step::Show { first, focus: std::mem::take(&mut pane.want_focus) }
                }
                None if pane.shown => {
                    pane.shown = false;
                    pane.resume = false;
                    Step::Hide
                }
                None => Step::Stay,
            };
            Some((view, pane.owner.clone(), pane.rect, step))
        });
        let Some(Some((view, owner, rect, step))) = found else { return Ok(()) };
        match (step, rect) {
            (Step::Show { first, focus }, Some((x, y, width, height))) => {
                let bounds = wry::Rect {
                    position: LogicalPosition::new(x, y).into(),
                    size: LogicalSize::new(width, height).into(),
                };
                view.set_bounds(bounds).map_err(|e| e.to_string())?;
                if first {
                    view.set_visible(true).map_err(|e| e.to_string())?;
                }
                if focus {
                    move_focus(&view);
                }
                Ok(())
            }
            (Step::Hide, _) => hide(app, &view, &owner),
            _ => Ok(()),
        }
    }

    /// A hidden view keeps the keyboard it held, and keys typed then are lost.
    fn hide(app: &AppHandle, view: &WebView, owner: &str) -> Result<(), String> {
        let held = thread_focus_in(view.hwnd());
        // `SetIsVisible(false)`, inside, is what throttles the page.
        view.set_visible(false).map_err(|e| e.to_string())?;
        if held {
            focus_app(app, owner);
        }
        Ok(())
    }

    pub fn place(webview: Webview, id: String, rect: Option<Rect>) -> Result<(), String> {
        let app = webview.app_handle().clone();
        let owner = label(&webview);
        let rect = rect.map(|rect| (rect.x, rect.y, rect.width, rect.height));
        let owned = with_panes(|panes| match panes.get_mut(&id) {
            Some(pane) if pane.owner == owner => {
                pane.rect = rect;
                true
            }
            _ => false,
        })
        .ok_or(BUSY)?;
        let result = if owned { apply(&app, &id) } else { Ok(()) };
        sync(&app);
        result
    }

    pub fn navigate(webview: Webview, id: String, url: String) -> Result<(), String> {
        if !is_web(&url) {
            return Err(format!("not an http(s) URL: {url}"));
        }
        let app = webview.app_handle().clone();
        let owner = label(&webview);
        let view = with_panes(|panes| {
            let pane = panes.get_mut(&id).filter(|pane| pane.owner == owner)?;
            if pane.view.is_none() {
                pane.url = url.clone();
            }
            pane.view.clone()
        })
        .ok_or(BUSY)?;
        let result = match view {
            Some(view) => view.load_url(&url).map_err(|e| e.to_string()),
            None => Ok(()),
        };
        sync(&app);
        result
    }

    pub fn history(webview: Webview, id: String, dir: String) -> Result<(), String> {
        let app = webview.app_handle().clone();
        let owner = label(&webview);
        let found = with_panes(|panes| panes.get(&id).filter(|pane| pane.owner == owner).map(|pane| pane.view.clone()))
            .ok_or(BUSY)?;
        let Some(view) = found else { return Ok(()) };
        if !matches!(dir.as_str(), "back" | "forward" | "reload") {
            return Err(format!("unknown history direction: {dir}"));
        }
        let Some(view) = view else { return Ok(()) };
        let result = match dir.as_str() {
            "back" => view.go_back(),
            "forward" => view.go_forward(),
            _ => view.reload(),
        }
        .map_err(|e| e.to_string());
        sync(&app);
        result
    }

    pub fn focus(webview: Webview, id: Option<String>, _from: Option<String>) -> Result<(), String> {
        enum Target {
            Pane(Rc<WebView>),
            App(Vec<Rc<WebView>>),
            Nothing,
        }
        let app = webview.app_handle().clone();
        let owner = label(&webview);
        let target = with_panes(|panes| {
            for (pane_id, pane) in panes.iter_mut().filter(|(_, pane)| pane.owner == owner) {
                pane.resume = false;
                if id.as_deref() != Some(pane_id.as_str()) {
                    pane.want_focus = false;
                }
            }
            match &id {
                Some(id) => match panes.get_mut(id).filter(|pane| pane.owner == owner) {
                    Some(pane) => match &pane.view {
                        None => {
                            pane.want_focus = true;
                            Target::Nothing
                        }
                        Some(view) if pane.shown => Target::Pane(view.clone()),
                        // A hidden view never holds focus, and commands can
                        // arrive out of the order they were sent in: this
                        // one waits for the `place` that shows the view.
                        Some(_) => {
                            pane.want_focus = true;
                            Target::Nothing
                        }
                    },
                    None => Target::Nothing,
                },
                None => Target::App(
                    panes.values().filter(|pane| pane.owner == owner).filter_map(|pane| pane.view.clone()).collect(),
                ),
            }
        })
        .ok_or(BUSY)?;
        match target {
            Target::Pane(view) => move_focus(&view),
            // A focus move onto the app webview when it already has the
            // keyboard would blur and refocus its document.
            Target::App(views) if views.iter().any(|view| thread_focus_in(view.hwnd())) => focus_app(&app, &owner),
            _ => {}
        }
        sync(&app);
        Ok(())
    }

    pub fn close(webview: Webview, id: String) -> Result<(), String> {
        let app = webview.app_handle().clone();
        let owner = label(&webview);
        let result = remove(&app, |pane_id, pane| pane_id == id && pane.owner == owner, true);
        sync(&app);
        result
    }

    pub fn reset(webview: Webview) -> Result<(), String> {
        let app = webview.app_handle().clone();
        let owner = label(&webview);
        let result = remove(&app, |_, pane| pane.owner == owner, true);
        sync(&app);
        result
    }

    /// Not built on Windows yet: a hidden pane shows its plain placeholder.
    pub fn snapshot(_: Webview, _: String) -> Result<String, String> {
        Err("pane webview stills are not built on Windows".into())
    }

    /// The window is gone, so nothing is left to focus.
    pub fn forget_window(app: &AppHandle, label: &str) {
        let (handle, label) = (app.clone(), label.to_string());
        let _ = app.run_on_main_thread(move || {
            let _ = remove(&handle, |_, pane| pane.owner == label, false);
        });
    }

    pub fn close_all(app: &AppHandle) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = remove(&handle, |_, _| true, false);
        });
    }

    /// A pending pane just leaves the registry: its build finds it gone.
    fn remove(app: &AppHandle, doomed: impl Fn(&str, &Pane) -> bool, refocus: bool) -> Result<(), String> {
        let gone = with_panes(|panes| {
            let ids: Vec<String> =
                panes.iter().filter(|(id, pane)| doomed(id, pane)).map(|(id, _)| id.clone()).collect();
            ids.iter().filter_map(|id| panes.remove(id)).collect::<Vec<_>>()
        })
        .ok_or(BUSY)?;
        for pane in gone {
            if let Some(view) = &pane.view {
                dispose(app, view, refocus.then_some(pane.owner.as_str()));
            }
        }
        Ok(())
    }

    /// Whether the main thread's keyboard focus is in `container`. The
    /// focused window belongs to the WebView2 browser process, but the input
    /// queues are attached, so `GetFocus` here still names it.
    fn thread_focus_in(container: HWND) -> bool {
        // SAFETY: plain window queries.
        unsafe {
            let focus = GetFocus();
            !focus.is_invalid() && (focus == container || IsChild(container, focus).as_bool())
        }
    }

    /// Focus moves within a thread while another app is in front.
    fn in_front(container: HWND) -> bool {
        // SAFETY: plain window queries.
        unsafe {
            let root = GetAncestor(container, GA_ROOT);
            !root.is_invalid() && GetForegroundWindow() == root
        }
    }

    /// The user's keyboard is really in this view.
    fn has_keyboard(container: HWND) -> bool {
        thread_focus_in(container) && in_front(container)
    }

    /// A move onto a view that already has the keyboard fires a spurious
    /// lost-and-got pair.
    fn move_focus(view: &WebView) {
        if !thread_focus_in(view.hwnd()) {
            // SAFETY: a live controller, on the main thread.
            let _ = unsafe { view.controller().MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) };
        }
    }

    /// Give the keyboard to a window's app webview; its document keeps its `activeElement`.
    fn focus_app(app: &AppHandle, owner: &str) {
        if let Some(window) = app.get_webview_window(owner) {
            let _ = window.with_webview(|platform| {
                // SAFETY: the live app controller, on the main thread.
                let _ = unsafe { platform.controller().MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) };
            });
        }
    }

    /// `had_page`: whether this view has reported a URL before.
    fn page_of(view: &WebView, loading: &Cell<Option<u64>>, had_page: bool) -> PageState {
        let core = view.webview();
        // SAFETY: plain property reads on a live webview, on the main thread.
        let (source, title) = unsafe {
            let mut source = PWSTR::null();
            let source = core.Source(&mut source).map(|_| take_pwstr(source)).unwrap_or_default();
            let mut title = PWSTR::null();
            let title = core.DocumentTitle(&mut title).map(|_| take_pwstr(title)).unwrap_or_default();
            (source, title)
        };
        PageState {
            // `about:blank` until the first commit, where macOS has no URL,
            // and no URL with no load in flight tells the panel the page
            // failed. A page that later moves itself to `about:blank` has not.
            url: if is_web(&source) || had_page { source } else { String::new() },
            title,
            can_go_back: view.can_go_back().unwrap_or(false),
            can_go_forward: view.can_go_forward().unwrap_or(false),
            loading: loading.get().is_some(),
        }
    }

    fn emit(app: &AppHandle, owner: &str, id: &str, kind: &str, mut payload: Value) {
        payload["id"] = id.into();
        payload["kind"] = kind.into();
        let _ = app.emit_to(owner, EVENT, payload);
    }

    /// Report every page and focus change since the last call.
    fn sync(app: &AppHandle) {
        let views = with_panes(|panes| {
            panes
                .iter()
                .filter_map(|(id, pane)| {
                    let had_page = !pane.page.url.is_empty();
                    pane.view.clone().map(|view| (id.clone(), pane.gen, view, pane.loading.clone(), had_page))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
        let seen: Vec<_> = views
            .into_iter()
            .map(|(id, gen, view, loading, had_page)| {
                let container = view.hwnd();
                (id, gen, page_of(&view, &loading, had_page), has_keyboard(container), in_front(container))
            })
            .collect();
        let events = with_panes(|panes| {
            let mut events = Vec::new();
            for (id, gen, page, focused, front) in seen {
                let Some(pane) = panes.get_mut(&id).filter(|pane| pane.gen == gen) else { continue };
                if page != pane.page {
                    let payload = serde_json::to_value(&page).unwrap_or_default();
                    events.push((pane.owner.clone(), id.clone(), "page", payload));
                    pane.page = page;
                }
                if focused != pane.focused {
                    // Its window went inactive with the keyboard in it.
                    if pane.focused && !front {
                        pane.resume = true;
                    }
                    events.push((pane.owner.clone(), id.clone(), "focus", json!({ "focused": focused })));
                    pane.focused = focused;
                }
            }
            events
        })
        .unwrap_or_default();
        for (owner, id, kind, payload) in events {
            emit(app, &owner, &id, kind, payload);
        }
    }

    /// Each owner window, once: wry's subclass there hands every `WM_SETFOCUS`
    /// to the app webview, so a window coming back to the front would take
    /// the keyboard from the pane that had it. A second call only replaces
    /// the subclass's data.
    fn hook_window(window: HWND) {
        // SAFETY: a window of this thread.
        let _ = unsafe { SetWindowSubclass(window, Some(window_proc), WINDOW_SUBCLASS, 0) };
    }

    fn panes_in(window: HWND) -> Vec<(String, Rc<WebView>, bool, bool, bool)> {
        let views = with_panes(|panes| {
            panes
                .iter()
                .filter_map(|(id, pane)| {
                    pane.view.clone().map(|view| (id.clone(), view, pane.focused, pane.shown, pane.resume))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
        // SAFETY: a plain window query.
        views.into_iter().filter(|(_, view, ..)| unsafe { GetAncestor(view.hwnd(), GA_ROOT) } == window).collect()
    }

    fn set_resume(id: &str, resume: bool) {
        with_panes(|panes| {
            if let Some(pane) = panes.get_mut(id) {
                pane.resume = resume;
            }
        });
    }

    unsafe extern "system" fn window_proc(
        window: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _: usize,
        _: usize,
    ) -> LRESULT {
        match msg {
            WM_ACTIVATE => {
                if (wparam.0 & 0xffff) as u32 == WA_INACTIVE {
                    for (id, view, focused, ..) in panes_in(window) {
                        if focused || thread_focus_in(view.hwnd()) {
                            set_resume(&id, true);
                        }
                    }
                }
                // Another app can come to the front with no focus event from
                // the view, and the foreground window only changes after this
                // message: look again a turn later.
                if let Some(app) = app() {
                    std::thread::spawn(move || {
                        let handle = app.clone();
                        let _ = app.run_on_main_thread(move || sync(&handle));
                    });
                }
            }
            WM_SETFOCUS => {
                // wry's subclass, below this one, gives the app webview the keyboard.
                let result = DefSubclassProc(window, msg, wparam, lparam);
                let back = panes_in(window).into_iter().find(|(_, _, _, shown, resume)| *shown && *resume);
                if let Some((id, view, ..)) = back {
                    set_resume(&id, false);
                    move_focus(&view);
                }
                if let Some(app) = app() {
                    sync(&app);
                }
                return result;
            }
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(window, Some(window_proc), WINDOW_SUBCLASS);
            }
            _ => {}
        }
        DefSubclassProc(window, msg, wparam, lparam)
    }

    /// A press anywhere in a view reaches its container as `WM_PARENTNOTIFY`,
    /// once, whether or not the view had the keyboard; the same message also
    /// reports child windows created and destroyed.
    unsafe extern "system" fn press_proc(
        container: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _: usize,
        _: usize,
    ) -> LRESULT {
        if msg == WM_PARENTNOTIFY
            && matches!(
                (wparam.0 & 0xffff) as u32,
                WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN | WM_POINTERDOWN
            )
        {
            let hit = with_panes(|panes| {
                panes
                    .iter()
                    .find(|(_, pane)| pane.view.as_ref().is_some_and(|view| view.hwnd() == container))
                    .map(|(id, pane)| (id.clone(), pane.owner.clone()))
            })
            .flatten();
            if let (Some((id, owner)), Some(app)) = (hit, app()) {
                emit(&app, &owner, &id, "pointerdown", json!({}));
            }
        }
        if msg == WM_NCDESTROY {
            let _ = RemoveWindowSubclass(container, Some(press_proc), PRESS_SUBCLASS);
        }
        DefSubclassProc(container, msg, wparam, lparam)
    }

    /// No key reaches a window of this process while a webview has the
    /// keyboard, and the page sees the leader's Shift taps too late to stop
    /// them. tao already registers keyboard Raw Input without
    /// `RIDEV_INPUTSINK`, which delivers every key while this process is in
    /// front and none otherwise: observe it on tao's target window, and
    /// register the same on `window` only where tao has none.
    fn hook_keys(window: HWND) {
        if KEYS_HOOKED.get() {
            return;
        }
        let Some(target) = keyboard_target().or_else(|| register_keyboard(window)) else { return };
        // SAFETY: tao's target and the app window are windows of this thread.
        if unsafe { SetWindowSubclass(target, Some(keys_proc), KEYS_SUBCLASS, 0) }.as_bool() {
            KEYS_HOOKED.set(true);
        }
    }

    fn keyboard_target() -> Option<HWND> {
        let size = std::mem::size_of::<RAWINPUTDEVICE>() as u32;
        let mut count = 0;
        // SAFETY: the first call only counts; the second fills `count` entries.
        unsafe {
            GetRegisteredRawInputDevices(None, &mut count, size);
            let mut devices = vec![RAWINPUTDEVICE::default(); count as usize];
            if count == 0 || GetRegisteredRawInputDevices(Some(devices.as_mut_ptr()), &mut count, size) == u32::MAX {
                return None;
            }
            devices
                .into_iter()
                .find(|device| {
                    device.usUsagePage == 1
                        && device.usUsage == 6
                        && !device.hwndTarget.is_invalid()
                        && IsWindow(Some(device.hwndTarget)).as_bool()
                })
                .map(|device| device.hwndTarget)
        }
    }

    fn register_keyboard(window: HWND) -> Option<HWND> {
        // Never `RIDEV_INPUTSINK`, which also delivers keys typed into other apps.
        let device = RAWINPUTDEVICE { usUsagePage: 1, usUsage: 6, dwFlags: RAWINPUTDEVICE_FLAGS(0), hwndTarget: window };
        // SAFETY: one well-formed registration.
        unsafe { RegisterRawInputDevices(&[device], std::mem::size_of::<RAWINPUTDEVICE>() as u32) }
            .ok()
            .map(|_| window)
    }

    unsafe extern "system" fn keys_proc(
        window: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _: usize,
        _: usize,
    ) -> LRESULT {
        match msg {
            // RIM_INPUT: typed while this process is in front. Reading it
            // leaves it for tao.
            WM_INPUT if wparam.0 & 0xff == 0 => on_raw_input(HRAWINPUT(lparam.0 as *mut c_void)),
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(window, Some(keys_proc), KEYS_SUBCLASS);
                KEYS_HOOKED.set(false);
            }
            _ => {}
        }
        DefSubclassProc(window, msg, wparam, lparam)
    }

    fn on_raw_input(input: HRAWINPUT) {
        let mut raw = RAWINPUT::default();
        let mut size = std::mem::size_of::<RAWINPUT>() as u32;
        let header = std::mem::size_of::<RAWINPUTHEADER>() as u32;
        // SAFETY: `raw` is large enough for keyboard and mouse input; a larger
        // report fails the read.
        let read = unsafe {
            GetRawInputData(input, RID_INPUT, Some(&mut raw as *mut RAWINPUT as *mut c_void), &mut size, header)
        };
        if read == u32::MAX || raw.header.dwType != RIM_TYPEKEYBOARD.0 {
            return;
        }
        // SAFETY: the header says keyboard.
        let keyboard = unsafe { raw.data.keyboard };
        let views = with_panes(|panes| {
            panes
                .iter()
                .filter_map(|(id, pane)| pane.view.clone().map(|view| (id.clone(), pane.owner.clone(), view)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
        let Some((id, owner, _)) = views.into_iter().find(|(_, _, view)| has_keyboard(view.hwnd())) else {
            LEFT.set(None);
            return;
        };
        let Some(key) = pressed(keyboard.MakeCode, keyboard.Flags) else { return };
        let now = EPOCH.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0;
        let mut left = LEFT.take();
        let leader = dual_tap(&mut left, key, now);
        LEFT.set(left);
        if let (true, Some(app)) = (leader, app()) {
            emit(&app, &owner, &id, "leader", json!({}));
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq)]
    enum Key {
        LeftMeta,
        RightMeta,
        LeftShift,
        RightShift,
        Other,
    }

    /// What a Raw Input keyboard report presses, or `None` for a release,
    /// which raises no `keydown`. Keyboards wrap extended keys in fake
    /// E0-prefixed Shifts, which are no Shift at all.
    fn pressed(make_code: u16, flags: u16) -> Option<Key> {
        if flags & RI_KEY_BREAK != 0 {
            return None;
        }
        let e0 = flags & RI_KEY_E0 != 0;
        match (make_code, e0) {
            (KEYBOARD_OVERRUN_MAKE_CODE, _) => None,
            (0x2A, false) => Some(Key::LeftShift),
            (0x36, false) => Some(Key::RightShift),
            (0x2A | 0x36, true) => None,
            (0x5B, true) => Some(Key::LeftMeta),
            (0x5C, true) => Some(Key::RightMeta),
            _ => Some(Key::Other),
        }
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
            assert_eq!(pressed(0x2A, 0), Some(LeftShift));
            assert_eq!(pressed(0x36, 0), Some(RightShift));
            assert_eq!(pressed(0x5B, RI_KEY_E0), Some(LeftMeta));
            assert_eq!(pressed(0x5C, RI_KEY_E0), Some(RightMeta));
            assert_eq!(pressed(0x2A, RI_KEY_BREAK), None);
            assert_eq!(pressed(0x5C, RI_KEY_E0 | RI_KEY_BREAK), None);
            // The fake Shifts around an extended key, such as an arrow with Num Lock on.
            assert_eq!(pressed(0x2A, RI_KEY_E0), None);
            assert_eq!(pressed(0x36, RI_KEY_E0), None);
            assert_eq!(pressed(KEYBOARD_OVERRUN_MAKE_CODE, 0), None);
            // `A`, and the Shift-like codes without their E0.
            assert_eq!(pressed(0x1E, 0), Some(Other));
            assert_eq!(pressed(0x5B, 0), Some(Other));
        }

        #[test]
        fn the_profile_is_its_own_folder() {
            let local = Path::new(r"C:\Users\u\AppData\Local\sh.dormouse");
            let profile = profile_dir(local);
            assert!(profile.starts_with(local));
            assert_ne!(profile, local);
            assert!(!profile.starts_with(local.join("state")));
            assert!(!profile.components().any(|part| part.as_os_str() == "EBWebView"));
        }
    }
}
