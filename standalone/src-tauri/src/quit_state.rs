//! The quit machine: every window votes, then they tear down one at a time.
//!
//! Two windows made the old "confirm then destroy" flow unsafe — a cancel in
//! the last window could not put back the ones already destroyed — so a quit is
//! now vote-then-walk (docs/specs/standalone.md -> "Quit flow"). The state
//! transitions live here, free of Tauri, and hand the caller a list of actions
//! to perform; `lib.rs` owns the emitting, destroying and exiting.

use crate::routing::quit_order;
use std::collections::HashMap;

/// What the caller must do after a transition, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuitAction {
    /// Emit `dormouse://quit-requested` to every window.
    RequestAll,
    /// Emit `dormouse://quit-cancelled` to every window; nothing was destroyed.
    CancelAll,
    /// Emit `dormouse://quit-teardown` to one window. `last` is what tells it to
    /// install a pending update and call `quit_proceed` instead of
    /// `quit_window_done`.
    Teardown { label: String, last: bool },
    /// Destroy a window whose teardown finished. Its snapshot stays on disk —
    /// that is the point of a quit, as against a close.
    Destroy { label: String },
    /// `app.exit(0)`.
    Exit,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum QuitPhase {
    #[default]
    Idle,
    /// Every window is deciding; nothing has been destroyed and a cancel here
    /// costs nothing.
    Voting,
    /// The votes are in and the windows are tearing down in `order`, `main`
    /// last. A cancel from here is refused: the first window is already gone.
    Walking { order: Vec<String>, index: usize },
}

#[derive(Debug, Clone, Default)]
pub struct WindowQuit {
    /// The webview's listener answered, so the ack watchdog stands down.
    pub acked: bool,
    /// It has decided to quit (its confirmation and archive gates are done).
    pub voted: bool,
    /// Teardown has actually begun in this window, so the deadline may run.
    pub tearing_down: bool,
    /// Bumped at each teardown phase boundary; the watchdog treats a bump as
    /// progress and refreshes its budget.
    pub progress: u64,
}

#[derive(Debug, Default)]
pub struct QuitMachine {
    /// Bumped on every trigger and every cancel. A watchdog captures the value
    /// it was spawned for and exits without acting once it no longer matches.
    pub seq: u64,
    /// Cleared to exit: gates the `CloseRequested` / `ExitRequested` arms so the
    /// flow's own `app.exit(0)` is not re-caught.
    pub approved: bool,
    pub phase: QuitPhase,
    pub windows: HashMap<String, WindowQuit>,
}

impl QuitMachine {
    /// A quit trigger over the live windows.
    ///
    /// Never clears a window's `tearing_down`: a repeat trigger fired
    /// mid-teardown must keep it set, or the fresh watchdog drops into the
    /// unbounded voting wait and stops bounding the teardown in flight.
    pub fn request(&mut self, labels: &[String]) -> (u64, Vec<QuitAction>) {
        self.seq += 1;
        let walking = matches!(self.phase, QuitPhase::Walking { .. });
        let mut next: HashMap<String, WindowQuit> = HashMap::new();
        for label in labels {
            let mut entry = self.windows.remove(label).unwrap_or_default();
            entry.acked = false;
            if !walking {
                entry.voted = false;
            }
            next.insert(label.clone(), entry);
        }
        self.windows = next;
        if !walking {
            self.phase = QuitPhase::Voting;
        }
        (self.seq, vec![QuitAction::RequestAll])
    }

    pub fn ack(&mut self, label: &str) {
        self.windows.entry(label.to_string()).or_default().acked = true;
    }

    pub fn progress(&mut self, label: &str) {
        let entry = self.windows.entry(label.to_string()).or_default();
        entry.tearing_down = true;
        entry.progress += 1;
    }

    /// This window is ready to be torn down. The last vote starts the walk.
    pub fn vote(&mut self, label: &str) -> Vec<QuitAction> {
        if self.phase != QuitPhase::Voting {
            return Vec::new();
        }
        self.windows.entry(label.to_string()).or_default().voted = true;
        if !self.windows.values().all(|entry| entry.voted) {
            return Vec::new();
        }
        self.start_walk()
    }

    /// Somebody said no. Only reachable while voting — once the walk starts the
    /// first window is already gone, so there is nothing to put back.
    pub fn cancel(&mut self) -> Vec<QuitAction> {
        if self.phase != QuitPhase::Voting {
            return Vec::new();
        }
        self.seq += 1;
        self.phase = QuitPhase::Idle;
        for entry in self.windows.values_mut() {
            entry.voted = false;
        }
        vec![QuitAction::CancelAll]
    }

