//! Native Windows clipboard reads.
//!
//! The standalone app used to read the clipboard by round-tripping through the
//! Node sidecar, which shelled out to `powershell.exe` (`Get-Clipboard`, ...).
//! Because the sidecar runs as a windowless GUI child, every such spawn
//! allocated a fresh console window — and `doPaste` fires *two* reads (file
//! paths + text) on every Ctrl+V, so several console windows flickered and
//! stole focus per paste, freezing the GUI (diffplug/dormouse Windows paste bug).
//!
//! These functions talk to the Win32 clipboard directly, so a paste is a few
//! in-process API calls with no subprocess at all. macOS/Linux keep the sidecar
//! path (`pbpaste`/`xclip` never pop a console window), so this module is
//! Windows-only.

use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{CF_DIB, CF_HDROP, CF_UNICODETEXT};
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

/// Image temp files are deleted this long after a paste — long enough that any
/// command the user launched against the path has had time to read it, matching
/// the sidecar's DROP_TTL_MS.
const DROP_TTL: Duration = Duration::from_secs(5 * 60);

/// RAII wrapper around OpenClipboard/CloseClipboard. Opening can fail transiently
/// while another process holds the clipboard, so retry briefly before giving up.
struct ClipboardGuard;

impl ClipboardGuard {
    fn open() -> Option<Self> {
        for attempt in 0..10 {
            // SAFETY: OpenClipboard(None) associates the clipboard with the
            // current task; paired with CloseClipboard in Drop.
            if unsafe { OpenClipboard(None) }.is_ok() {
                return Some(ClipboardGuard);
            }
            std::thread::sleep(Duration::from_millis(10 * (attempt + 1)));
        }
        None
    }
}

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        // SAFETY: balances the OpenClipboard that produced this guard.
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

fn format_available(format: u16) -> bool {
    // SAFETY: pure query, no clipboard ownership required.
    unsafe { IsClipboardFormatAvailable(format as u32) }.is_ok()
}

/// Open the clipboard, fetch `format`, lock its global memory, and hand the
/// locked pointer plus its byte size to `read`. Returns None when the format is
/// absent or the handle can't be locked. Unlocks the handle and closes the
/// clipboard before returning, so `read` must copy out anything it needs.
fn with_locked_clipboard<T>(
    format: u16,
    read: impl FnOnce(*const u8, usize) -> Option<T>,
) -> Option<T> {
    let _guard = ClipboardGuard::open()?;
    if !format_available(format) {
        return None;
    }
    // SAFETY: guarded by the open clipboard; the handle stays valid until
    // CloseClipboard, and we GlobalUnlock the pointer we lock.
    unsafe {
        let handle = GetClipboardData(format as u32).ok()?;
        let hglobal = HGLOBAL(handle.0);
        let size = GlobalSize(hglobal);
        let ptr = GlobalLock(hglobal) as *const u8;
        if ptr.is_null() {
            return None;
        }
        let result = read(ptr, size);
        let _ = GlobalUnlock(hglobal);
        result
    }
}

/// Read the CF_UNICODETEXT clipboard entry, or None when the clipboard holds no
/// text. Mirrors the sidecar's Get-Clipboard -Raw (no synthesized trailing
/// newline to strip — CF_UNICODETEXT is the raw string).
pub fn read_text() -> Option<String> {
    with_locked_clipboard(CF_UNICODETEXT.0, |ptr, _size| {
        // SAFETY: ptr is a locked CF_UNICODETEXT block — a NUL-terminated wide string.
        unsafe {
            let wide = ptr as *const u16;
            let mut len = 0usize;
            while *wide.add(len) != 0 {
                len += 1;
            }
            Some(String::from_utf16_lossy(std::slice::from_raw_parts(wide, len)))
        }
    })
}

