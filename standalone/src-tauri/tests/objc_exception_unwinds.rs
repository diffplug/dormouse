//! An Objective-C exception raised beneath tao's `sendEvent:` override must
//! reach AppKit's handler and leave the event loop running
//! (docs/specs/standalone.md -> "Objective-C exceptions"). Tests always
//! unwind, so this pins tao's half on the tao tauri resolves; `panic_policy`
//! pins the release profile's half. `harness = false`: AppKit needs the main
//! thread.

#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
fn main() {
    macos::run();
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    use objc2::runtime::{Imp, Sel};
    use objc2::{sel, ClassType, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::{ns_string, NSException, NSPoint};
    use tauri_runtime_wry::tao::event::{Event, StartCause};
    use tauri_runtime_wry::tao::event_loop::{ControlFlow, EventLoop};
    use tauri_runtime_wry::tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};

    type SendEvent = unsafe extern "C-unwind" fn(&NSApplication, Sel, &NSEvent);

    const SUBTYPE: i16 = 0x0d0e;

    static ORIGINAL: OnceLock<Imp> = OnceLock::new();
    static RAISED: AtomicBool = AtomicBool::new(false);

    /// Stands in for AppKit code under `-[NSApplication sendEvent:]` that
    /// raises, as `NSCampoLightweightUIController` does on macOS 27.
    unsafe extern "C-unwind" fn raising_send_event(
        this: &NSApplication,
        cmd: Sel,
        event: &NSEvent,
    ) {
        // `subtype` itself raises on most event types, so check the type first.
        if event.r#type() == NSEventType::ApplicationDefined && event.subtype().0 == SUBTYPE {
            RAISED.store(true, Ordering::SeqCst);
            let reason = ns_string!("raised beneath tao's sendEvent: override");
            NSException::new(ns_string!("DormouseTestException"), Some(reason), None)
                .unwrap()
                .raise();
        }
        let original: SendEvent = std::mem::transmute(*ORIGINAL.get().unwrap());
        original(this, cmd, event);
    }

    fn raise_on_next_event(mtm: MainThreadMarker) {
        let method = NSApplication::class()
            .instance_method(sel!(sendEvent:))
            .unwrap();
        let raising: SendEvent = raising_send_event;
        let original =
            unsafe { method.set_implementation(std::mem::transmute::<SendEvent, Imp>(raising)) };
        ORIGINAL.set(original).unwrap();
        let event = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
            NSEventType::ApplicationDefined,
            NSPoint::new(0.0, 0.0),
            NSEventModifierFlags::empty(),
            0.0,
            0,
            None,
            SUBTYPE,
            0,
            0,
        )
        .unwrap();
        NSApplication::sharedApplication(mtm).postEvent_atStart(&event, false);
    }

    pub fn run() {
        let mut event_loop = EventLoop::new();
        // No Dock icon or focus steal while the test runs.
        event_loop.set_activation_policy(ActivationPolicy::Prohibited);
        event_loop.run(|event, _, control_flow| match event {
            Event::NewEvents(StartCause::Init) => {
                raise_on_next_event(MainThreadMarker::new().unwrap());
                *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_secs(10));
            }
            // Any iteration after the raise proves the loop survived it.
            Event::MainEventsCleared if RAISED.load(Ordering::SeqCst) => {
                *control_flow = ControlFlow::Exit;
            }
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                panic!("the exception was never raised");
            }
            _ => {}
        });
    }
}