    /// A window finished its teardown. It is destroyed and the next one begins.
    pub fn window_done(&mut self, label: &str) -> Vec<QuitAction> {
        let QuitPhase::Walking { order, index } = &mut self.phase else {
            return Vec::new();
        };
        if order.get(*index).map(String::as_str) != Some(label) {
            return Vec::new();
        }
        *index += 1;
        let next = order.get(*index).cloned();
        let last = *index + 1 == order.len();
        self.windows.remove(label);
        let mut actions = vec![QuitAction::Destroy {
            label: label.to_string(),
        }];
        match next {
            Some(label) => actions.push(QuitAction::Teardown { label, last }),
            // The last window calls `proceed`, not `done`; reaching here means
            // it did neither, so exit rather than wait forever.
            None => actions.push(QuitAction::Exit),
        }
        actions
    }

    pub fn proceed(&mut self) -> Vec<QuitAction> {
        self.approved = true;
        vec![QuitAction::Exit]
    }

    /// A window left outside the quit flow (a per-window close, or a crash).
    /// Its vote can never arrive, so the flow must not wait on it.
    pub fn forget_window(&mut self, label: &str) -> Vec<QuitAction> {
        self.windows.remove(label);
        match &mut self.phase {
            QuitPhase::Idle => Vec::new(),
            QuitPhase::Voting => {
                if self.windows.is_empty() || !self.windows.values().all(|entry| entry.voted) {
                    return Vec::new();
                }
                self.start_walk()
            }
            QuitPhase::Walking { order, index } => {
                let Some(position) = order.iter().position(|entry| entry == label) else {
                    return Vec::new();
                };
                order.remove(position);
                if position > *index {
                    return Vec::new();
                }
                if position < *index {
                    *index -= 1;
                    return Vec::new();
                }
                // It was the window being torn down: advance onto the next.
                let next = order.get(*index).cloned();
                let last = *index + 1 == order.len();
                match next {
                    Some(label) => vec![QuitAction::Teardown { label, last }],
                    None => vec![QuitAction::Exit],
                }
            }
        }
    }

    /// Whether a watchdog spawned for `seq` still speaks for the live quit.
    pub fn stale(&self, seq: u64) -> bool {
        self.seq != seq || self.approved
    }

    pub fn all_acked(&self) -> bool {
        self.windows.values().all(|entry| entry.acked)
    }

    /// The window currently tearing down and its progress counter, for the
    /// per-phase watchdog budget.
    pub fn walking_progress(&self) -> Option<(String, u64)> {
        let QuitPhase::Walking { order, index } = &self.phase else {
            return None;
        };
        let label = order.get(*index)?;
        Some((
            label.clone(),
            self.windows.get(label).map_or(0, |entry| entry.progress),
        ))
    }

    fn start_walk(&mut self) -> Vec<QuitAction> {
        let order = quit_order(self.windows.keys());
        let Some(first) = order.first().cloned() else {
            self.phase = QuitPhase::Idle;
            self.approved = true;
            return vec![QuitAction::Exit];
        };
        let last = order.len() == 1;
        self.phase = QuitPhase::Walking { order, index: 0 };
        vec![QuitAction::Teardown { label: first, last }]
    }
}

/// The per-window close handshake (docs/specs/standalone.md -> "Per-window
/// close"). Much smaller than a quit: one window decides, nothing else waits on
/// it, and the app keeps running either way.
#[derive(Debug, Default)]
pub struct CloseMachine {
    pending: HashMap<String, CloseEntry>,
}

#[derive(Debug, Default, Clone)]
struct CloseEntry {
    seq: u64,
    acked: bool,
}

impl CloseMachine {
    /// Begin (or re-trigger) a close on `label`, returning the seq its watchdog
    /// should capture.
    pub fn request(&mut self, label: &str) -> u64 {
        let entry = self.pending.entry(label.to_string()).or_default();
        entry.seq += 1;
        entry.acked = false;
        entry.seq
    }

    pub fn ack(&mut self, label: &str) {
        if let Some(entry) = self.pending.get_mut(label) {
            entry.acked = true;
        }
    }

    /// The user declined, or the window is gone: forget the pending close so a
    /// live watchdog stops speaking for it.
    pub fn clear(&mut self, label: &str) {
        self.pending.remove(label);
    }

    /// Whether a watchdog spawned for `seq` still speaks for `label`'s close.
    pub fn stale(&self, label: &str, seq: u64) -> bool {
        self.pending.get(label).map(|entry| entry.seq) != Some(seq)
    }

