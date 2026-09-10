//! The macOS quit triggers nothing else catches.
//!
//! Tauri's `RunEvent::ExitRequested` is raised from tao's window handling, and
//! tao's app delegate implements only `applicationWillTerminate:` — by which
//! point AppKit has decided and nothing may refuse. So the Dock's Quit item, an
//! `osascript` quit, and a logout or restart all end the process without the
//! quit flow ever running: no confirmation, no agent-recovery capture, no final
//! save (docs/specs/standalone.md -> "Trigger interception"; rationale).
//!
//! This splices `applicationShouldTerminate:` onto the live delegate's class, so
//! those triggers land in `request_quit` like every other one. The app-menu item
//! and its `Cmd+Q` accelerator are handled separately, by the custom menu item
//! `lib.rs` builds in place of `PredefinedMenuItem::quit`.

use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{ffi, msg_send, sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use std::sync::OnceLock;
use tauri::AppHandle;

use crate::{append_log, quit_approved, request_quit};

/// The handle the spliced method answers on behalf of. Set once, at `Ready`.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// `NSUInteger (*)(id, SEL, id)` — the encoding AppKit expects for
/// `applicationShouldTerminate:`. Informational for a direct `objc_msgSend`,
/// which is how AppKit calls this, but the runtime stores it and forwarding
/// machinery reads it.
const SHOULD_TERMINATE_TYPES: &[u8] = b"L@:@\0";

/// Our `applicationShouldTerminate:`.
///
/// Answers `Cancel` and starts the flow the first time; the flow's own
/// `app.exit(0)` comes back through here with the quit already approved, and
/// that pass answers `Now`. Panic-free by construction: the release profile
/// aborts on unwind, and this runs inside AppKit's stack.
unsafe extern "C-unwind" fn should_terminate(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> NSApplicationTerminateReply {
    let Some(app) = APP.get() else {
        // Nothing is managed yet, so there is no session to lose.
        return NSApplicationTerminateReply::TerminateNow;
    };
    if quit_approved(app) {
        return NSApplicationTerminateReply::TerminateNow;
    }
    append_log("[quit] intercepted an AppKit terminate (Dock, logout, or script)");
    request_quit(app);
    NSApplicationTerminateReply::TerminateCancel
}

/// Install the interception. Call once, from `RunEvent::Ready`, where tao's
/// delegate is already the application's.
pub fn install(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        append_log("[quit] terminate interception skipped: not on the main thread");
        return;
    };
    let ns_app = NSApplication::sharedApplication(mtm);
    let delegate: *mut AnyObject = unsafe { msg_send![&*ns_app, delegate] };
    if delegate.is_null() {
        append_log("[quit] terminate interception skipped: the app has no delegate");
        return;
    }
    let selector = sel!(applicationShouldTerminate:);
    let class = unsafe { ffi::object_getClass(delegate) } as *mut AnyClass;
    if class.is_null() {
        append_log("[quit] terminate interception skipped: the delegate has no class");
        return;
    }
    // `class_addMethod` refuses when the class already implements the selector,
    // which is the signal that a tao upgrade started handling this itself — at
    // which point ours would be dead code rather than a second answer.
    let imp: Imp = unsafe { std::mem::transmute(should_terminate as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> NSApplicationTerminateReply) };
    let added = unsafe {
        ffi::class_addMethod(
            class,
            selector,
            imp,
            SHOULD_TERMINATE_TYPES.as_ptr().cast(),
        )
    };
    if added.as_bool() {
        append_log("[quit] AppKit terminate interception installed");
    } else {
        append_log(
            "[quit] WARNING could not install AppKit terminate interception; \
             Dock Quit and logout will bypass the quit flow",
        );
    }
}