/// Read CF_HDROP file paths (files copied in Explorer), or an empty vec when the
/// clipboard holds no file drop list.
pub fn read_file_paths() -> Vec<String> {
    let Some(_guard) = ClipboardGuard::open() else {
        return Vec::new();
    };
    if !format_available(CF_HDROP.0) {
        return Vec::new();
    }
    // SAFETY: guarded by the open clipboard. DragQueryFileW with a None buffer
    // reports the required length; we then size an exact buffer per entry.
    unsafe {
        let Ok(handle) = GetClipboardData(CF_HDROP.0 as u32) else {
            return Vec::new();
        };
        let hdrop = HDROP(handle.0);
        let count = DragQueryFileW(hdrop, u32::MAX, None);
        let mut paths = Vec::with_capacity(count as usize);
        for i in 0..count {
            let needed = DragQueryFileW(hdrop, i, None);
            if needed == 0 {
                continue;
            }
            let mut buf = vec![0u16; needed as usize + 1];
            let written = DragQueryFileW(hdrop, i, Some(&mut buf));
            if written == 0 {
                continue;
            }
            buf.truncate(written as usize);
            paths.push(String::from_utf16_lossy(&buf));
        }
        paths
    }
}

/// Read a bitmap from the clipboard (CF_DIB) and write it to a temp file as a
/// BMP, returning the path — or None when the clipboard holds no image. A
/// CF_DIB is a bare device-independent bitmap (no file header), so we prepend a
/// 14-byte BITMAPFILEHEADER to make a valid .bmp with no decode/re-encode. The
/// macOS/Linux sidecar path saves PNGs; the extension differs but the file is a
/// valid image either way, and the path is only handed to whatever command the
/// user runs against it.
pub fn read_image_as_file_path() -> Option<String> {
    let dib = read_dib_bytes()?;
    let header = bmp_file_header(&dib)?;
    let path = unique_drop_path("clipboard.bmp");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok()?;
    }
    // Write the 14-byte file header and the DIB back-to-back rather than
    // allocating a third full-image buffer to concatenate them (a clipboard
    // screenshot DIB can be tens of MB).
    let mut file = File::create(&path).ok()?;
    file.write_all(&header).ok()?;
    file.write_all(&dib).ok()?;
    schedule_cleanup(path.clone());
    Some(path.to_string_lossy().into_owned())
}

fn read_dib_bytes() -> Option<Vec<u8>> {
    with_locked_clipboard(CF_DIB.0, |ptr, size| {
        if size == 0 {
            return None;
        }
        // SAFETY: ptr/size describe the locked CF_DIB block.
        Some(unsafe { std::slice::from_raw_parts(ptr, size) }.to_vec())
    })
}

const BI_BITFIELDS: u32 = 3;

/// Build the 14-byte BITMAPFILEHEADER that turns a packed CF_DIB into a complete
/// .bmp when written in front of it. The pixel data offset is 14 (file header) +
/// DIB header + color masks + palette; see the standard "clipboard DIB to BMP
/// file" recipe. Returns None if the DIB is too short to describe its own layout.
fn bmp_file_header(dib: &[u8]) -> Option<[u8; 14]> {
    if dib.len() < 4 {
        return None;
    }
    let read_u16 = |off: usize| u16::from_le_bytes([dib[off], dib[off + 1]]);
    let read_u32 =
        |off: usize| u32::from_le_bytes([dib[off], dib[off + 1], dib[off + 2], dib[off + 3]]);

    let bi_size = read_u32(0) as usize;
    let (bit_count, compression, clr_used, rgbquad) = if bi_size >= 40 {
        // BITMAPINFOHEADER (or V4/V5): biBitCount@14, biCompression@16, biClrUsed@32.
        if dib.len() < 36 {
            return None;
        }
        (
            read_u16(14) as usize,
            read_u32(16),
            read_u32(32) as usize,
            4usize,
        )
    } else if bi_size == 12 {
        // BITMAPCOREHEADER: bcBitCount@10, RGBTRIPLE palette entries.
        if dib.len() < 12 {
            return None;
        }
        (read_u16(10) as usize, 0u32, 0usize, 3usize)
    } else {
        return None;
    };

    let palette_entries = if bit_count <= 8 {
        if clr_used != 0 {
            clr_used
        } else {
            1usize << bit_count
        }
    } else {
        clr_used
    };
    let palette_bytes = palette_entries * rgbquad;
    // BI_BITFIELDS stores 3 (or 4 with alpha) DWORD masks after a 40-byte header;
    // V4/V5 headers embed the masks, so no extra bytes there.
    let mask_bytes = if compression == BI_BITFIELDS && bi_size == 40 {
        12
    } else {
        0
    };

    let off_bits = 14 + bi_size + mask_bytes + palette_bytes;
    let file_size = 14 + dib.len();
    if off_bits > file_size {
        return None;
    }

    let mut header = [0u8; 14];
    header[0..2].copy_from_slice(b"BM");
    header[2..6].copy_from_slice(&(file_size as u32).to_le_bytes());
    // bytes 6..10 (bfReserved1/2) stay zero.
    header[10..14].copy_from_slice(&(off_bits as u32).to_le_bytes());
    Some(header)
}