    pub fn acked(&self, label: &str) -> bool {
        self.pending.get(label).is_some_and(|entry| entry.acked)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn all_votes_walk_the_windows_with_main_last() {
        let mut quit = QuitMachine::default();
        let (seq, actions) = quit.request(&labels(&["main", "ws-2"]));
        assert_eq!(seq, 1);
        assert_eq!(actions, vec![QuitAction::RequestAll]);

        quit.ack("main");
        quit.ack("ws-2");
        assert!(quit.all_acked());

        // One vote is not enough; nothing has been destroyed.
        assert_eq!(quit.vote("main"), Vec::new());
        assert_eq!(quit.phase, QuitPhase::Voting);

        assert_eq!(
            quit.vote("ws-2"),
            vec![QuitAction::Teardown {
                label: "ws-2".into(),
                last: false
            }]
        );
        assert_eq!(
            quit.window_done("ws-2"),
            vec![
                QuitAction::Destroy {
                    label: "ws-2".into()
                },
                QuitAction::Teardown {
                    label: "main".into(),
                    last: true
                }
            ]
        );
        assert_eq!(quit.proceed(), vec![QuitAction::Exit]);
        assert!(quit.approved);
    }

    #[test]
    fn any_cancel_aborts_with_nothing_destroyed() {
        let mut quit = QuitMachine::default();
        quit.request(&labels(&["main", "ws-2"]));
        quit.vote("main");
        let actions = quit.cancel();
        assert_eq!(actions, vec![QuitAction::CancelAll]);
        assert_eq!(quit.phase, QuitPhase::Idle);
        assert!(!quit.approved);
        // The earlier vote is forgotten, so a fresh quit asks again.
        assert!(quit.windows.values().all(|entry| !entry.voted));
        // A vote arriving after the cancel is stale and starts nothing.
        assert_eq!(quit.vote("ws-2"), Vec::new());
        assert_eq!(quit.phase, QuitPhase::Idle);
    }

    #[test]
    fn a_cancel_after_the_walk_started_is_refused() {
        let mut quit = QuitMachine::default();
        quit.request(&labels(&["main"]));
        quit.vote("main");
        assert!(matches!(quit.phase, QuitPhase::Walking { .. }));
        assert_eq!(quit.cancel(), Vec::new());
        assert!(matches!(quit.phase, QuitPhase::Walking { .. }));
    }

    #[test]
    fn a_repeat_trigger_re_emits_without_clearing_tearing_down() {
        let mut quit = QuitMachine::default();
        quit.request(&labels(&["main", "ws-2"]));
        quit.vote("main");
        quit.vote("ws-2");
        quit.progress("ws-2");
        assert_eq!(quit.walking_progress(), Some(("ws-2".into(), 1)));

        let (seq, actions) = quit.request(&labels(&["main", "ws-2"]));
        assert_eq!(seq, 2);
        assert_eq!(actions, vec![QuitAction::RequestAll]);
        // The walk survives, and so does the in-flight teardown's own flag.
        assert!(matches!(quit.phase, QuitPhase::Walking { .. }));
        assert!(quit.windows["ws-2"].tearing_down);
        // The stale watchdog stands down; the fresh one bounds the same teardown.
        assert!(quit.stale(1));
        assert!(!quit.stale(2));
    }

    #[test]
    fn the_last_window_exits_and_a_destroy_cannot_re_enter() {
        let mut quit = QuitMachine::default();
        quit.request(&labels(&["main"]));
        assert_eq!(
            quit.vote("main"),
            vec![QuitAction::Teardown {
                label: "main".into(),
                last: true
            }]
        );
        // `window_done` on the last window is the defensive path: exit anyway.
        assert_eq!(
            quit.window_done("main"),
            vec![
                QuitAction::Destroy {
                    label: "main".into()
                },
                QuitAction::Exit
            ]
        );
        // A `done` for a window that is not the current one changes nothing.
        assert_eq!(quit.window_done("ws-9"), Vec::new());
    }

    #[test]
    fn a_window_that_leaves_mid_vote_does_not_hold_the_quit_open() {
        let mut quit = QuitMachine::default();
        quit.request(&labels(&["main", "ws-2"]));
        quit.vote("main");
        assert_eq!(
            quit.forget_window("ws-2"),
            vec![QuitAction::Teardown {
                label: "main".into(),
                last: true
            }]
        );
    }

    #[test]
    fn a_window_that_leaves_mid_walk_advances_the_order() {
        let mut quit = QuitMachine::default();
        quit.request(&labels(&["main", "ws-2", "ws-3"]));
        quit.vote("main");
        quit.vote("ws-2");
        let actions = quit.vote("ws-3");
        let QuitAction::Teardown { label: first, .. } = &actions[0] else {
            panic!("expected a teardown");
        };
        // Whoever is being torn down vanishes: the next one starts.
        let next = quit.forget_window(first);
        assert!(matches!(next.as_slice(), [QuitAction::Teardown { .. }]));
    }

    #[test]
    fn a_per_window_close_tracks_its_own_ack_and_supersedes_itself() {
        let mut close = CloseMachine::default();
        let first = close.request("ws-2");
        assert!(!close.acked("ws-2"));
        close.ack("ws-2");
        assert!(close.acked("ws-2"));
        // A second close request supersedes the first watchdog.
        let second = close.request("ws-2");
        assert!(close.stale("ws-2", first));
        assert!(!close.stale("ws-2", second));
        close.clear("ws-2");
        assert!(close.stale("ws-2", second));
    }
}
