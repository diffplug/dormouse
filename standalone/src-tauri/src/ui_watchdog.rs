//! The UI watchdog (docs/specs/standalone.md §UI watchdog): a webview whose
//! page stops answering is restarted onto the live sidecar.
//!
//! `Watchdog` is pure over its own state, like `routing`; `lib.rs` holds the
//! lock, sends the probes, and calls `recover` with what `hung` returns.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// A page this long without answering a probe is hung.
pub const HANG_AFTER: Duration = Duration::from_secs(5);
/// How often the watchdog thread wakes to probe and judge.
pub const TICK: Duration = Duration::from_secs(1);
/// A tick this late, by either clock, means the host was descheduled or the
/// Mac slept, so every page's silence over that gap is the host's, not the
/// page's.
pub const STALL: Duration = Duration::from_millis(2500);
/// Samples kept on disk; older ones are pruned on each restart.
pub const SAMPLES_KEPT: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Probe {
    /// Answered, or never asked: due a probe on the next tick.
    Idle,
    /// Handed to the main thread, which has not sent it yet. A host main thread
    /// that is busy (a native modal) never starts the page's clock.
    Queued,
    /// Delivered at this instant and not yet answered.
    Sent(Instant),
}

#[derive(Debug, Default)]
pub struct Watchdog {
    /// Armed windows only: a window is absent until its page reports it booted.
    windows: HashMap<String, Probe>,
}

impl Watchdog {
    /// The page booted and listens for probes.
    pub fn arm(&mut self, label: &str) {
        self.windows.insert(label.to_string(), Probe::Idle);
    }

    /// The page is going away (a navigation, a reload, a closed window): its
    /// next realm arms again once it boots.
    pub fn disarm(&mut self, label: &str) {
        self.windows.remove(label);
    }

    pub fn answered(&mut self, label: &str) {
        if let Some(probe) = self.windows.get_mut(label) {
            *probe = Probe::Idle;
        }
    }

    /// The windows due a probe, now marked queued.
    pub fn queue_probes(&mut self) -> Vec<String> {
        let mut due: Vec<String> = Vec::new();
        for (label, probe) in &mut self.windows {
            if *probe == Probe::Idle {
                *probe = Probe::Queued;
                due.push(label.clone());
            }
        }
        due.sort();
        due
    }

    /// The main thread sent the probe it was handed; false when it was dropped
    /// meanwhile (answered by a stale probe, disarmed, or restarted).
    pub fn sent(&mut self, label: &str, at: Instant) -> bool {
        match self.windows.get_mut(label) {
            Some(probe) if *probe == Probe::Queued => {
                *probe = Probe::Sent(at);
                true
            }
            _ => false,
        }
    }

    /// Start every window's count over: the silence was not theirs.
    pub fn restart_counts(&mut self) {
        for probe in self.windows.values_mut() {
            *probe = Probe::Idle;
        }
    }

    /// The windows silent for `HANG_AFTER`, disarmed: each is restarted once,
    /// and arms again from its reloaded page.
    pub fn hung(&mut self, now: Instant) -> Vec<String> {
        let mut hung: Vec<String> = self
            .windows
            .iter()
            .filter(|(_, probe)| matches!(probe, Probe::Sent(at) if now.saturating_duration_since(*at) >= HANG_AFTER))
            .map(|(label, _)| label.clone())
            .collect();
        hung.sort();
        for label in &hung {
            self.windows.remove(label);
        }
        hung
    }
}

/// On by default in release builds only: a debugger paused in a dev build's
/// inspector would read as a hang. `DORMOUSE_UI_WATCHDOG=1` or `=0` overrides.
pub fn enabled(env: Option<&str>) -> bool {
    match env {
        Some("1") => true,
        Some("0") => false,
        _ => !cfg!(debug_assertions),
    }
}

/// What a restarted window's page shows once it boots again.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartNotice {
    pub seconds: u64,
    /// The `sample` of the hung process, when one was taken.
    pub sample_path: Option<String>,
}

#[cfg(target_os = "macos")]
pub mod macos {
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    use tauri::{AppHandle, Manager};

    /// The WebContent process behind `label`'s webview, through WKWebView's
    /// `_webProcessIdentifier` (no public API names it). None when the window
    /// is gone, the selector is missing, or the main thread did not answer.
    pub fn web_process_id(app: &AppHandle, label: &str) -> Option<i32> {
        let window = app.get_webview_window(label)?;
        let (tx, rx) = mpsc::channel();
        window
            .with_webview(move |webview| {
                let view: *mut AnyObject = webview.inner().cast();
                // SAFETY: wry's `inner()` is the live WKWebView, and the selector
                // is checked before it is sent.
                let pid = unsafe {
                    let responds: bool = msg_send![view, respondsToSelector: sel!(_webProcessIdentifier)];
                    if responds {
                        let pid: i32 = msg_send![view, _webProcessIdentifier];
                        Some(pid)
                    } else {
                        None
                    }
                };
                let _ = tx.send(pid);
            })
            .ok()?;
        rx.recv_timeout(Duration::from_secs(2)).ok().flatten().filter(|pid| *pid > 0)
    }

