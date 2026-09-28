//! An Objective-C exception raised beneath tao's `sendEvent:` override must
//! reach AppKit's handler and leave the event loop running
//! (docs/specs/standalone.md -> "Objective-C exceptions"). Tests always
//! unwind, so this pins tao's half; `panic_policy`'s tests pin the release
//! profile's half. `harness = false`: AppKit needs the main thread.

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

    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::{class, msg_send, sel};
    use objc2_foundation::{ns_string, NSException, NSPoint};
    use tao::event::{Event, StartCause};
    use tao::event_loop::{ControlFlow, EventLoop};
    use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};

    type SendEvent = unsafe extern "C-unwind" fn(&AnyObject, Sel, &AnyObject);

    /// `NSEventTypeApplicationDefined`.
    const APPLICATION_DEFINED: usize = 15;
    const SUBTYPE: i16 = 0x0d0e;

    static ORIGINAL: OnceLock<Imp> = OnceLock::new();
    static RAISED: AtomicBool = AtomicBool::new(false);

    /// Stands in for AppKit code under `-[NSApplication sendEvent:]` that
    /// raises, as `NSCampoLightweightUIController` does on macOS 27.
    unsafe extern "C-unwind" fn raising_send_event(this: &AnyObject, cmd: Sel, event: &AnyObject) {
        let ty: usize = msg_send![event, type];
        // `subtype` itself raises on most event types, so check the type first.
        if ty == APPLICATION_DEFINED {
            let subtype: i16 = msg_send![event, subtype];
            if subtype == SUBTYPE {
                RAISED.store(true, Ordering::SeqCst);
                let reason = ns_string!("raised beneath tao's sendEvent: override");
                NSException::new(ns_string!("DormouseTestException"), Some(reason), None)
                    .unwrap()
                    .raise();
            }
        }
        let original: SendEvent = std::mem::transmute(*ORIGINAL.get().unwrap());
        original(this, cmd, event);
    }

    unsafe fn raise_on_next_event() {
        let method = AnyClass::get(c"NSApplication")
            .unwrap()
            .instance_method(sel!(sendEvent:))
            .unwrap();
        let raising: SendEvent = raising_send_event;
        ORIGINAL
            .set(method.set_implementation(std::mem::transmute::<SendEvent, Imp>(raising)))
            .unwrap();
        let event: *mut AnyObject = msg_send![
            class!(NSEvent),
            otherEventWithType: APPLICATION_DEFINED,
            location: NSPoint::new(0.0, 0.0),
            modifierFlags: 0usize,
            timestamp: 0.0f64,
            windowNumber: 0isize,
            context: std::ptr::null_mut::<AnyObject>(),
            subtype: SUBTYPE,
            data1: 0isize,
            data2: 0isize,
        ];
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, postEvent: event, atStart: Bool::NO];
    }

    pub fn run() {
        let mut event_loop = EventLoop::new();
        // No Dock icon or focus steal while the test runs.
        event_loop.set_activation_policy(ActivationPolicy::Prohibited);
        event_loop.run(|event, _, control_flow| match event {
            Event::NewEvents(StartCause::Init) => {
                unsafe { raise_on_next_event() };
                *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_secs(1));
            }
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                assert!(
                    RAISED.load(Ordering::SeqCst),
                    "the exception was never raised"
                );
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        });
    }
}
