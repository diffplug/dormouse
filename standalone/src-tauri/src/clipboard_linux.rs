//! Native Linux clipboard reads, through the GTK the app already links (tao
//! initializes it on the main thread).
//!
//! The Linux app used to read through the sidecar, which shelled out to
//! `wl-paste` or `xclip`. The AppImage ships neither and a desktop install often
//! lacks both, so every paste then read as empty. The write stays the browser's
//! (`standalone/src/native-clipboard.ts`).
//!
//! Every read is GTK's asynchronous request, made on the main thread, with its
//! answer sent back over a channel; never a `wait_for_*` call, which spins a
//! nested main loop. A clipboard owner that never answers fails the read at the
//! bound the sidecar path used for the same command, rather than hanging it.

use std::sync::mpsc;
use std::time::Duration;

use gtk::gdk;
use tauri::AppHandle;

use crate::clipboard_read::{paths_from_uris, text_from, write_drop_png, MAX_READ_BYTES};

/// The sidecar path's bounds for these commands (`request_from_sidecar_timeout`).
const TEXT_TIMEOUT: Duration = Duration::from_secs(5);
const IMAGE_TIMEOUT: Duration = Duration::from_secs(10);

/// Runs `request` against the CLIPBOARD selection on the main thread and waits
/// up to `timeout` for the value its callback sends.
fn read<T: Send + 'static>(
    app: &AppHandle,
    timeout: Duration,
    request: impl FnOnce(gtk::Clipboard, mpsc::Sender<T>) + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || request(gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD), tx))
        .map_err(|e| format!("the clipboard could not be read: {e}"))?;
    rx.recv_timeout(timeout)
        .map_err(|_| "the clipboard did not answer".to_string())
}

/// The clipboard's text, or empty when it holds none.
pub fn read_text(app: &AppHandle) -> Result<String, String> {
    read(app, TEXT_TIMEOUT, |clipboard, tx| {
        clipboard.request_text(move |_, text| {
            let _ = tx.send(text_from(text));
        });
    })
}

/// The local paths a copied `text/uri-list` names, or none.
pub fn read_file_paths(app: &AppHandle) -> Result<Vec<String>, String> {
    read(app, TEXT_TIMEOUT, |clipboard, tx| {
        clipboard.request_uris(move |_, uris| {
            let _ = tx.send(paths_from_uris(uris));
        });
    })
}

/// A copied image's `image/png` bytes written to a temp file, its path; None
/// when the clipboard offers no PNG.
pub fn read_image_as_file_path(app: &AppHandle) -> Result<Option<String>, String> {
    let png = read(app, IMAGE_TIMEOUT, |clipboard, tx| {
        clipboard.request_contents(&gdk::Atom::intern("image/png"), move |_, data| {
            let length = data.length();
            let bytes = if length > 0 && length as usize <= MAX_READ_BYTES { data.data() } else { Vec::new() };
            let _ = tx.send(bytes);
        });
    })?;
    Ok(write_drop_png(&png))
}

/// The real GTK read, against this display's clipboard. Needs a display, so it
/// never runs by default:
/// `cargo test --manifest-path standalone/src-tauri/Cargo.toml --lib clipboard -- --include-ignored --nocapture --test-threads=1`
#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "needs a display and a clipboard owner"]
    fn reads_the_display_clipboard() {
        // Without tao: GTK on this test thread, which becomes its main thread,
        // with a main loop iterated until each request answers.
        gtk::init().expect("GTK needs a display (DISPLAY or WAYLAND_DISPLAY)");
        let clipboard = gtk::Clipboard::get(&super::gdk::SELECTION_CLIPBOARD);
        // Set `DORMOUSE_CLIPBOARD_KEEP=1` to read what another app copied (a
        // file in Files, an image) instead of this probe's own text.
        if std::env::var_os("DORMOUSE_CLIPBOARD_KEEP").is_none() {
            clipboard.set_text("dormouse clipboard probe");
        }
        let pump = |done: &std::rc::Rc<std::cell::Cell<bool>>| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !done.get() && std::time::Instant::now() < deadline {
                gtk::main_iteration_do(false);
            }
        };
        let done = std::rc::Rc::new(std::cell::Cell::new(false));
        let flag = done.clone();
        clipboard.request_text(move |_, text| {
            println!("text: {:?}", super::text_from(text));
            flag.set(true);
        });
        pump(&done);
        assert!(done.get(), "request_text never answered");
        let done = std::rc::Rc::new(std::cell::Cell::new(false));
        let flag = done.clone();
        clipboard.request_uris(move |_, uris| {
            println!("uris: {:?} -> paths {:?}", uris, super::paths_from_uris(uris));
            flag.set(true);
        });
        pump(&done);
        assert!(done.get(), "request_uris never answered");
        let done = std::rc::Rc::new(std::cell::Cell::new(false));
        let flag = done.clone();
        clipboard.request_contents(&super::gdk::Atom::intern("image/png"), move |_, data| {
            println!("image/png: {} bytes", data.length());
            flag.set(true);
        });
        pump(&done);
        assert!(done.get(), "request_contents never answered");
    }
}
