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
//!
//! The terminate is held (`NSTerminateLater`), never refused: a Cancel aborts a
//! logout outright. AppKit's nested wait ignores tao's `[NSApp stop:]`, so every
//! exit while held must answer through `answer_held` (docs/specs/standalone.md
//! -> "Trigger interception"; rationale).

use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{ffi, msg_send, sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::AppHandle;

use crate::{append_log, exit_after_cleanup, forget_restart, quit_approved, request_quit, QuitIntent};

/// The handle the spliced method answers on behalf of. Set once, at `Ready`.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// AppKit is parked in `terminate:` awaiting our reply. AppKit never asks again
/// while one is pending, so at most one is held.
static HELD: AtomicBool = AtomicBool::new(false);

/// `NSUInteger (*)(id, SEL, id)` — the encoding AppKit expects for
/// `applicationShouldTerminate:`. Informational for a direct `objc_msgSend`,
/// which is how AppKit calls this, but the runtime stores it and forwarding
/// machinery reads it.
const SHOULD_TERMINATE_TYPES: &[u8] = b"L@:@\0";

/// Our `applicationShouldTerminate:`.
///
/// Holds the terminate and starts the flow, whose exit or cancel answers it.
/// An approved pass is the OS asking while an exit already under way waits on
/// the bounded hand-back cleanup gate: `Now` once the gate permits, else held
/// for the gate's own exit. Panic-free by construction: every Rust panic aborts
/// (`panic_policy`), and this runs inside AppKit's stack.
unsafe extern "C-unwind" fn should_terminate(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> NSApplicationTerminateReply {
    let Some(app) = APP.get() else {
        // Nothing is managed yet, so there is no session to lose.
        return NSApplicationTerminateReply::TerminateNow;
    };
    let approved = quit_approved(app);
    if approved && exit_after_cleanup(app) {
        // A terminate the OS asked for never relaunches.
        forget_restart(app);
        return NSApplicationTerminateReply::TerminateNow;
    }
    // Held before the flow starts: a flow with no window to ask exits at once.
    HELD.store(true, Ordering::SeqCst);
    if !approved {
        append_log("[quit] holding an AppKit terminate (Dock, logout, or script) for the quit flow");
        request_quit(app, QuitIntent::default());
    }
    NSApplicationTerminateReply::TerminateLater
}

/// Answer a held terminate, if one is held, and say whether one was. Yes lets
/// AppKit finish the exit (`applicationWillTerminate:` still raises
/// `RunEvent::Exit`); No cancels it and the app keeps running.
pub fn answer_held(app: &AppHandle, proceed: bool) -> bool {
    if !HELD.swap(false, Ordering::SeqCst) {
        return false;
    }
    if proceed {
        // A terminate the OS asked for never relaunches.
        forget_restart(app);
    }
    append_log(format!("[quit] answering the held AppKit terminate: {}", if proceed { "quit" } else { "cancel" }));
    // Runs inline when already on the main thread, as both callers are.
    if let Err(err) = app.run_on_main_thread(move || {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(proceed);
        }
    }) {
        append_log(format!("[quit] could not answer the held AppKit terminate: {err}"));
    }
    true
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
