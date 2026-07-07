//! Minimal PE/COFF Subsystem-field access, shared between `build.rs` (which flips
//! the bundled `node.exe` to the GUI subsystem) and the crate at runtime (which
//! derives a console-subsystem copy for the `dor` CLI). The load-bearing PE
//! offsets live here in exactly one place: `build.rs` pulls this file in with
//! `#[path = "src/pe_subsystem.rs"] mod pe_subsystem;` and the crate with `mod`.
//! Each consumer uses a subset, so some items look unused per compilation unit.
#![allow(dead_code)]

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// IMAGE_SUBSYSTEM_WINDOWS_CUI — a console app; attaches to an inherited console.
pub const CONSOLE: u16 = 3;
/// IMAGE_SUBSYSTEM_WINDOWS_GUI — no console; avoids Win11's DefTerm handoff.
pub const GUI: u16 = 2;

/// Byte offset of the 2-byte Subsystem field in the PE optional header. `image`
/// must span at least through `offset + 2`.
pub fn subsystem_offset(image: &[u8]) -> Result<usize, String> {
    if image.len() < 0x40 || &image[0..2] != b"MZ" {
        return Err("not a PE/COFF binary".into());
    }
    let pe_offset = u32::from_le_bytes(image[0x3C..0x40].try_into().unwrap()) as usize;
    // PE signature (4) + COFF header (20) + Optional header up to Subsystem (0x44).
    let offset = pe_offset + 0x5C;
    if image.len() < offset + 2 || &image[pe_offset..pe_offset + 4] != b"PE\0\0" {
        return Err("no PE signature at expected offset".into());
    }
    Ok(offset)
}

/// Patch the Subsystem field of an in-memory image in place.
pub fn set_subsystem(image: &mut [u8], subsystem: u16) -> Result<(), String> {
    let offset = subsystem_offset(image)?;
    image[offset..offset + 2].copy_from_slice(&subsystem.to_le_bytes());
    Ok(())
}

/// Read just the Subsystem field, seeking to it rather than slurping the whole
/// (~80MB) binary — this runs on every app launch to validate the cached copy.
pub fn read_subsystem(path: &Path) -> Result<u16, String> {
    let mut file = File::open(path).map_err(|e| format!("open: {e}"))?;
    let mut dos = [0u8; 0x40];
    file.read_exact(&mut dos)
        .map_err(|e| format!("read DOS header: {e}"))?;
    if &dos[0..2] != b"MZ" {
        return Err("not a PE/COFF binary".into());
    }
    let pe_offset = u32::from_le_bytes(dos[0x3C..0x40].try_into().unwrap()) as u64;
    file.seek(SeekFrom::Start(pe_offset))
        .map_err(|e| format!("seek PE header: {e}"))?;
    let mut signature = [0u8; 4];
    file.read_exact(&mut signature)
        .map_err(|e| format!("read PE signature: {e}"))?;
    if &signature != b"PE\0\0" {
        return Err("no PE signature at expected offset".into());
    }
    file.seek(SeekFrom::Start(pe_offset + 0x5C))
        .map_err(|e| format!("seek Subsystem field: {e}"))?;
    let mut field = [0u8; 2];
    file.read_exact(&mut field)
        .map_err(|e| format!("read Subsystem field: {e}"))?;
    Ok(u16::from_le_bytes(field))
}
