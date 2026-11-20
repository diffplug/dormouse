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

/// Answer the page's pending alert, confirm, or prompt: `accept` is OK, and
/// `text` what a prompt returns. On Windows the engine shows its own.
#[tauri::command]
pub fn pane_webview_answer(webview: Webview, id: String, accept: bool, text: Option<String>) -> Result<(), String> {
    imp::answer(webview, id, accept, text)
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

#[cfg(any(target_os = "macos", windows))]
const EVENT: &str = "dormouse://pane-webview";

#[cfg(any(target_os = "macos", windows))]
fn scheme(url: &str) -> Option<String> {
    url.split_once(':').map(|(scheme, _)| scheme.to_ascii_lowercase())
}

#[cfg(any(target_os = "macos", windows))]
fn is_web(url: &str) -> bool {
    matches!(scheme(url).as_deref(), Some("http" | "https"))
}

/// What a page may load, in any frame: pages frame their own `about:`,
/// `blob:` and `data:` documents. Anything else would leave the engine: a
/// file, or a scheme another app answers.
#[cfg(any(target_os = "macos", windows))]
fn may_load(url: &str) -> bool {
    matches!(scheme(url).as_deref(), Some("http" | "https" | "about" | "blob" | "data"))
}

#[cfg(any(target_os = "macos", windows))]
#[derive(Clone, Copy, Debug, PartialEq)]
enum Key {
    LeftMeta,
    RightMeta,
    LeftShift,
    RightShift,
    Other,
}

/// `dualTap` in lib/src/lib/dual-tap.ts, which this must match: true when
/// `key` completes left-then-right Meta, or Shift, under 500 ms apart.
#[cfg(any(target_os = "macos", windows))]
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

#[cfg(any(target_os = "macos", windows))]
fn emit(app: &AppHandle, owner: &str, id: &str, kind: &str, mut payload: serde_json::Value) {
    use tauri::Emitter;
    payload["id"] = id.into();
    payload["kind"] = kind.into();
    let _ = app.emit_to(owner, EVENT, payload);
}

#[cfg(all(test, any(target_os = "macos", windows)))]
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
}

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
    pub fn answer(_: Webview, _: String, _: bool, _: Option<String>) -> Result<(), String> {
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
    use block2::{Block, RcBlock};
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::{AnyObject, Bool, NSObject, ProtocolObject, Sel};
    use objc2::{define_class, msg_send, ClassType, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSEvent, NSEventMask, NSEventModifierFlags, NSEventType, NSImage,
        NSImageCompressionFactor,
        NSResponder, NSView, NSWindow,
    };
    use objc2_foundation::{
        NSDataBase64EncodingOptions, NSDictionary, NSError, NSNumber, NSObjectProtocol, NSOperatingSystemVersion,
        NSProcessInfo, NSString,
    };
    use objc2_web_kit::{WKFrameInfo, WKSnapshotConfiguration, WKUIDelegate, WKWebView};
    use serde_json::json;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tauri::Manager;
    use wry::dpi::{LogicalPosition, LogicalSize};
    use wry::raw_window_handle::{
        AppKitWindowHandle, HandleError, HasWindowHandle, RawWindowHandle, WindowHandle,
    };
    use wry::{
        NewWindowResponse, PermissionResponse, WebView, WebViewBuilder, WebViewBuilderExtDarwin,
        WebViewExtMacOS, WryWebView,
    };

    /// The one profile every pane webview shares; never the app webview's.
    const STORE: [u8; 16] = [
        0x6b, 0x1e, 0x2f, 0x4a, 0x93, 0xd0, 0x4c, 0x51, 0x8e, 0x27, 0x0b, 0xa6, 0x5d, 0x71, 0xc3, 0x9f,
    ];
    const POLL: Duration = Duration::from_millis(250);

    fn web_only(url: &str) -> Result<(), String> {
        is_web(url).then_some(()).ok_or_else(|| format!("not an http(s) URL: {url}"))
    }

    struct Pane {
        /// Before `view`, so a pending one is answered while its view lives.
        dialog: Option<Dialog>,
        view: WebView,
        /// The view's UI delegate, which the view holds only weakly.
        _dialogs: Retained<Dialogs>,
        owner: String,
        page: PageState,
        focused: bool,
        /// Its page's process ended, so the next `open` builds a new view.
        crashed: bool,
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

    /// The longest message or default text a page's dialog reports, in characters.
    const DIALOG_TEXT_MAX: usize = 4000;

    fn capped(text: &NSString) -> String {
        text.to_string().chars().take(DIALOG_TEXT_MAX).collect()
    }

    /// The completion handler of a page's alert, confirm, or prompt.
    enum Handler {
        Alert(RcBlock<dyn Fn()>),
        Confirm(RcBlock<dyn Fn(Bool)>),
        Prompt(RcBlock<dyn Fn(*mut NSString)>),
    }

    /// A page's dialog waiting on the user. WebKit raises if its handler is
    /// released uncalled, so one dropped unanswered answers no: an alert is
    /// done, a confirm false, a prompt null.
    struct Dialog(Option<Handler>);

    impl Dialog {
        fn answer(mut self, accept: bool, text: Option<String>) {
            self.reply(accept, text);
        }

        fn reply(&mut self, accept: bool, text: Option<String>) {
            match self.0.take() {
                Some(Handler::Alert(handler)) => handler.call(()),
                Some(Handler::Confirm(handler)) => handler.call((Bool::new(accept),)),
                Some(Handler::Prompt(handler)) => {
                    let text = accept.then(|| NSString::from_str(&text.unwrap_or_default()));
                    handler.call((text.as_ref().map_or(std::ptr::null_mut(), |text| Retained::as_ptr(text).cast_mut()),));
                }
                None => {}
            }
        }
    }

    impl Drop for Dialog {
        fn drop(&mut self) {
            self.reply(false, None);
        }
    }

    struct DialogsIvars {
        /// wry's own UI delegate, which answers everything else.
        wry: Retained<ProtocolObject<dyn WKUIDelegate>>,
        app: AppHandle,
        id: String,
    }

    define_class!(
        /// A view's UI delegate: asks a page's alert, confirm, and prompt in
        /// its pane, and hands every other call to wry's delegate.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = DialogsIvars]
        struct Dialogs;

        unsafe impl NSObjectProtocol for Dialogs {
            #[unsafe(method(respondsToSelector:))]
            fn responds_to(&self, sel: Sel) -> bool {
                Self::class().responds_to(sel) || self.ivars().wry.respondsToSelector(sel)
            }
        }

        impl Dialogs {
            #[unsafe(method(forwardingTargetForSelector:))]
            fn forwarding_target(&self, _: Sel) -> *mut AnyObject {
                Retained::as_ptr(&self.ivars().wry).cast::<AnyObject>().cast_mut()
            }
        }

        unsafe impl WKUIDelegate for Dialogs {
            #[unsafe(method(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:))]
            fn alert(&self, _: &WKWebView, message: &NSString, frame: &WKFrameInfo, handler: &Block<dyn Fn()>) {
                let payload = json!({ "dialog": "alert", "message": capped(message) });
                self.ask(Dialog(Some(Handler::Alert(handler.copy()))), payload, frame);
            }

            #[unsafe(method(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))]
            fn confirm(&self, _: &WKWebView, message: &NSString, frame: &WKFrameInfo, handler: &Block<dyn Fn(Bool)>) {
                let payload = json!({ "dialog": "confirm", "message": capped(message) });
                self.ask(Dialog(Some(Handler::Confirm(handler.copy()))), payload, frame);
            }

            #[unsafe(method(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:))]
            fn prompt(
                &self, _: &WKWebView, message: &NSString, text: Option<&NSString>, frame: &WKFrameInfo,
                handler: &Block<dyn Fn(*mut NSString)>,
            ) {
                let payload = json!({ "dialog": "prompt", "message": capped(message), "text": text.map(capped).unwrap_or_default() });
                self.ask(Dialog(Some(Handler::Prompt(handler.copy()))), payload, frame);
            }
        }
    );

    impl Dialogs {
        fn new(wry: Retained<ProtocolObject<dyn WKUIDelegate>>, app: AppHandle, id: String, mtm: MainThreadMarker) -> Retained<Self> {
            let this = mtm.alloc::<Self>().set_ivars(DialogsIvars { wry, app, id });
            // SAFETY: NSObject's designated initializer.
            unsafe { msg_send![super(this), init] }
        }

        /// Hold `dialog` on its pane and report it; one at a time per pane, so
        /// another, or one with no pane, gets the default at once.
        fn ask(&self, dialog: Dialog, mut payload: serde_json::Value, frame: &WKFrameInfo) {
            let DialogsIvars { app, id, .. } = self.ivars();
            let held = PANES.with(move |panes| {
                let Ok(mut panes) = panes.try_borrow_mut() else { return Err(dialog) };
                match panes.get_mut(id) {
                    // A hidden view's panel may not be there to ask or to answer.
                    Some(pane) if pane.dialog.is_none() && !pane.view.webview().isHidden() => {
                        pane.dialog = Some(dialog);
                        Ok(pane.owner.clone())
                    }
                    _ => Err(dialog),
                }
            });
            if let Ok(owner) = held {
                // SAFETY: plain property reads on a live frame, on the main thread.
                payload["origin"] = unsafe { frame.securityOrigin().host() }.to_string().into();
                emit(app, &owner, id, "dialog", payload);
            }
        }
    }

    /// `CACornerMask` for the two corners at the bottom of a flipped view.
    const BOTTOM_CORNERS: usize = 4 | 8;

    /// Report `kind` to the window that owns `id`'s view, from one of that
    /// view's own handlers.
    fn report(app: &AppHandle, id: &str, kind: &str, payload: serde_json::Value) {
        let owner = PANES.with(|panes| panes.try_borrow().ok()?.get(id).map(|pane| pane.owner.clone()));
        if let Some(owner) = owner {
            emit(app, &owner, id, kind, payload);
        }
    }

    fn build(webview: &Webview, id: &str, url: &str) -> Result<(WebView, Retained<Dialogs>), String> {
        let window = ns_window(webview)?;
        let content = window.contentView().ok_or("the window has no content view")?;
        let parent = ContentView(NonNull::from(&*content).cast());
        let (app, id) = (webview.app_handle().clone(), id.to_string());
        let (asker, downloader, crashed) = ((app.clone(), id.clone()), (app.clone(), id.clone()), (app.clone(), id.clone()));
        let view = WebViewBuilder::new()
            .with_url(url)
            .with_visible(false)
            // wry turns devtools on in a debug build.
            .with_devtools(false)
            .with_navigation_handler(|url| may_load(&url))
            .with_new_window_req_handler(move |url, _| {
                if is_web(&url) {
                    report(&app, &id, "open-window", json!({ "url": url }));
                }
                NewWindowResponse::Deny
            })
            .with_download_started_handler(move |_, _| {
                report(&downloader.0, &downloader.1, "download-refused", json!({}));
                false
            })
            // wry grants media capture when no handler is set.
            .with_permission_handler(|_| PermissionResponse::Deny)
            .with_on_web_content_process_terminate_handler(move || {
                // Kept for a panel that is not mounted to hear the report.
                PANES.with(|panes| {
                    if let Some(pane) = panes.try_borrow_mut().ok().as_mut().and_then(|panes| panes.get_mut(&crashed.1)) {
                        pane.crashed = true;
                    }
                });
                report(&crashed.0, &crashed.1, "crashed", json!({}));
            })
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
            // The pane rounds its bottom corners, which a native view squares
            // off: `TERMINAL_BORDER_RADIUS_PX` in `lib/src/components/design.tsx`.
            let layer: Option<Retained<AnyObject>> = msg_send![&*view.webview(), layer];
            if let Some(layer) = layer {
                let _: () = msg_send![&*layer, setCornerRadius: 8.0f64];
                let _: () = msg_send![&*layer, setMaskedCorners: BOTTOM_CORNERS];
                let _: () = msg_send![&*layer, setMasksToBounds: true];
            }
        }
        // WebKit reads which methods a UI delegate has as it is set, so this
        // one is whole before it replaces wry's.
        // SAFETY: the live view's UI delegate, read and set on the main thread.
        let dialogs = unsafe {
            let wry = view.webview().UIDelegate().ok_or("the view has no UI delegate")?;
            let dialogs = Dialogs::new(wry, asker.0, asker.1, MainThreadMarker::from(&*window));
            view.webview().setUIDelegate(Some(ProtocolObject::from_ref(&*dialogs)));
            dialogs
        };
        Ok((view, dialogs))
    }

    pub fn open(webview: Webview, id: String, url: String) -> Result<PageState, String> {
        if !supported() {
            return Err(UNSUPPORTED.into());
        }
        command(webview, true, move |panes, webview, owner| {
            panes.retain(|pane_id, pane| *pane_id != id || !pane.crashed);
            if let Some(pane) = panes.get_mut(&id) {
                if pane.owner != owner {
                    let window = ns_window(webview)?;
                    pane.view.set_visible(false).map_err(|e| e.to_string())?;
                    pane.view.reparent(Retained::as_ptr(&window).cast_mut()).map_err(|e| e.to_string())?;
                    pane.owner = owner.to_string();
                    // Its old window asked, and can no longer answer.
                    pane.dialog = None;
                }
                pane.page = page_state(&pane.view.webview());
                return Ok(pane.page.clone());
            }
            web_only(&url)?;
            let (view, dialogs) = build(webview, &id, &url)?;
            let page = page_state(&view.webview());
            panes.insert(id, Pane { dialog: None, view, _dialogs: dialogs, owner: owner.to_string(), page: page.clone(), focused: false, crashed: false });
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

    pub fn answer(webview: Webview, id: String, accept: bool, text: Option<String>) -> Result<(), String> {
        command(webview, false, move |panes, _, owner| {
            let pane = panes.get_mut(&id).filter(|pane| pane.owner == owner);
            if let Some(dialog) = pane.and_then(|pane| pane.dialog.take()) {
                dialog.answer(accept, text);
            }
            Ok(())
        })
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
            let handler = RcBlock::new(move |image: *mut NSImage, _: *mut NSError| {
                // SAFETY: WebKit passes a live image or null.
                let _ = tx.send(unsafe { Retained::retain(image) }.map(Handed));
            });
            // SAFETY: a property write and a call on a live WKWebView, on the main thread.
            unsafe {
                config.setSnapshotWidth(Some(&width));
                view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
            }
            Ok(())
        })?;
        // Encoded on this thread: on the main one it would stall both webviews.
        let image = rx.recv_timeout(SNAPSHOT_WAIT).ok().flatten();
        image.and_then(|Handed(image)| autoreleasepool(|_| jpeg_data_url(&image))).ok_or_else(|| "no snapshot".to_string())
    }

    /// A snapshot WebKit has handed over and no longer touches.
    struct Handed(Retained<NSImage>);
    // SAFETY: it has one owner, and AppKit lets any thread read an image no other thread uses.
    unsafe impl Send for Handed {}

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
        let (left, over, zoom_at) = (Cell::new(None), Cell::new(None), Cell::new(0.0));
        let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit hands the monitor a live event, on the main thread.
            let (ev, mtm) = unsafe { (event.as_ref(), MainThreadMarker::new_unchecked()) };
            on_event(&app, ev, mtm, &left, &over, &zoom_at);
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
        over: &Cell<Option<(String, String)>>, zoom_at: &Cell<f64>,
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
        // WebKit sends a key through the app again only when its page left it
        // unhandled, so a page that takes a zoom chord itself keeps it.
        let unhandled = kind == NSEventType::KeyDown && zoom_at.replace(event.timestamp()) == event.timestamp();
        if unhandled && event.modifierFlags().contains(NSEventModifierFlags::Command) {
            let view = PANES.with(|panes| Some(panes.try_borrow().ok()?.get(&id)?.view.webview()));
            let typed = event.charactersIgnoringModifiers().map(|typed| typed.to_string());
            if let Some((view, typed)) = view.zip(typed) {
                // SAFETY: plain property access on a live view, on the main thread.
                unsafe {
                    if let Some(zoom) = zoomed(view.pageZoom(), &typed) {
                        view.setPageZoom(zoom);
                    }
                }
            }
        }
        let flags = event.modifierFlags().bits() as u64;
        let Some(key) = pressed(kind == NSEventType::FlagsChanged, event.keyCode(), flags) else { return };
        let mut state = left.take();
        if dual_tap(&mut state, key, event.timestamp() * 1000.0) {
            emit(app, &owner, &id, "leader", json!({}));
        }
        left.set(state);
    }

    /// The page zoom a ⌘ chord asks for, as a browser has it: `=` in, `-` out,
    /// `0` back to actual size. The page hears the chord as well.
    fn zoomed(zoom: f64, typed: &str) -> Option<f64> {
        match typed {
            "=" | "+" => Some((zoom * 1.1).min(3.0)),
            "-" => Some((zoom / 1.1).max(0.3)),
            "0" => Some(1.0),
            _ => None,
        }
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

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::rc::Rc;
        use Key::*;

        #[test]
        fn a_snapshot_is_capped_on_its_longest_side() {
            assert_eq!(snapshot_width(400.0, 300.0, 2.0), 400.0);
            assert_eq!(snapshot_width(800.0, 600.0, 2.0), 800.0);
            assert_eq!(snapshot_width(1600.0, 900.0, 2.0), 800.0);
            // A tall view is capped by its height.
            assert_eq!(snapshot_width(500.0, 1600.0, 1.0), 500.0);
            assert_eq!(snapshot_width(500.0, 3200.0, 1.0), 250.0);
        }

        /// A confirm and a prompt whose handlers log what they are called with.
        fn logged() -> (Rc<RefCell<Vec<String>>>, Dialog, Dialog) {
            let log = Rc::new(RefCell::new(Vec::new()));
            let (confirm, prompt) = (log.clone(), log.clone());
            let confirm = RcBlock::new(move |ok: Bool| confirm.borrow_mut().push(format!("confirm {}", ok.as_bool())));
            let prompt = RcBlock::new(move |text: *mut NSString| {
                // SAFETY: the handler is called with a live string or null.
                let text = unsafe { text.as_ref() }.map_or("prompt null".into(), |text| format!("prompt {:?}", text.to_string()));
                prompt.borrow_mut().push(text);
            });
            (log, Dialog(Some(Handler::Confirm(confirm))), Dialog(Some(Handler::Prompt(prompt))))
        }

        #[test]
        fn a_dialog_is_answered_once_and_no_when_dropped() {
            let (log, confirm, prompt) = logged();
            drop((confirm, prompt));
            assert_eq!(*log.borrow(), ["confirm false", "prompt null"]);

            let (log, confirm, prompt) = logged();
            confirm.answer(true, None);
            prompt.answer(true, Some("typed".into()));
            assert_eq!(*log.borrow(), ["confirm true", "prompt \"typed\""]);

            // Cancelled, a prompt returns null whatever was typed; accepted empty, "".
            let (log, confirm, prompt) = logged();
            prompt.answer(false, Some("typed".into()));
            confirm.answer(false, None);
            assert_eq!(*log.borrow(), ["prompt null", "confirm false"]);
            let (log, _confirm, prompt) = logged();
            prompt.answer(true, None);
            assert_eq!(*log.borrow(), ["prompt \"\""]);
        }

        #[test]
        fn the_ui_delegate_answers_every_page_dialog() {
            // Registering the class checks each method takes its selector's arguments.
            let class = Dialogs::class();
            assert!(class.responds_to(objc2::sel!(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:)));
            assert!(class.responds_to(objc2::sel!(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:)));
            assert!(class.responds_to(objc2::sel!(
                webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:
            )));
        }

        #[test]
        fn the_zoom_chords_step_within_bounds_and_reset() {
            assert_eq!(zoomed(1.0, "="), Some(1.1));
            assert_eq!(zoomed(1.0, "+"), Some(1.1));
            assert_eq!(zoomed(1.1, "-"), Some(1.0));
            assert_eq!(zoomed(2.95, "="), Some(3.0));
            assert_eq!(zoomed(0.31, "-"), Some(0.3));
            assert_eq!(zoomed(2.0, "0"), Some(1.0));
            assert_eq!(zoomed(2.0, "f"), None);
        }

        #[test]
        fn a_dialog_reports_bounded_text() {
            let long = NSString::from_str(&"é".repeat(DIALOG_TEXT_MAX + 1));
            assert_eq!(capped(&long), "é".repeat(DIALOG_TEXT_MAX));
            assert_eq!(capped(&NSString::from_str("short")), "short");
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
    use std::{collections::HashMap, ffi::c_void, mem::size_of, rc::Rc, sync::OnceLock};
    use std::{path::{Path, PathBuf}, time::{Duration, Instant}};
    use tauri::{Manager, WebviewWindow};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Settings8, ICoreWebView2_18, COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
        COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
    };
    use webview2_com::{
        take_pwstr, CapturePreviewCompletedHandler, DocumentTitleChangedEventHandler, FocusChangedEventHandler,
        HistoryChangedEventHandler, LaunchingExternalUriSchemeEventHandler, NavigationCompletedEventHandler,
        NavigationStartingEventHandler, NewWindowRequestedEventHandler, SourceChangedEventHandler,
    };
    use windows::core::{w, Error, Interface, BOOL, PSTR, PWSTR};
    use windows::Win32::Foundation::{E_FAIL, HWND, LPARAM, LRESULT, POINT, RECT, RPC_E_CHANGED_MODE, WPARAM};
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_ContainerFormatJpeg, IWICBitmapFrameEncode, IWICBitmapSource,
        IWICImagingFactory, WICBitmapEncoderNoCache, WICBitmapInterpolationModeFant, WICDecodeMetadataCacheOnDemand,
    };
    use windows::Win32::Security::Cryptography::{CryptBinaryToStringA, CRYPT_STRING, CRYPT_STRING_BASE64, CRYPT_STRING_NOCRLF};
    use windows::Win32::System::Com::{StructuredStorage::{IPropertyBag2, PROPBAG2}, IStream, STREAM_SEEK_END, STREAM_SEEK_SET};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Input::{KeyboardAndMouse::GetFocus, GetRawInputData, GetRegisteredRawInputDevices, HRAWINPUT};
    use windows::Win32::UI::Input::{RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER, RID_INPUT, RIM_TYPEKEYBOARD};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SHCreateMemStream, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyWindow, GetAncestor, GetCursorPos, GetForegroundWindow, GetWindowRect, IsChild, KillTimer, SetTimer,
        GA_ROOT, WM_ACTIVATE, WM_INPUT, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_NCDESTROY, WM_PARENTNOTIFY,
        WM_POINTERDOWN, WM_RBUTTONDOWN, WM_SETFOCUS, WM_XBUTTONDOWN,
    };
    use wry::dpi::{LogicalPosition, LogicalSize};
    use wry::{PermissionResponse, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

    /// The navigation in flight when the build returns, which started before
    /// any handler here could hear it: any completion ends it.
    const FIRST_LOAD: u64 = u64::MAX;
    const PRESS_SUBCLASS: usize = 0x646d_7001;
    const WINDOW_SUBCLASS: usize = 0x646d_7002;
    const INPUT_SUBCLASS: usize = 0x646d_7003;
    /// `RAWKEYBOARD.Flags` bits and the overrun code (winuser.h, ntddkbd.h).
    const RI_KEY_BREAK: u16 = 0x1;
    const RI_KEY_E0: u16 = 0x2;
    const KEYBOARD_OVERRUN_MAKE_CODE: u16 = 0xFF;
    /// A snapshot's longest side in pixels: a full high-DPI pane would be
    /// megabytes of base64 for a stand-in.
    const SNAPSHOT_MAX_PX: u32 = 1600;

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
        /// What a pending build loads.
        url: String,
        /// Last reported.
        page: PageState,
        focused: bool,
        /// Wanted bounds; `None` is hidden.
        rect: Option<wry::Rect>,
        /// Applied visibility.
        shown: bool,
        /// Take the keyboard once shown.
        want_focus: bool,
        loading: Rc<Cell<Option<u64>>>,
    }

    thread_local! {
        static PANES: RefCell<HashMap<String, Pane>> = RefCell::default();
        static APP: OnceCell<AppHandle> = const { OnceCell::new() };
        /// The pane that held the keyboard when its window went inactive.
        static RESUME: Cell<Option<String>> = const { Cell::new(None) };
        static LEFT: Cell<Option<(Key, f64)>> = const { Cell::new(None) };
        /// The shown pane the pointer was last over.
        static OVER: Cell<Option<String>> = const { Cell::new(None) };
        static POINTER_TIMER: Cell<usize> = const { Cell::new(0) };
    }
    static EPOCH: OnceLock<Instant> = OnceLock::new();

    /// The registry, briefly: `f` must make no wry, WebView2, or Win32 call.
    /// `None` when it is already borrowed, which a callback skips.
    fn with_panes<T>(f: impl FnOnce(&mut HashMap<String, Pane>) -> T) -> Option<T> {
        PANES.with(|panes| panes.try_borrow_mut().ok().map(|mut panes| f(&mut panes)))
    }

    /// `f` on pane `id` when `webview`'s window owns it, as `with_panes`.
    fn owned<T>(webview: &Webview, id: &str, f: impl FnOnce(&mut Pane) -> T) -> Option<T> {
        let owner = label(webview);
        with_panes(|panes| panes.get_mut(id).filter(|pane| pane.owner == owner).map(f)).flatten()
    }

    fn app() -> Option<AppHandle> {
        APP.with(|app| app.get().cloned())
    }

    fn tell(owner: &str, id: &str, kind: &str, payload: Value) {
        if let Some(app) = app() {
            emit(&app, owner, id, kind, payload);
        }
    }

    /// `f` on the main thread in a later turn. Posted from the main thread,
    /// `run_on_main_thread` would run it inline.
    fn later(f: impl FnOnce() + Send + 'static) {
        if let Some(app) = app() {
            std::thread::spawn(move || app.run_on_main_thread(f).ok());
        }
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

    fn window(owner: &str) -> Result<WebviewWindow, String> {
        app().and_then(|app| app.get_webview_window(owner)).ok_or_else(|| "the window is gone".into())
    }

    pub fn open(webview: Webview, id: String, url: String) -> Result<PageState, String> {
        let _ = APP.with(|cell| cell.set(webview.app_handle().clone()));
        let owner = label(&webview);
        let existing = with_panes(|panes| {
            let pane = panes.get_mut(&id)?;
            let (from, was_shown) = (std::mem::replace(&mut pane.owner, owner.clone()), pane.shown);
            if from != owner && pane.view.is_some() {
                (pane.rect, pane.shown, pane.want_focus) = (None, false, false);
            }
            Some((pane.view.clone(), from, was_shown, pane.loading.clone(), pane.page.clone()))
        })
        .flatten();
        let Some((view, from, was_shown, loading, page)) = existing else {
            if !is_web(&url) {
                return Err(format!("not an http(s) URL: {url}"));
            }
            let (page, loading) = (no_page(true), Rc::new(Cell::new(Some(FIRST_LOAD))));
            let pane = Pane { view: None, owner, url, page, focused: false, rect: None, shown: false, want_focus: false, loading };
            with_panes(|panes| panes.insert(id.clone(), pane));
            // Building inside this command's callback would deadlock.
            later(move || build(&id));
            return Ok(no_page(true));
        };
        // A pending pane's build reparents it.
        let Some(view) = view else { return Ok(page) };
        if from != owner {
            let hwnd = window(&owner)?.hwnd().map_err(|e| e.to_string())?;
            if was_shown {
                hide(&view, &from)?;
            }
            view.reparent(hwnd.0 as isize).map_err(|e| e.to_string())?;
            hook_window(hwnd);
        }
        let page = page_of(&view, &loading, !page.url.is_empty());
        with_panes(|panes| panes.get_mut(&id).map(|pane| pane.page = page.clone()));
        Ok(page)
    }

    /// Installs the view into the pane under `id` that still has none: a close,
    /// reopen, move, or navigation during the build is caught after it.
    fn build(id: &str) {
        let wanted = with_panes(|panes| {
            let pane = panes.get(id).filter(|pane| pane.view.is_none())?;
            Some((pane.owner.clone(), pane.url.clone(), pane.loading.clone()))
        });
        let Some(Some((owner, url, loading))) = wanted else { return };
        let view = match create(id, &owner, &url, &loading) {
            Ok(view) => view,
            Err(error) => return fail(id, &error),
        };
        let now = with_panes(|panes| {
            let pane = panes.get_mut(id).filter(|pane| pane.view.is_none())?;
            (pane.view, pane.loading) = (Some(view.clone()), loading);
            Some((pane.owner.clone(), pane.url.clone()))
        });
        let Some(Some((now_owner, now_url))) = now else { return dispose(&view, None) };
        let hwnd = match window(&now_owner).and_then(|window| window.hwnd().map_err(|e| e.to_string())) {
            Ok(hwnd) => hwnd,
            Err(error) => return fail(id, &error),
        };
        if now_owner != owner {
            if let Err(error) = view.reparent(hwnd.0 as isize) {
                return fail(id, &error.to_string());
            }
        }
        hook_window(hwnd);
        hook_input();
        if now_url != url {
            let _ = view.load_url(&now_url);
        }
        let _ = apply(id);
        sync();
    }

    /// A pane whose build failed is gone, and its panel hears that it did not load.
    fn fail(id: &str, error: &str) {
        crate::append_log(format!("[pane-webview] {id} did not build: {error}"));
        let Some(Some(pane)) = with_panes(|panes| panes.remove(id)) else { return };
        if let Some(view) = &pane.view {
            dispose(view, None);
        }
        tell(&pane.owner, id, "page", serde_json::to_value(no_page(false)).unwrap_or_default());
    }

    fn create(id: &str, owner: &str, url: &str, loading: &Rc<Cell<Option<u64>>>) -> Result<Rc<WebView>, String> {
        let window = window(owner)?;
        let local = window.path().app_local_data_dir().map_err(|e| e.to_string())?;
        // Contexts on one directory share one profile and one browser process.
        let mut context = WebContext::new(Some(profile_dir(&local)));
        let view = WebViewBuilder::new_with_web_context(&mut context)
            .with_url(url)
            .with_visible(false)
            // wry focuses a new view by default, taking the keyboard.
            .with_focused(false)
            // wry turns devtools on in a debug build.
            .with_devtools(false)
            .with_clipboard(false)
            .with_navigation_handler(|url| may_load(&url))
            // wry allows a download when no handler says otherwise.
            .with_download_started_handler(|_, _| false)
            .with_permission_handler(|_| PermissionResponse::Deny)
            // SmartScreen sends every visited URL to Microsoft.
            .with_additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection")
            .build_as_child(&window)
            .map_err(|e| e.to_string())?;
        let view = Rc::new(view);
        // Never let a pane view drop: wry's `Drop` for a child sends its parent
        // the message that removes the APP webview's own subclass there, after
        // which the app webview no longer follows window resizes or takes the
        // keyboard on activation. `dispose` closes one instead.
        std::mem::forget(Rc::clone(&view));
        // SAFETY: a live view, on the main thread.
        if let Err(error) = unsafe { guard(id, &view, loading) } {
            dispose(&view, None);
            return Err(format!("could not secure the page: {error}"));
        }
        Ok(view)
    }

    /// What wry's builder cannot set, and the handlers that report a page's
    /// state; a view any of them fails on never shows.
    unsafe fn guard(id: &str, view: &WebView, loading: &Rc<Cell<Option<u64>>>) -> windows::core::Result<()> {
        let core = view.webview();
        let controller = view.controller();
        let mut token = Default::default();
        // With no handler of its own wry refuses every new window; its builder
        // hides `IsUserInitiated`. A page raises the new-pane prompt only from a press.
        let id = id.to_string();
        core.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                args.SetHandled(true)?;
                let (mut user, mut uri) = (BOOL::default(), PWSTR::null());
                args.Uri(&mut uri)?;
                let url = take_pwstr(uri);
                args.IsUserInitiated(&mut user)?;
                if user.as_bool() && is_web(&url) {
                    let owner = with_panes(|panes| panes.get(&id).map(|pane| pane.owner.clone())).flatten();
                    if let Some(owner) = owner {
                        tell(&owner, &id, "open-window", json!({ "url": url }));
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
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

        let cell = loading.clone();
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
                sync();
                Ok(())
            })),
            &mut token,
        )?;
        let cell = loading.clone();
        core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut navigation = 0;
                    args.NavigationId(&mut navigation)?;
                    if matches!(cell.get(), Some(current) if current == navigation || current == FIRST_LOAD) {
                        cell.set(None);
                    }
                }
                sync();
                Ok(())
            })),
            &mut token,
        )?;
        macro_rules! on_change {
            ($object:ident, $add:ident, $handler:ident) => {
                $object.$add(&$handler::create(Box::new(|_, _| { sync(); Ok(()) })), &mut token)?
            };
        }
        on_change!(core, add_SourceChanged, SourceChangedEventHandler);
        on_change!(core, add_HistoryChanged, HistoryChangedEventHandler);
        on_change!(core, add_DocumentTitleChanged, DocumentTitleChangedEventHandler);
        // Focus is read in `sync`, not heard: these events come in bursts and pairs.
        on_change!(controller, add_GotFocus, FocusChangedEventHandler);
        on_change!(controller, add_LostFocus, FocusChangedEventHandler);
        if !SetWindowSubclass(view.hwnd(), Some(subclass), PRESS_SUBCLASS, 0).as_bool() {
            return Err(E_FAIL.into());
        }
        Ok(())
    }

    /// Close a view without dropping it (see `create`). A closed view that
    /// held the keyboard leaves it nowhere: `refocus` names its owner, whose
    /// app webview then takes it.
    fn dispose(view: &WebView, refocus: Option<&str>) {
        let held = refocus.is_some() && thread_focus_in(view.hwnd());
        // SAFETY: a live controller, on the main thread. The container may
        // already be gone with its window.
        unsafe {
            let _ = view.controller().Close();
            let _ = DestroyWindow(view.hwnd());
        }
        if let Some(owner) = refocus.filter(|_| held) {
            focus_app(owner);
        }
    }

    /// Bring a built view to its wanted bounds, visibility, and focus.
    fn apply(id: &str) -> Result<(), String> {
        let found = with_panes(|panes| {
            let pane = panes.get_mut(id)?;
            let view = pane.view.clone()?;
            let was_shown = std::mem::replace(&mut pane.shown, pane.rect.is_some());
            let focus = pane.shown && std::mem::take(&mut pane.want_focus);
            Some((view, pane.owner.clone(), pane.rect, was_shown, focus))
        });
        let Some(Some((view, owner, rect, was_shown, focus))) = found else { return Ok(()) };
        let Some(rect) = rect else { return if was_shown { hide(&view, &owner) } else { Ok(()) } };
        view.set_bounds(rect).map_err(|e| e.to_string())?;
        if !was_shown {
            view.set_visible(true).map_err(|e| e.to_string())?;
            if POINTER_TIMER.get() == 0 {
                // SAFETY: a thread timer, ticking on this thread's message loop.
                POINTER_TIMER.set(unsafe { SetTimer(None, 0, 50, Some(pointer_tick)) });
            }
        }
        if focus {
            move_focus(&view);
        }
        Ok(())
    }

    /// A hidden view keeps the keyboard it held, and keys typed then are lost.
    fn hide(view: &WebView, owner: &str) -> Result<(), String> {
        let held = thread_focus_in(view.hwnd());
        // `SetIsVisible(false)`, inside, is what throttles the page.
        view.set_visible(false).map_err(|e| e.to_string())?;
        if held {
            focus_app(owner);
        }
        Ok(())
    }

    pub fn place(webview: Webview, id: String, rect: Option<Rect>) -> Result<(), String> {
        let rect = rect.map(|Rect { x, y, width, height }| wry::Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width, height).into(),
        });
        match owned(&webview, &id, |pane| pane.rect = rect) {
            Some(()) => apply(&id),
            None => Ok(()),
        }
    }

    pub fn navigate(webview: Webview, id: String, url: String) -> Result<(), String> {
        if !is_web(&url) {
            return Err(format!("not an http(s) URL: {url}"));
        }
        let view = owned(&webview, &id, |pane| {
            pane.url = url.clone();
            pane.view.clone()
        });
        view.flatten().map_or(Ok(()), |view| view.load_url(&url).map_err(|e| e.to_string()))
    }

    pub fn history(webview: Webview, id: String, dir: String) -> Result<(), String> {
        let Some(view) = owned(&webview, &id, |pane| pane.view.clone()) else { return Ok(()) };
        let go: fn(&WebView) -> wry::Result<()> = match dir.as_str() {
            "back" => WebView::go_back,
            "forward" => WebView::go_forward,
            "reload" => WebView::reload,
            _ => return Err(format!("unknown history direction: {dir}")),
        };
        view.map_or(Ok(()), |view| go(&view).map_err(|e| e.to_string()))
    }

    pub fn focus(webview: Webview, id: Option<String>, from: Option<String>) -> Result<(), String> {
        RESUME.set(None);
        if let Some(id) = id {
            // A hidden view never holds focus: this waits for the `place` that shows it.
            let view = owned(&webview, &id, |pane| {
                pane.want_focus = !pane.shown;
                pane.view.clone().filter(|_| pane.shown)
            });
            if let Some(Some(view)) = view {
                move_focus(&view);
            }
            // A focus event arrives before `GetFocus` has moved, so the look
            // it prompts sees the old holder; this one sees the new.
            sync();
            return Ok(());
        }
        // Its successor may hold the keyboard already, and must keep it.
        let owner = label(&webview);
        let views = with_panes(|panes| {
            let mine = panes.iter_mut().filter(|(pane_id, pane)| pane.owner == owner && from.as_ref().is_none_or(|from| from == *pane_id));
            mine.filter_map(|(_, pane)| {
                pane.want_focus = false;
                pane.view.clone()
            })
            .collect::<Vec<_>>()
        });
        // A focus move onto the app webview when it already has the keyboard
        // would blur and refocus its document.
        if views.unwrap_or_default().iter().any(|view| thread_focus_in(view.hwnd())) {
            focus_app(&owner);
        }
        sync();
        Ok(())
    }

    pub fn close(webview: Webview, id: String) -> Result<(), String> {
        let owner = label(&webview);
        remove(|pane_id, pane| pane_id == id && pane.owner == owner, true);
        Ok(())
    }

    pub fn reset(webview: Webview) -> Result<(), String> {
        let owner = label(&webview);
        remove(|_, pane| pane.owner == owner, true);
        Ok(())
    }

    /// WebView2 shows a page's dialogs itself.
    pub fn answer(_: Webview, _: String, _: bool, _: Option<String>) -> Result<(), String> {
        Ok(())
    }

    /// On a pool thread: the main thread only starts the capture and copies
    /// its bytes out; decoding, scaling, and encoding happen here.
    pub fn snapshot(webview: Webview, id: String) -> Result<String, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let app = webview.app_handle().clone();
        app.run_on_main_thread(move || {
            // A hidden view cannot be captured: its capture completes only once it is shown again.
            let Some(Some(view)) = owned(&webview, &id, |pane| pane.view.clone().filter(|_| pane.shown)) else {
                let _ = tx.send(None);
                return;
            };
            // SAFETY: an in-memory stream, and a call on a live webview, on the main thread.
            unsafe {
                let Some(stream) = SHCreateMemStream(None) else { return };
                let out = stream.clone();
                // Runs later, on the main thread; dropped unsent on a failure.
                let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                    if let Ok(bytes) = result.and_then(|()| stream_bytes(&out)) {
                        let _ = tx.send(Some(bytes));
                    }
                    Ok(())
                }));
                // PNG is lossless into the one JPEG encode.
                let _ = view.webview().CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler);
            }
        })
        .map_err(|e| e.to_string())?;
        let bytes = rx.recv_timeout(Duration::from_secs(2)).map_err(|_| "no snapshot")?.ok_or("no such pane webview")?;
        jpeg_data_url(&bytes).map_err(|_| "no snapshot".into())
    }

    /// Every byte of `stream`, from its start; a memory stream answers one `Read` in full.
    unsafe fn stream_bytes(stream: &IStream) -> windows::core::Result<Vec<u8>> {
        let mut size = 0u64;
        stream.Seek(0, STREAM_SEEK_END, Some(&mut size))?;
        stream.Seek(0, STREAM_SEEK_SET, None)?;
        let (mut bytes, mut read) = (vec![0u8; size as usize], 0u32);
        stream.Read(bytes.as_mut_ptr().cast(), size as u32, Some(&mut read)).ok()?;
        bytes.truncate(read as usize);
        Ok(bytes)
    }

    /// `width` by `height` pixels, capped at `SNAPSHOT_MAX_PX` on the longest
    /// side with the aspect kept; never 0.
    fn snapshot_size(width: u32, height: u32) -> (u32, u32) {
        let longest = width.max(height);
        if longest <= SNAPSHOT_MAX_PX {
            return (width.max(1), height.max(1));
        }
        let scale = |side: u32| {
            let scaled = (u64::from(side) * u64::from(SNAPSHOT_MAX_PX) + u64::from(longest) / 2) / u64::from(longest);
            (scaled as u32).max(1)
        };
        (scale(width), scale(height))
    }

    /// The capture as a JPEG data URL.
    fn jpeg_data_url(image: &[u8]) -> windows::core::Result<String> {
        // SAFETY: COM on this pool thread, balanced below when this call initialized it.
        let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
            return Err(initialized.into());
        }
        // SAFETY: WIC objects created and used on this thread only.
        let jpeg = unsafe { encode_jpeg(image) };
        if initialized.is_ok() {
            // SAFETY: balances the successful `CoInitializeEx` above, S_FALSE included.
            unsafe { CoUninitialize() };
        }
        let (jpeg, flags) = (jpeg?, CRYPT_STRING(CRYPT_STRING_BASE64.0 | CRYPT_STRING_NOCRLF));
        let mut size = 0;
        // SAFETY: the first call sizes the text, terminator included; the second fills it.
        unsafe {
            CryptBinaryToStringA(&jpeg, flags, None, &mut size).ok()?;
            let mut text = vec![0u8; size as usize];
            CryptBinaryToStringA(&jpeg, flags, Some(PSTR(text.as_mut_ptr())), &mut size).ok()?;
            text.truncate(size as usize);
            Ok(format!("data:image/jpeg;base64,{}", String::from_utf8_lossy(&text)))
        }
    }

    unsafe fn encode_jpeg(image: &[u8]) -> windows::core::Result<Vec<u8>> {
        let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let input = SHCreateMemStream(Some(image)).ok_or_else(|| Error::from(E_FAIL))?;
        let frame = factory.CreateDecoderFromStream(&input, std::ptr::null(), WICDecodeMetadataCacheOnDemand)?.GetFrame(0)?;
        let (mut width, mut height) = (0, 0);
        frame.GetSize(&mut width, &mut height)?;
        let (out_width, out_height) = snapshot_size(width, height);
        let source: IWICBitmapSource = if (out_width, out_height) == (width, height) {
            frame.cast()?
        } else {
            let scaler = factory.CreateBitmapScaler()?;
            scaler.Initialize(&frame, out_width, out_height, WICBitmapInterpolationModeFant)?;
            scaler.cast()?
        };
        let output = SHCreateMemStream(None).ok_or_else(|| Error::from(E_FAIL))?;
        let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
        encoder.Initialize(&output, WICBitmapEncoderNoCache)?;
        let (mut target, mut options): (Option<IWICBitmapFrameEncode>, Option<IPropertyBag2>) = (None, None);
        encoder.CreateNewFrame(&mut target, &mut options)?;
        let (target, options) = target.zip(options).ok_or_else(|| Error::from(E_FAIL))?;
        let name = PROPBAG2 { pstrName: PWSTR(w!("ImageQuality").as_ptr().cast_mut()), ..Default::default() };
        options.Write(1, &name, &VARIANT::from(0.7f32))?;
        target.Initialize(&options)?;
        // Takes its size and pixel format from the source.
        target.WriteSource(&source, std::ptr::null())?;
        target.Commit()?;
        encoder.Commit()?;
        stream_bytes(&output)
    }

    /// The window is gone, so nothing is left to focus.
    pub fn forget_window(app: &AppHandle, label: &str) {
        let label = label.to_string();
        let _ = app.run_on_main_thread(move || remove(|_, pane| pane.owner == label, false));
    }

    pub fn close_all(app: &AppHandle) {
        let _ = app.run_on_main_thread(|| remove(|_, _| true, false));
    }

    /// A pending pane just leaves the registry: its build finds it gone.
    fn remove(doomed: impl Fn(&str, &Pane) -> bool, refocus: bool) {
        let gone = with_panes(|panes| {
            let (gone, kept): (HashMap<_, _>, _) = std::mem::take(panes).into_iter().partition(|(id, pane)| doomed(id, pane));
            *panes = kept;
            gone
        });
        for pane in gone.unwrap_or_default().into_values() {
            if let Some(view) = &pane.view {
                dispose(view, refocus.then_some(pane.owner.as_str()));
            }
        }
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

    /// A move onto a view that already has the keyboard fires a spurious
    /// lost-and-got pair.
    fn move_focus(view: &WebView) {
        if !thread_focus_in(view.hwnd()) {
            // SAFETY: a live controller, on the main thread.
            let _ = unsafe { view.controller().MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) };
        }
    }

    /// Give the keyboard to a window's app webview; its document keeps its
    /// `activeElement`. The pane hears no focus event from this.
    fn focus_app(owner: &str) {
        if let Ok(window) = window(owner) {
            let _ = window.with_webview(|platform| {
                // SAFETY: the live app controller, on the main thread.
                let _ = unsafe { platform.controller().MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) };
            });
        }
        sync();
    }

    /// `had_page`: whether this view has reported a URL before.
    fn page_of(view: &WebView, loading: &Cell<Option<u64>>, had_page: bool) -> PageState {
        let core = view.webview();
        // SAFETY: plain property reads on a live webview, on the main thread.
        let (source, title) = unsafe {
            let (mut source, mut title) = (PWSTR::null(), PWSTR::null());
            let source = core.Source(&mut source).map(|_| take_pwstr(source)).unwrap_or_default();
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

    /// Report every page and focus change since the last call.
    fn sync() {
        let views = with_panes(|panes| {
            let built = |(id, pane): (&String, &Pane)| Some((id.clone(), pane.view.clone()?, pane.loading.clone(), !pane.page.url.is_empty()));
            panes.iter().filter_map(built).collect::<Vec<_>>()
        });
        let seen: Vec<_> = (views.unwrap_or_default().into_iter())
            .map(|(id, view, loading, had_page)| {
                let (page, front) = (page_of(&view, &loading, had_page), in_front(view.hwnd()));
                (id, page, front && thread_focus_in(view.hwnd()), front, view)
            })
            .collect();
        let events = with_panes(|panes| {
            let mut events = Vec::new();
            for (id, page, focused, front, view) in seen {
                let mine = |pane: &&mut Pane| pane.view.as_ref().is_some_and(|built| Rc::ptr_eq(built, &view));
                let Some(pane) = panes.get_mut(&id).filter(mine) else { continue };
                if page != pane.page {
                    events.push((pane.owner.clone(), id.clone(), "page", serde_json::to_value(&page).unwrap_or_default()));
                    pane.page = page;
                }
                if focused != pane.focused {
                    if pane.focused && !front {
                        RESUME.set(Some(id.clone()));
                    }
                    events.push((pane.owner.clone(), id.clone(), "focus", json!({ "focused": focused })));
                    pane.focused = focused;
                }
            }
            events
        });
        for (owner, id, kind, payload) in events.unwrap_or_default() {
            tell(&owner, &id, kind, payload);
        }
    }

    /// Each owner window: wry's subclass there forwards every `WM_SETFOCUS`
    /// to the app webview, so a window coming back to the front would take
    /// the keyboard from the pane that had it.
    fn hook_window(window: HWND) {
        // SAFETY: a window of this thread.
        let _ = unsafe { SetWindowSubclass(window, Some(subclass), WINDOW_SUBCLASS, 0) };
    }

    /// No key reaches a window of this process while a webview has the
    /// keyboard, and the page sees the leader's Shift taps too late to stop
    /// them. tao registers keyboard Raw Input without `RIDEV_INPUTSINK`, which
    /// delivers every key while this process is in front and none otherwise:
    /// observe it on tao's target window.
    fn hook_input() {
        let size = size_of::<RAWINPUTDEVICE>() as u32;
        let mut count = 0;
        // SAFETY: the first call only counts; the second fills `count` entries.
        unsafe {
            GetRegisteredRawInputDevices(None, &mut count, size);
            let mut devices = vec![RAWINPUTDEVICE::default(); count as usize];
            GetRegisteredRawInputDevices(Some(devices.as_mut_ptr()), &mut count, size);
            if let Some(device) = devices.iter().find(|device| device.usUsagePage == 1 && device.usUsage == 6) {
                let _ = SetWindowSubclass(device.hwndTarget, Some(subclass), INPUT_SUBCLASS, 0);
            }
        }
    }

    unsafe extern "system" fn subclass(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, kind: usize, _: usize) -> LRESULT {
        match (kind, msg) {
            (_, WM_NCDESTROY) => {
                let _ = RemoveWindowSubclass(hwnd, Some(subclass), kind);
            }
            // A press anywhere in a view reaches its container as this, once,
            // whether or not the view had the keyboard; the same message also
            // reports child windows created and destroyed.
            (PRESS_SUBCLASS, WM_PARENTNOTIFY) if matches!(
                (wparam.0 & 0xffff) as u32,
                WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN | WM_POINTERDOWN
            ) => {
                let mine = |(_, pane): &(&String, &Pane)| pane.view.as_ref().is_some_and(|view| view.hwnd() == hwnd);
                let hit = with_panes(|panes| panes.iter().find(mine).map(|(id, pane)| (id.clone(), pane.owner.clone())));
                if let Some(Some((id, owner))) = hit {
                    tell(&owner, &id, "pointerdown", json!({}));
                }
            }
            // Another app can come to the front with no focus event from the
            // view, and the foreground window only changes after this
            // message: look again a turn later.
            (WINDOW_SUBCLASS, WM_ACTIVATE) => later(sync),
            (WINDOW_SUBCLASS, WM_SETFOCUS) => {
                // wry's subclass, below this one, gives the app webview the keyboard.
                let result = DefSubclassProc(hwnd, msg, wparam, lparam);
                if let Some(id) = RESUME.take() {
                    let view = with_panes(|panes| panes.get(&id).filter(|pane| pane.shown)?.view.clone()).flatten();
                    match view {
                        Some(view) if GetAncestor(view.hwnd(), GA_ROOT) == hwnd => move_focus(&view),
                        Some(_) => RESUME.set(Some(id)),
                        None => {}
                    }
                }
                sync();
                return result;
            }
            // RIM_INPUT: while this process is in front. Reading it leaves it for tao.
            (INPUT_SUBCLASS, WM_INPUT) if wparam.0 & 0xff == 0 => on_raw_input(HRAWINPUT(lparam.0 as *mut c_void)),
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    fn on_raw_input(input: HRAWINPUT) {
        // tao's target hears the mouse too: with no pane holding the keyboard, read nothing.
        let holder = with_panes(|panes| {
            panes.iter().find(|(_, pane)| pane.focused).map(|(id, pane)| (id.clone(), pane.owner.clone()))
        });
        let Some(Some((id, owner))) = holder else { return LEFT.set(None) };
        let mut raw = RAWINPUT::default();
        let mut size = size_of::<RAWINPUT>() as u32;
        let header = size_of::<RAWINPUTHEADER>() as u32;
        // SAFETY: `raw` is large enough for keyboard and mouse input; a larger
        // report fails the read.
        let read = unsafe { GetRawInputData(input, RID_INPUT, Some(&mut raw as *mut RAWINPUT as *mut c_void), &mut size, header) };
        if read == u32::MAX || raw.header.dwType != RIM_TYPEKEYBOARD.0 {
            return;
        }
        // SAFETY: the header says keyboard.
        let keyboard = unsafe { raw.data.keyboard };
        let Some(key) = pressed(keyboard.MakeCode, keyboard.Flags) else { return };
        let now = EPOCH.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0;
        let mut left = LEFT.take();
        let leader = dual_tap(&mut left, key, now);
        LEFT.set(left);
        if leader {
            tell(&owner, &id, "leader", json!({}));
        }
    }

    /// `pointerleave` once the pointer is off the shown view it was over. No
    /// mouse message or mouse Raw Input reaches this process from over a
    /// view, so while any view is shown this ticks and looks.
    unsafe extern "system" fn pointer_tick(_: HWND, _: u32, timer: usize, _: u32) {
        let shown = with_panes(|panes| {
            let shown = panes.iter().filter(|(_, pane)| pane.shown);
            shown.filter_map(|(id, pane)| Some((id.clone(), pane.owner.clone(), pane.view.as_ref()?.hwnd()))).collect::<Vec<_>>()
        });
        let Some(shown) = shown else { return };
        if shown.is_empty() {
            let _ = KillTimer(None, timer);
            POINTER_TIMER.set(0);
            return OVER.set(None);
        }
        let mut point = POINT::default();
        // Screen pixels both, in this per-monitor-aware process.
        let found = GetCursorPos(&mut point).is_ok();
        let hit = shown.iter().find(|(.., container)| {
            let mut rect = RECT::default();
            let inside = |rect: RECT| (rect.left..rect.right).contains(&point.x) && (rect.top..rect.bottom).contains(&point.y);
            found && GetWindowRect(*container, &mut rect).is_ok() && inside(rect)
        });
        let was = OVER.replace(hit.map(|(id, ..)| id.clone()));
        let left = shown.iter().find(|(id, ..)| was.as_ref() == Some(id) && hit.is_none_or(|(hit, ..)| hit != id));
        if let Some((id, owner, _)) = left {
            tell(owner, id, "pointerleave", json!({}));
        }
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

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::Win32::Graphics::Imaging::{
            GUID_ContainerFormatPng, GUID_WICPixelFormat32bppBGRA, WICBitmapCacheOnDemand,
        };
        use Key::*;

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

        #[test]
        fn a_snapshot_is_capped_on_its_longest_side() {
            assert_eq!(snapshot_size(800, 600), (800, 600));
            assert_eq!(snapshot_size(1600, 900), (1600, 900));
            assert_eq!(snapshot_size(3200, 1800), (1600, 900));
            // A tall view is capped by its height.
            assert_eq!(snapshot_size(1000, 3200), (500, 1600));
            // Rounded, never 0.
            assert_eq!(snapshot_size(3000, 1001), (1600, 534));
            assert_eq!(snapshot_size(100_000, 1), (1600, 1));
            assert_eq!(snapshot_size(0, 0), (1, 1));
        }

        #[test]
        fn a_capture_becomes_a_capped_jpeg() {
            // SAFETY: COM on this test thread, and WIC objects used on it only.
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).unwrap();
                // A BGRA PNG, as WebView2 captures.
                let png = |width, height| {
                    let bitmap = factory.CreateBitmap(width, height, &GUID_WICPixelFormat32bppBGRA, WICBitmapCacheOnDemand).unwrap();
                    let (stream, encoder) = (SHCreateMemStream(None).unwrap(), factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null()).unwrap());
                    encoder.Initialize(&stream, WICBitmapEncoderNoCache).unwrap();
                    let mut frame = None;
                    encoder.CreateNewFrame(&mut frame, std::ptr::null_mut()).unwrap();
                    let frame = frame.unwrap();
                    frame.Initialize(None).unwrap();
                    frame.WriteSource(&bitmap, std::ptr::null()).unwrap();
                    frame.Commit().unwrap();
                    encoder.Commit().unwrap();
                    stream_bytes(&stream).unwrap()
                };
                let jpeg = encode_jpeg(&png(3200, 16)).unwrap();
                assert_eq!(&jpeg[..3], &[0xFF, 0xD8, 0xFF]);
                let input = SHCreateMemStream(Some(&jpeg)).unwrap();
                let decoder = factory.CreateDecoderFromStream(&input, std::ptr::null(), WICDecodeMetadataCacheOnDemand).unwrap();
                let (mut width, mut height) = (0, 0);
                decoder.GetFrame(0).unwrap().GetSize(&mut width, &mut height).unwrap();
                assert_eq!((width, height), (1600, 8));
                let url = jpeg_data_url(&png(4, 4)).unwrap();
                assert!(url.starts_with("data:image/jpeg;base64,/9j/") && !url.contains(['\r', '\n', '\0']), "{url}");
            }
        }
    }
}