    /// `sample` the process for a second into `path`, bounded so a stuck
    /// symbolication never delays the restart for long.
    pub fn sample(pid: i32, path: &Path) -> bool {
        let Ok(mut child) = Command::new("/usr/bin/sample")
            .arg(pid.to_string())
            .arg("1")
            .arg("-mayDie")
            .arg("-file")
            .arg(path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            return false;
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return status.success(),
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
            }
        }
    }

    /// SIGKILL: a hung WebContent process ignores SIGTERM. Tauri's default
    /// web-content-terminate handler then reloads the page.
    pub fn kill(pid: i32) -> bool {
        Command::new("/bin/kill")
            .arg("-KILL")
            .arg(pid.to_string())
            .status()
            .is_ok_and(|status| status.success())
    }

    /// Keep the newest `keep` samples in `dir`.
    pub fn prune(dir: &Path, keep: usize) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut samples: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().is_some_and(|ext| ext == "txt"))
            .collect();
        // Names lead with a fixed-width timestamp, so name order is age order.
        samples.sort();
        let excess = samples.len().saturating_sub(keep);
        for path in samples.into_iter().take(excess) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probed(watchdog: &mut Watchdog, at: Instant) -> Vec<String> {
        let due = watchdog.queue_probes();
        for label in &due {
            assert!(watchdog.sent(label, at));
        }
        due
    }

    #[test]
    fn an_unarmed_window_is_never_probed_or_judged() {
        let mut watchdog = Watchdog::default();
        assert!(watchdog.queue_probes().is_empty());
        assert!(watchdog.hung(Instant::now() + HANG_AFTER * 10).is_empty());
    }

    #[test]
    fn a_window_silent_for_the_threshold_is_hung_once() {
        let mut watchdog = Watchdog::default();
        watchdog.arm("main");
        let t0 = Instant::now();
        assert_eq!(probed(&mut watchdog, t0), ["main"]);
        assert!(watchdog.hung(t0 + HANG_AFTER - Duration::from_millis(1)).is_empty());
        assert_eq!(watchdog.hung(t0 + HANG_AFTER), ["main"]);
        // Disarmed by the verdict: the reloaded page arms again.
        assert!(watchdog.hung(t0 + HANG_AFTER * 2).is_empty());
        assert!(watchdog.queue_probes().is_empty());
    }

    #[test]
    fn an_answer_starts_the_count_over() {
        let mut watchdog = Watchdog::default();
        watchdog.arm("main");
        let t0 = Instant::now();
        probed(&mut watchdog, t0);
        watchdog.answered("main");
        assert!(watchdog.hung(t0 + HANG_AFTER).is_empty());
        let t1 = t0 + HANG_AFTER;
        assert_eq!(probed(&mut watchdog, t1), ["main"]);
        assert!(watchdog.hung(t1 + HANG_AFTER - Duration::from_millis(1)).is_empty());
    }

    #[test]
    fn a_probe_still_queued_never_counts() {
        let mut watchdog = Watchdog::default();
        watchdog.arm("main");
        let t0 = Instant::now();
        assert_eq!(watchdog.queue_probes(), ["main"]);
        // The main thread never got to it: no clock is running.
        assert!(watchdog.hung(t0 + HANG_AFTER * 10).is_empty());
        // Nor is a second probe queued behind the first.
        assert!(watchdog.queue_probes().is_empty());
    }

    #[test]
    fn a_host_stall_starts_every_count_over() {
        let mut watchdog = Watchdog::default();
        watchdog.arm("main");
        watchdog.arm("ws-1");
        let t0 = Instant::now();
        probed(&mut watchdog, t0);
        watchdog.restart_counts();
        assert!(!watchdog.sent("main", t0), "a probe from before the stall no longer counts");
        assert!(watchdog.hung(t0 + HANG_AFTER).is_empty());
        assert_eq!(watchdog.queue_probes(), ["main", "ws-1"]);
    }

    #[test]
    fn disarming_drops_the_window_and_its_late_answer() {
        let mut watchdog = Watchdog::default();
        watchdog.arm("main");
        let t0 = Instant::now();
        probed(&mut watchdog, t0);
        watchdog.disarm("main");
        watchdog.answered("main");
        assert!(watchdog.hung(t0 + HANG_AFTER).is_empty());
        assert!(watchdog.queue_probes().is_empty());
    }

    #[test]
    fn only_the_silent_window_is_hung() {
        let mut watchdog = Watchdog::default();
        watchdog.arm("main");
        watchdog.arm("ws-1");
        let t0 = Instant::now();
        probed(&mut watchdog, t0);
        watchdog.answered("main");
        assert_eq!(watchdog.hung(t0 + HANG_AFTER), ["ws-1"]);
        assert_eq!(watchdog.queue_probes(), ["main"]);
    }

    #[test]
    fn enabled_follows_the_override_then_the_build() {
        assert!(enabled(Some("1")));
        assert!(!enabled(Some("0")));
        assert_eq!(enabled(None), !cfg!(debug_assertions));
        assert_eq!(enabled(Some("yes")), !cfg!(debug_assertions));
    }
}
