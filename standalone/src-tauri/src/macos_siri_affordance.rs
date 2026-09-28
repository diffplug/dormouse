//! docs/specs/standalone.md -> "Siri affordance".

use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{ffi, msg_send, sel};
use tauri::{AppHandle, Manager};

use crate::append_log;

/// `BOOL (*)(id, SEL)`.
const BOOL_GETTER_TYPES: &[u8] = b"B@:\0";

unsafe extern "C-unwind" fn disallow(_this: *mut AnyObject, _cmd: Sel) -> Bool {
    Bool::NO
}

/// Answer NO to `allowsWritingToolsAffordance` for every instance of
/// `object`'s class: wry's `WKWebView` subclass, so `WKWebView` itself is
/// untouched. Replaces rather than adds, so it holds if wry ever implements
/// the selector itself.
unsafe fn disallow_for_class_of(object: *mut AnyObject) {
    // `class`, not `object_getClass`: KVO would hand back its private subclass.
    let class: *const AnyClass = msg_send![object, class];
    let imp: Imp =
        std::mem::transmute(disallow as unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool);
    ffi::class_replaceMethod(
        class as *mut AnyClass,
        sel!(allowsWritingToolsAffordance),
        imp,
        BOOL_GETTER_TYPES.as_ptr().cast(),
    );
}

/// Install the override. Call once, from `RunEvent::Ready`: wry has one webview
/// class, so any open window's webview covers every later window too.
pub fn install(app: &AppHandle) {
    let Some(window) = app.webview_windows().into_values().next() else {
        append_log("[siri] WARNING no webview to suppress the Writing Tools affordance on");
        return;
    };
    let result = window.with_webview(|webview| unsafe {
        disallow_for_class_of(webview.inner().cast());
        append_log("[siri] Writing Tools affordance suppressed for Dormouse webviews");
    });
    if let Err(err) = result {
        append_log(&format!(
            "[siri] WARNING could not suppress the Writing Tools affordance: {err}"
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::rc::Retained;
    use objc2::runtime::{ClassBuilder, NSObject};
    use objc2::ClassType;

    unsafe extern "C-unwind" fn allow(_this: *mut AnyObject, _cmd: Sel) -> Bool {
        Bool::YES
    }

    fn allows(class: &AnyClass) -> bool {
        let object: Retained<AnyObject> = unsafe { msg_send![class, new] };
        let allowed: Bool = unsafe { msg_send![&*object, allowsWritingToolsAffordance] };
        allowed.as_bool()
    }

    #[test]
    fn suppresses_the_webview_subclass_only() {
        // The parent answers YES, as `WKWebView` does; the child stands in for
        // the subclass wry registers.
        let mut parent = ClassBuilder::new(c"DormouseSiriTestWebView", NSObject::class()).unwrap();
        unsafe {
            parent.add_method(
                sel!(allowsWritingToolsAffordance),
                allow as unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool,
            );
        }
        let parent = parent.register();
        let child = ClassBuilder::new(c"DormouseSiriTestWryWebView", parent)
            .unwrap()
            .register();
        let webview: Retained<AnyObject> = unsafe { msg_send![child, new] };

        unsafe { disallow_for_class_of(Retained::as_ptr(&webview) as *mut AnyObject) };

        assert!(!allows(child));
        assert!(allows(parent));
    }
}
