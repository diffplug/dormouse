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
//! The terminate is *held* (`NSTerminateLater`), never refused: a Cancel is
//! AppKit's "the user declined", which aborts a logout or restart outright and
//! leaves loginwindow half done. While held, AppKit spins a nested run loop in
//! `NSModalPanelRunLoopMode` until `replyToApplicationShouldTerminate:`; tao's
//! observers and wake source sit in the common modes, so the quit flow and its
//! confirmation keep running inside it. That nested loop also swallows tao's
//! own exit (`[NSApp stop:]` ends only the outer loop), so **every** exit while
//! held must go through `answer_held` instead — the `RunEvent::ExitRequested`
//! arm does, and `quit_cancel` answers No.

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
/// Holds the terminate and starts the flow the first time; the flow's exit or
/// cancel answers it (`answer_held`). An approved pass is the OS asking while
/// an exit already under way waits on the bounded hand-back cleanup gate: it
/// answers `Now` once the gate permits, else holds for the gate's own exit.
/// Panic-free by construction: every Rust panic aborts (`panic_policy`), and
/// this runs inside AppKit's stack.
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
        // A terminate the OS asked for never relaunches.
        forget_restart(app);
        if exit_after_cleanup(app) {
            return NSApplicationTerminateReply::TerminateNow;
        }
        HELD.store(true, Ordering::SeqCst);
        return NSApplicationTerminateReply::TerminateLater;
    }
    append_log("[quit] holding an AppKit terminate (Dock, logout, or script) for the quit flow");
    // Held before the flow starts: a flow with no window to ask exits at once.
    HELD.store(true, Ordering::SeqCst);
    request_quit(app, QuitIntent::default());
    NSApplicationTerminateReply::TerminateLater
}

/// Answer a held terminate, if one is held, and say whether one was.
///
/// `true` lets AppKit finish the exit itself: it returns from `terminate:`,
/// calls `applicationWillTerminate:`, which tao turns into `RunEvent::Exit`, and
/// then exits the process. `false` cancels it — a logout then reports that
/// Dormouse interrupted it — and the app keeps running. The reply only records the answer — AppKit acts on it
/// once the nested loop regains control, after the current callback unwinds —
/// so it is safe from inside a tao callback.
pub fn answer_held(app: &AppHandle, proceed: bool) -> bool {
    if !HELD.swap(false, Ordering::SeqCst) {
        return false;
    }
    if proceed {
        // The OS asked for this exit; it never relaunches (as above).
        forget_restart(app);
    }
    append_log(format!("[quit] answering the held AppKit terminate: {}", if proceed { "quit" } else { "cancel" }));
    let reply = move || {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(proceed);
        }
    };
    if MainThreadMarker::new().is_some() {
        reply();
    } else if let Err(err) = app.run_on_main_thread(reply) {
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
