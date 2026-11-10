//! What a native clipboard read hands back, apart from how it reads: the file
//! references in a `text/uri-list`, and the temp file an image paste is written
//! to. Kept free of GTK so it builds and is tested on every platform;
//! `clipboard_linux` calls it, and `clipboard_win` for that temp file. Each rule
//! mirrors the sidecar's Linux read (`standalone/sidecar/clipboard-ops.js`),
//! which the Linux app used before it read natively. No read is bounded in
//! size: the platform already holds the payload, as the Windows reads take it.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::fs::{DirBuilder, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How long a pasted image's temp file lives, the sidecar's `DROP_TTL_MS`: long
/// enough for a command the user ran against the path to have read it.
const DROP_TTL: Duration = Duration::from_secs(5 * 60);

/// Clipboard text, or empty when there is none.
pub fn text_from(text: Option<&str>) -> String {
    text.unwrap_or_default().to_string()
}

/// The local paths a `text/uri-list` names, in order, as the sidecar's
/// `parseUriList` returns them: comments and anything but a `file://` URI are
/// skipped, the rest of each URI is percent-decoded, and one that does not
/// decode to UTF-8 is dropped.
pub fn paths_from_uris<S: AsRef<str>>(uris: &[S]) -> Vec<String> {
    uris.iter()
        .map(|uri| uri.as_ref().trim())
        .filter(|uri| !uri.is_empty() && !uri.starts_with('#'))
        .filter_map(|uri| uri.strip_prefix("file://"))
        .filter_map(percent_decode)
        .filter(|path| !path.is_empty())
        .collect()
}

/// `decodeURIComponent`: `%XX` escapes to bytes, which must be UTF-8; a
/// malformed escape fails the whole string, as it throws there.
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let high = (hex[0] as char).to_digit(16)?;
            let low = (hex[1] as char).to_digit(16)?;
            out.push((high * 16 + low) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

static DROP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Writes a pasted image's PNG bytes to a temp file (`write_drop_file`) and
/// answers its path; None for no bytes or a write that fails.
pub fn write_drop_png(png: &[u8]) -> Option<String> {
    if png.is_empty() {
        return None;
    }
    write_drop_file("clipboard.png", |file| file.write_all(png))
}

/// Writes a pasted image, through `write`, to `name` in a fresh directory under
/// the temp directory, as the sidecar does, removes both after `DROP_TTL`, and
/// answers its path; None when the directory, the file, or `write` fails. The
/// directory and file are owner-only on Unix; on Windows they take the per-user
/// temp directory's own access list.
pub fn write_drop_file(name: &str, write: impl FnOnce(&mut File) -> std::io::Result<()>) -> Option<String> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let counter = DROP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("dormouse-drops-{nanos}-{counter}"));
    let mut builder = DirBuilder::new();
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        builder.mode(0o700);
        options.mode(0o600);
    }
    builder.create(&dir).ok()?;
    let path = dir.join(name);
    let written = options.open(&path).and_then(|mut file| write(&mut file));
    if written.is_err() {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
        return None;
    }
    schedule_cleanup(path.clone());
    Some(path.to_string_lossy().into_owned())
}

fn schedule_cleanup(path: PathBuf) {
    std::thread::spawn(move || {
        std::thread::sleep(DROP_TTL);
        let _ = std::fs::remove_file(&path);
        if let Some(parent) = path.parent() {
            let _ = std::fs::remove_dir(parent);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_references_decode_as_the_sidecar_parses_them() {
        // As the sidecar's parseUriList reads them (clipboard-ops.test.js).
        let uris = ["# comment", "file:///tmp/a%20b.txt", "https://example.com", "", "  file:///tmp/c.txt  "];
        assert_eq!(paths_from_uris(&uris), vec!["/tmp/a b.txt", "/tmp/c.txt"]);
        assert_eq!(paths_from_uris(&["file:///tmp/%C3%A9t%C3%A9"]), vec!["/tmp/été"]);
    }

    #[test]
    fn a_reference_that_does_not_decode_is_dropped() {
        assert_eq!(paths_from_uris(&["file:///tmp/bad%zz", "file:///tmp/%FF", "file:///tmp/cut%2", "file:///ok"]), vec!["/ok"]);
        assert!(paths_from_uris::<&str>(&[]).is_empty());
    }

    #[test]
    fn text_is_empty_only_when_absent() {
        assert_eq!(text_from(Some("hello\n")), "hello\n");
        assert_eq!(text_from(None), "");
        // Past the sidecar's 16 MiB `MAX_BUFFER`, which read as empty there.
        let large = "x".repeat(17 * 1024 * 1024);
        assert_eq!(text_from(Some(&large)).len(), large.len());
    }

    #[test]
    fn an_image_is_written_owner_only_and_refused_when_empty() {
        assert_eq!(write_drop_png(&[]), None);
        let large = PathBuf::from(write_drop_png(&vec![0; 17 * 1024 * 1024]).unwrap());
        assert_eq!(std::fs::metadata(&large).unwrap().len(), 17 * 1024 * 1024);
        let _ = std::fs::remove_file(&large);
        let _ = std::fs::remove_dir(large.parent().unwrap());
        let path = PathBuf::from(write_drop_png(b"\x89PNG\r\n\x1a\n").unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"\x89PNG\r\n\x1a\n");
        assert!(path.ends_with("clipboard.png"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(path.parent().unwrap());
    }
}
