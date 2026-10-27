//! Console window parenting (docs/specs/standalone.md -> "Console window
//! parenting"): the window holding a PTY owns its ConPTY console window, so a
//! dialog a console program parents to it opens above Dormouse.
//!
//! `Recovery` is pure over its own state, like `routing`; `win` holds the Win32
//! reads and the `EnableWindow` that `lib.rs` drives from its thread.

use std::collections::HashMap;
use std::time::Duration;

/// An HWND as node-pty's `setParentWindow` takes it — its bytes in native
/// order — hex-encoded for the JSON line.
pub fn handle_hex(raw: isize) -> String {
    raw.to_ne_bytes().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// How often recovery looks at every window.
pub const TICK: Duration = Duration::from_millis(500);
/// Consecutive ticks a window must be disabled with nothing visible owning it
/// before it is re-enabled: a dialog is created after its owner is disabled,
/// and one tick could land in that gap.
pub const STRIKES: u8 = 2;

/// One window as a tick sees it.
#[derive(Debug, Clone, Copy)]
pub struct HostState {
    pub hwnd: isize,
    pub disabled: bool,
    /// Minimizing a window hides the windows it owns, its dialog included.
    pub minimized: bool,
    /// Some visible top-level window has this one in its owner chain.
    pub owns_visible: bool,
}

/// A modal dialog disables its owner and re-enables it when dismissed, so a
/// dialog whose process dies leaves its owner disabled for good
/// (microsoft/node-pty#996). A disabled window owning no visible window is
/// that case, whichever process the dialog lived in — unless it is minimized,
/// which hides a live dialog too.
#[derive(Default)]
pub struct Recovery {
    strikes: HashMap<isize, u8>,
}

impl Recovery {
    /// The windows to re-enable now.
    pub fn tick(&mut self, hosts: &[HostState]) -> Vec<isize> {
        let mut reenable = Vec::new();
        let mut strikes = HashMap::new();
        for host in hosts.iter().filter(|host| host.disabled && !host.minimized && !host.owns_visible) {
            let count = self.strikes.get(&host.hwnd).copied().unwrap_or(0) + 1;
            if count >= STRIKES {
                reenable.push(host.hwnd);
            } else {
                strikes.insert(host.hwnd, count);
            }
        }
        self.strikes = strikes;
        reenable
    }
}

#[cfg(windows)]
pub mod win {
    use super::HostState;
    use std::collections::HashSet;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindow, IsIconic, IsWindowVisible, GW_OWNER};

    /// Owner chains are short; this bounds a cycle a hostile window could make.
    const MAX_OWNER_DEPTH: usize = 16;

    fn hwnd(raw: isize) -> HWND {
        HWND(raw as *mut core::ffi::c_void)
    }

    unsafe extern "system" fn collect(window: HWND, list: LPARAM) -> BOOL {
        unsafe { (*(list.0 as *mut Vec<HWND>)).push(window) };
        true.into()
    }

    /// Of `hosts`, those that own a visible top-level window, directly or
    /// through owned windows (a dialog owned by the hidden console window).
    fn owning_visible(hosts: &[isize]) -> HashSet<isize> {
        let mut all: Vec<HWND> = Vec::new();
        // An enumeration that fails part-way still judges what it saw; a
        // window it missed reads as owning nothing for at most one tick.
        let _ = unsafe { EnumWindows(Some(collect), LPARAM(&mut all as *mut Vec<HWND> as isize)) };
        let mut owning = HashSet::new();
        for window in all.into_iter().filter(|&window| unsafe { IsWindowVisible(window) }.as_bool()) {
            let mut current = window;
            for _ in 0..MAX_OWNER_DEPTH {
                let Ok(owner) = (unsafe { GetWindow(current, GW_OWNER) }) else { break };
                if hosts.contains(&(owner.0 as isize)) {
                    owning.insert(owner.0 as isize);
                    break;
                }
                current = owner;
            }
        }
        owning
    }

    pub fn states(hosts: &[isize]) -> Vec<HostState> {
        let disabled: Vec<isize> =
            hosts.iter().copied().filter(|&raw| !unsafe { IsWindowEnabled(hwnd(raw)) }.as_bool()).collect();
        // The steady state: nothing disabled, nothing to enumerate.
        let owning = if disabled.is_empty() { HashSet::new() } else { owning_visible(&disabled) };
        hosts
            .iter()
            .map(|&raw| HostState {
                hwnd: raw,
                disabled: disabled.contains(&raw),
                minimized: unsafe { IsIconic(hwnd(raw)) }.as_bool(),
                owns_visible: owning.contains(&raw),
            })
            .collect()
    }

    pub fn enable(raw: isize) {
        let _ = unsafe { EnableWindow(hwnd(raw), true) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(hwnd: isize, disabled: bool, owns_visible: bool) -> HostState {
        HostState { hwnd, disabled, minimized: false, owns_visible }
    }

    #[test]
    fn handle_bytes_are_native_order() {
        let hex = handle_hex(0x0012_3456);
        assert_eq!(hex.len(), 2 * std::mem::size_of::<isize>());
        let bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        assert_eq!(bytes, 0x0012_3456isize.to_ne_bytes());
    }

    #[test]
    fn a_dialog_keeps_its_owner_disabled() {
        let mut recovery = Recovery::default();
        for _ in 0..10 {
            assert!(recovery.tick(&[host(1, true, true)]).is_empty());
        }
    }

    #[test]
    fn an_orphaned_disable_is_undone_on_the_second_tick() {
        let mut recovery = Recovery::default();
        assert!(recovery.tick(&[host(1, true, false), host(2, false, false)]).is_empty());
        assert_eq!(recovery.tick(&[host(1, true, false), host(2, false, false)]), vec![1]);
        // Counting starts over once it has been re-enabled.
        assert!(recovery.tick(&[host(1, true, false)]).is_empty());
    }

    #[test]
    fn a_minimized_window_keeps_its_hidden_dialog_modal() {
        let mut recovery = Recovery::default();
        let minimized = HostState { minimized: true, ..host(1, true, false) };
        for _ in 0..10 {
            assert!(recovery.tick(&[minimized]).is_empty());
        }
    }

    #[test]
    fn the_gap_before_a_dialog_appears_is_not_a_strike_streak() {
        let mut recovery = Recovery::default();
        assert!(recovery.tick(&[host(1, true, false)]).is_empty());
        assert!(recovery.tick(&[host(1, true, true)]).is_empty());
        assert!(recovery.tick(&[host(1, true, false)]).is_empty());
        assert!(recovery.tick(&[host(1, false, false)]).is_empty());
        assert!(recovery.tick(&[host(1, true, false)]).is_empty());
    }
}