static DROP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_drop_path(name: &str) -> PathBuf {
    // The parent dir name (timestamp + atomic counter) is already unique per
    // call, so the file inside it needs no further disambiguation.
    let counter = DROP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir()
        .join(format!("dormouse-drops-{nanos}-{counter}"))
        .join(name)
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

    // A 40-byte BITMAPINFOHEADER with the given bit count / compression, biClrUsed = 0.
    fn header_40(bit_count: u16, compression: u32) -> Vec<u8> {
        let mut h = Vec::new();
        h.extend_from_slice(&40u32.to_le_bytes()); // biSize
        h.extend_from_slice(&1i32.to_le_bytes()); // biWidth
        h.extend_from_slice(&1i32.to_le_bytes()); // biHeight
        h.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
        h.extend_from_slice(&bit_count.to_le_bytes()); // biBitCount
        h.extend_from_slice(&compression.to_le_bytes()); // biCompression
        h.extend_from_slice(&0u32.to_le_bytes()); // biSizeImage
        h.extend_from_slice(&0i32.to_le_bytes()); // biXPelsPerMeter
        h.extend_from_slice(&0i32.to_le_bytes()); // biYPelsPerMeter
        h.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed
        h.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant
        h
    }

    fn off_bits(header: &[u8; 14]) -> u32 {
        u32::from_le_bytes([header[10], header[11], header[12], header[13]])
    }

    #[test]
    fn bmp_file_header_32bpp_has_offset_54() {
        // 32bpp BI_RGB: no palette, no masks → pixels start right after the header.
        let mut dib = header_40(32, 0);
        dib.extend_from_slice(&[0x11, 0x22, 0x33, 0xFF]); // one BGRA pixel
        let header = bmp_file_header(&dib).expect("valid dib");
        assert_eq!(&header[0..2], b"BM");
        assert_eq!(u32::from_le_bytes([header[2], header[3], header[4], header[5]]), (14 + dib.len()) as u32);
        assert_eq!(off_bits(&header), 54);
    }

    #[test]
    fn bmp_file_header_8bpp_accounts_for_full_palette() {
        // 8bpp with an implicit 256-entry palette (biClrUsed = 0).
        let mut dib = header_40(8, 0);
        dib.extend_from_slice(&[0u8; 256 * 4]); // palette
        dib.extend_from_slice(&[0u8; 4]); // pixel row
        let header = bmp_file_header(&dib).expect("valid dib");
        assert_eq!(off_bits(&header), 14 + 40 + 256 * 4);
    }

    #[test]
    fn bmp_file_header_bitfields_adds_mask_bytes() {
        let mut dib = header_40(32, BI_BITFIELDS);
        dib.extend_from_slice(&[0u8; 12]); // three DWORD color masks
        dib.extend_from_slice(&[0u8; 4]); // pixel
        let header = bmp_file_header(&dib).expect("valid dib");
        assert_eq!(off_bits(&header), 14 + 40 + 12);
    }

    #[test]
    fn bmp_file_header_rejects_truncated_input() {
        assert!(bmp_file_header(&[0u8; 2]).is_none());
    }
}
