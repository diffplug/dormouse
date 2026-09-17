//! The quit machine: every window votes, then they tear down one at a time.
//!
//! Two windows made the old "confirm then destroy" flow unsafe — a cancel in
//! the last window could not put back the ones already destroyed — so a quit is
//! now vote-then-walk (docs/specs/standalone.md -> "Quit flow"). The state
//! transitions live here, free of Tauri, and hand the caller a list of actions
//! to perform; `lib.rs` owns the emitting, destroying and exiting.

use crate::routing::{quit_order, Arrivals};
use std::collections::{HashMap, HashSet};
use std::ops::{Deref, DerefMut};

/// Every Workspace in flight (the `routing::Arrivals` this derefs to) and the
/// user teardown requests delayed until their transfers settle, behind one
/// lock: a request queues against the same records a transfer is admitted
/// against, so a settlement cannot miss a request queued concurrently. A quit
/// absorbs earlier per-window closes; cancellation and destruction retire
/// queued work.
#[derive(Default)]
pub struct ArrivalQueue {
    records: Arrivals,
    /// The queued quit, if any, and whether it relaunches. The first request
    /// to queue fixes the intent, as leaving `Idle` does for `QuitMachine`.
    quit: Option<bool>,
    closes: HashSet<String>,
}

impl Deref for ArrivalQueue {
    type Target = Arrivals;
    fn deref(&self) -> &Arrivals { &self.records }
}

impl DerefMut for ArrivalQueue {
    fn deref_mut(&mut self) -> &mut Arrivals { &mut self.records }
}

impl ArrivalQueue {
    /// Queue a quit while anything is in flight. `None` means nothing is in
    /// flight and the quit runs now; otherwise the queued quit's restart intent.
    pub fn defer_quit(&mut self, restart: bool) -> Option<bool> {
        if self.records.is_empty() { return None; }
        let intent = *self.quit.get_or_insert(restart);
        self.closes.clear();
        Some(intent)
    }
    /// Queue `label`'s close while it is either end of a transfer; whether it
    /// was queued (a queued quit absorbs it).
    pub fn defer_close(&mut self, label: &str) -> bool {
        if !self.records.iter().any(|arrival| arrival.from == label || arrival.to == label) { return false; }
        if self.quit.is_none() { self.closes.insert(label.to_string()); }
        true
    }
    pub fn blocks_transfer(&self, from: &str, to: &str) -> bool {
        self.quit.is_some() || self.closes.contains(from) || self.closes.contains(to)
    }
    pub fn cancel_deferred(&mut self) { self.quit = None; self.closes.clear(); }
    pub fn forget_deferred_close(&mut self, label: &str) { self.closes.remove(label); }
    /// Take the requests no transfer holds any more: the quit (with its restart
    /// intent) once nothing is in flight, else every close whose window is no
    /// endpoint. `live` (the open window labels) is read only when something is
    /// queued.
    pub fn take_ready(&mut self, live: impl FnOnce() -> HashSet<String>) -> (Option<bool>, Vec<String>) {
        if self.quit.is_none() && self.closes.is_empty() { return (None, Vec::new()); }
        let live = live();
        self.closes.retain(|label| live.contains(label));
        if self.quit.is_some() {
            if self.records.is_empty() { return (self.quit.take(), Vec::new()); }
            return (None, Vec::new());
        }
        let endpoints: HashSet<&str> =
            self.records.iter().flat_map(|arrival| [arrival.from.as_str(), arrival.to.as_str()]).collect();
        let ready: Vec<_> = self.closes.iter().filter(|label| !endpoints.contains(label.as_str())).cloned().collect();
        for label in &ready { self.closes.remove(label); }
        (None, ready)
    }
}

/// An approved quit waits for destroyed windows to journal their hand-backs.
#[derive(Default)]
pub struct CleanupGate {
    pending: usize,
    pub exit_requested: bool,
    forced: bool,
}

impl CleanupGate {
    pub fn begin(&mut self) { self.pending += 1; }
    pub fn request_exit(&mut self) -> bool {
        if self.pending == 0 || self.forced { return true; }
        self.exit_requested = true;
        false
    }
    pub fn force_if_waiting(&mut self) -> bool {
        if self.pending == 0 || !self.exit_requested { return false; }
        self.forced = true;
        true
    }
    pub fn finish(&mut self) -> bool {
        self.pending -= 1;
        self.pending == 0 && std::mem::take(&mut self.exit_requested)
    }
}

/// What the caller must do after a transition, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuitAction {
    /// Emit `dormouse://quit-requested` to every window, carrying the quit's
    /// restart intent so each dialog can say what happens next.
    RequestAll { restart: bool },
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
    /// Bumped at each teardown phase boundary; the watchdog treats a bump as
    /// progress and refreshes its budget.
    pub progress: u64,
}

/// What forgetting a window leaves the machine owing, decided while `phase` is
/// borrowed and applied once it is not.
enum Forgotten {
    Nothing,
    Walk,
    Exit,
    Teardown(String, bool),
}

#[derive(Debug, Default)]
pub struct QuitMachine {
    /// Bumped on every trigger and every cancel. A watchdog captures the value
    /// it was spawned for and exits without acting once it no longer matches.
    pub seq: u64,
    /// Cleared to exit: gates the `CloseRequested` / `ExitRequested` arms so the
    /// flow's own `app.exit(0)` is not re-caught.
    pub approved: bool,
    /// The approved exit relaunches the app (docs/specs/standalone.md ->
    /// "Restart"). Fixed by the trigger that leaves `Idle` before approval; a
    /// repeat trigger keeps it, and a cancel clears it.
    pub restart: bool,
    pub phase: QuitPhase,
    pub windows: HashMap<String, WindowQuit>,
}

impl QuitMachine {
    /// A quit trigger over the live windows; `restart` is its intent, which only
    /// the trigger leaving `Idle` unapproved may set.
    ///
    /// Clears `voted` only from `Idle`. A vote already cast stands through a
    /// repeat trigger: the webview that cast it is committed and answers the
    /// re-request with an ack alone, so clearing it would leave the machine in
    /// `Voting` with no dialog left to answer. Once the walk has started the
    /// repeat must also leave the walk in flight, or the fresh watchdog drops
    /// into the unbounded voting wait and stops bounding it.
    pub fn request(&mut self, labels: &[String], restart: bool) -> (u64, Vec<QuitAction>) {
        self.seq += 1;
        let idle = self.phase == QuitPhase::Idle;
        // An approved exit parked on the cleanup gate is `Idle` too, and a
        // Cmd+Q landing there must not rewrite what that exit does.
        if idle && !self.approved {
            self.restart = restart;
        }
        let walking = matches!(self.phase, QuitPhase::Walking { .. });
        let mut next: HashMap<String, WindowQuit> = HashMap::new();
        for label in labels {
            let mut entry = self.windows.remove(label).unwrap_or_default();
            entry.acked = false;
            if idle {
                entry.voted = false;
            }
            next.insert(label.clone(), entry);
        }
        self.windows = next;
        // Nothing left to ask. An `ExitRequested` raised after the last window
        // was closed would otherwise park the machine in `Voting` with no
        // window to vote and refuse every later exit.
        if self.windows.is_empty() {
            return (self.seq, self.exit());
        }
        if !walking {
            self.phase = QuitPhase::Voting;
        }
        (self.seq, vec![QuitAction::RequestAll { restart: self.restart }])
    }

    pub fn ack(&mut self, label: &str) {
        self.windows.entry(label.to_string()).or_default().acked = true;
    }

    pub fn progress(&mut self, label: &str) {
        self.windows.entry(label.to_string()).or_default().progress += 1;
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
        self.restart = false;
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
    ///
    /// **A live quit that runs out of windows exits**: every window is gone and
    /// nothing is left to tear down, so holding the phase open would leave a
    /// headless process nobody can reach.
    pub fn forget_window(&mut self, label: &str) -> Vec<QuitAction> {
        self.windows.remove(label);
        // Decided against a borrow of `phase` alone, then applied: `exit` and
        // `start_walk` both need the whole machine.
        let next = match &mut self.phase {
            QuitPhase::Idle => Forgotten::Nothing,
            QuitPhase::Voting => {
                if self.windows.is_empty() {
                    Forgotten::Exit
                } else if self.windows.values().all(|entry| entry.voted) {
                    Forgotten::Walk
                } else {
                    Forgotten::Nothing
                }
            }
            QuitPhase::Walking { order, index } => {
                match order.iter().position(|entry| entry == label) {
                    None => Forgotten::Nothing,
                    Some(position) => {
                        order.remove(position);
                        if order.is_empty() {
                            Forgotten::Exit
                        } else if position > *index {
                            Forgotten::Nothing
                        } else if position < *index {
                            *index -= 1;
                            Forgotten::Nothing
                        } else {
                            // It was the window being torn down: advance.
                            match order.get(*index).cloned() {
                                Some(label) => {
                                    Forgotten::Teardown(label, *index + 1 == order.len())
                                }
                                None => Forgotten::Exit,
                            }
                        }
                    }
                }
            }
        };
        match next {
            Forgotten::Nothing => Vec::new(),
            Forgotten::Walk => self.start_walk(),
            Forgotten::Exit => self.exit(),
            Forgotten::Teardown(label, last) => vec![QuitAction::Teardown { label, last }],
        }
    }

    /// Nothing left to ask or to tear down. Approving here is what stops the
    /// `app.exit(0)` this returns from re-entering the flow as a fresh quit.
    fn exit(&mut self) -> Vec<QuitAction> {
        self.phase = QuitPhase::Idle;
        self.approved = true;
        vec![QuitAction::Exit]
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
            return self.exit();
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
    active: bool,
    seq: u64,
    acked: bool,
}

impl CloseMachine {
    /// Begin (or re-trigger) a close on `label`, returning the seq its watchdog
    /// should capture.
    pub fn request(&mut self, label: &str) -> u64 {
        let entry = self.pending.entry(label.to_string()).or_default();
        entry.seq += 1;
        entry.active = true;
        entry.acked = false;
        entry.seq
    }

    pub fn ack(&mut self, label: &str) {
        if let Some(entry) = self.pending.get_mut(label) {
            entry.acked = true;
        }
    }

    /// The user declined, or the window is gone: retire the pending close so a
    /// live watchdog stops speaking for it. **The seq is bumped, never reused**
    /// — removing the entry hands the next `request` for this label the same
    /// token a sleeping watchdog still holds, which would then destroy the
    /// window out from under its second dialog.
    pub fn clear(&mut self, label: &str) {
        if let Some(entry) = self.pending.get_mut(label) {
            entry.seq += 1;
            entry.active = false;
            entry.acked = false;
        }
    }

    /// Whether a watchdog spawned for `seq` still speaks for `label`'s close.
    pub fn stale(&self, label: &str, seq: u64) -> bool {
        self.pending.get(label).map(|entry| entry.seq) != Some(seq)
    }

    pub fn active(&self, label: &str) -> bool {
        self.pending.get(label).is_some_and(|entry| entry.active)
    }

    pub fn acked(&self, label: &str) -> bool {
        self.pending.get(label).is_some_and(|entry| entry.acked)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arrival(from: &str, to: &str) -> crate::routing::Arrival {
        crate::routing::Arrival {
            workspace_id: format!("{from}-to-{to}"),
            from: from.to_string(),
            to: to.to_string(),
            terminal_ids: Vec::new(),
            payload: serde_json::Value::Null,
            queued_at: std::time::Instant::now(),
            content: None,
            pending_window: None,
        }
    }

    #[test]
    fn deferred_quit_and_close_requests_wait_for_membership_then_run_once() {
        let mut queue = ArrivalQueue::default();
        let live = || HashSet::from(["main".to_string(), "ws-2".to_string(), "ws-3".to_string()]);
        let quiet = || -> HashSet<String> { panic!("nothing is queued, so no live labels are read") };
        // Nothing in flight: nothing to wait behind, so neither request queues.
        assert_eq!(queue.defer_quit(false), None);
        assert!(!queue.defer_close("ws-2"));
        assert_eq!(queue.take_ready(quiet), (None, vec![]));
        queue.push(arrival("main", "ws-2"));
        assert!(!queue.defer_close("ws-3")); // not an endpoint, so it closes now
        assert!(!queue.blocks_transfer("ws-3", "main"));
        assert!(queue.defer_close("ws-2"));
        assert!(queue.defer_close("ws-2")); // a repeated click coalesces
        assert!(queue.blocks_transfer("ws-3", "ws-2"));
        assert_eq!(queue.take_ready(live), (None, vec![]));
        let settled = queue.pop().unwrap();
        assert_eq!(queue.take_ready(live), (None, vec!["ws-2".into()]));
        assert_eq!(queue.take_ready(quiet), (None, vec![]));
        queue.push(settled);
        queue.defer_close("ws-2");
        assert_eq!(queue.defer_quit(false), Some(false)); // quit supersedes queued window closes
        assert!(queue.defer_close("ws-2"));
        assert!(queue.blocks_transfer("ws-3", "main"));
        assert_eq!(queue.take_ready(live), (None, vec![]));
        let settled = queue.pop().unwrap();
        assert_eq!(queue.take_ready(live), (Some(false), vec![]));
        assert_eq!(queue.take_ready(quiet), (None, vec![]));
        queue.push(settled);
        queue.defer_quit(false);
        queue.cancel_deferred();
        assert_eq!(queue.take_ready(quiet), (None, vec![]));
        queue.push(arrival("gone", "main"));
        queue.defer_close("ws-2");
        queue.forget_deferred_close("ws-2");
        queue.defer_close("gone");
        queue.clear();
        assert_eq!(queue.take_ready(live), (None, vec![]));
        assert_eq!(queue.take_ready(quiet), (None, vec![]));
        assert!(!queue.blocks_transfer("main", "ws-2"));
    }

    #[test]
    fn stalled_cleanup_cannot_block_an_approved_exit_forever() {
        let mut gate = CleanupGate::default();
        gate.begin();
        assert!(!gate.force_if_waiting()); // no quit requested yet
        assert!(!gate.request_exit());
        assert!(gate.force_if_waiting()); // cleanup watchdog expired
        assert!(gate.request_exit());
        assert!(gate.finish()); // late completion remains safe
        assert!(!gate.force_if_waiting());
    }

    #[test]
    fn quit_waits_for_every_destroyed_window_handback() {
        let mut gate = CleanupGate::default();
        gate.begin();
        gate.begin();
        assert!(!gate.request_exit());
        assert!(!gate.finish());
        assert!(!gate.request_exit());
        assert!(gate.finish());
        assert!(gate.request_exit());
        gate.begin();
        assert!(!gate.finish()); // ordinary close does not request a quit
    }

    fn labels(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn all_votes_walk_the_windows_with_main_last() {
        let mut quit = QuitMachine::default();
        let (seq, actions) = quit.request(&labels(&["main", "ws-2"]), false);
        assert_eq!(seq, 1);
        assert_eq!(actions, vec![QuitAction::RequestAll { restart: false }]);

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
        quit.request(&labels(&["main", "ws-2"]), false);
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
        quit.request(&labels(&["main"]), false);
        quit.vote("main");
        assert!(matches!(quit.phase, QuitPhase::Walking { .. }));
        assert_eq!(quit.cancel(), Vec::new());
        assert!(matches!(quit.phase, QuitPhase::Walking { .. }));
    }

    #[test]
    fn a_repeat_trigger_re_emits_without_interrupting_the_walk() {
        let mut quit = QuitMachine::default();
        quit.request(&labels(&["main", "ws-2"]), false);
        quit.vote("main");
        quit.vote("ws-2");
        quit.progress("ws-2");
        assert_eq!(quit.walking_progress(), Some(("ws-2".into(), 1)));

        let (seq, actions) = quit.request(&labels(&["main", "ws-2"]), false);
        assert_eq!(seq, 2);
        assert_eq!(actions, vec![QuitAction::RequestAll { restart: false }]);
        // The walk survives, and so does the in-flight teardown's progress —
        // which is what keeps the fresh watchdog bounding it rather than
        // dropping into the unbounded voting wait.
        assert!(matches!(quit.phase, QuitPhase::Walking { .. }));
        assert_eq!(quit.walking_progress(), Some(("ws-2".into(), 1)));
        // The stale watchdog stands down; the fresh one bounds the same teardown.
        assert!(quit.stale(1));
        assert!(!quit.stale(2));
    }

    #[test]
    fn a_repeat_trigger_while_voting_keeps_the_votes_already_cast() {
        let mut quit = QuitMachine::default();
        quit.request(&labels(&["main", "ws-2"]), false);
        // `main` had nothing running and voted at once; `ws-2` is on its dialog.
        quit.vote("main");
        assert_eq!(quit.phase, QuitPhase::Voting);

        // Cmd+Q again: `main` is committed and only re-acks, never re-votes.
        let (seq, actions) = quit.request(&labels(&["main", "ws-2"]), false);
        assert_eq!(seq, 2);
        assert_eq!(actions, vec![QuitAction::RequestAll { restart: false }]);
        assert_eq!(quit.phase, QuitPhase::Voting);

        // The dialog's yes is the last vote: the walk starts instead of wedging.
        let actions = quit.vote("ws-2");
        assert!(matches!(quit.phase, QuitPhase::Walking { .. }));
        assert!(!actions.is_empty());
    }

    #[test]
    fn a_cancelled_quit_asks_every_window_again() {
        let mut quit = QuitMachine::default();
        quit.request(&labels(&["main", "ws-2"]), false);
        quit.vote("main");
        quit.cancel();
        assert_eq!(quit.phase, QuitPhase::Idle);

        // From Idle every vote is fresh: `main` alone no longer carries the quit.
        quit.request(&labels(&["main", "ws-2"]), false);
        quit.vote("ws-2");
        assert_eq!(quit.phase, QuitPhase::Voting);
        quit.vote("main");
        assert!(matches!(quit.phase, QuitPhase::Walking { .. }));
    }

    #[test]
    fn the_last_window_exits_and_a_destroy_cannot_re_enter() {
        let mut quit = QuitMachine::default();
        quit.request(&labels(&["main"]), false);
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
        quit.request(&labels(&["main", "ws-2"]), false);
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
        quit.request(&labels(&["main", "ws-2", "ws-3"]), false);
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

    /// Every window went away while the quit was still running — each one
    /// closed, or crashed. There is nothing left to ask and nothing left to tear
    /// down, so the app exits rather than living on with no window.
    #[test]
    fn a_quit_that_runs_out_of_windows_exits_instead_of_going_headless() {
        let mut voting = QuitMachine::default();
        voting.request(&labels(&["main", "ws-2"]), false);
        assert_eq!(voting.forget_window("main"), Vec::new());
        assert_eq!(voting.forget_window("ws-2"), vec![QuitAction::Exit]);
        // Approved, so the `app.exit(0)` this asks for is not re-caught as a
        // fresh quit trigger.
        assert!(voting.approved);

        let mut walking = QuitMachine::default();
        walking.request(&labels(&["main", "ws-2"]), false);
        walking.vote("main");
        walking.vote("ws-2");
        assert!(matches!(walking.phase, QuitPhase::Walking { .. }));
        // The window ahead in the order leaves, then the one being torn down.
        assert_eq!(walking.forget_window("main"), Vec::new());
        assert_eq!(walking.forget_window("ws-2"), vec![QuitAction::Exit]);
        assert!(walking.approved);
    }

    /// The trigger itself found no window: `main` and `ws-2` were both closed
    /// while the other's teardown ran, and the `ExitRequested` that followed
    /// carries an empty label list. Parking in `Voting` here would leave nothing
    /// able to vote, cancel or be forgotten, and every later exit refused.
    #[test]
    fn a_trigger_with_no_windows_exits_instead_of_parking_in_voting() {
        let mut quit = QuitMachine::default();
        let (seq, actions) = quit.request(&labels(&[]), false);
        assert_eq!(seq, 1);
        assert_eq!(actions, vec![QuitAction::Exit]);
        assert_eq!(quit.phase, QuitPhase::Idle);
        assert!(quit.approved);
        assert!(quit.stale(seq), "nothing is left for a watchdog to bound");
    }

    /// A session whose `main` was closed still walks every window and still ends
    /// on one of them — which one is unspecified, because only `main` ever holds
    /// a pending update to install (docs/specs/auto-update.md).
    #[test]
    fn without_main_the_walk_still_ends_on_a_last_window() {
        let mut quit = QuitMachine::default();
        quit.request(&labels(&["ws-2", "ws-5"]), false);
        quit.vote("ws-5");
        let actions = quit.vote("ws-2");
        let [QuitAction::Teardown { label: first, last }] = actions.as_slice() else {
            panic!("expected one teardown, got {actions:?}");
        };
        assert!(!last, "two windows: the first is not the last");
        let second = if first == "ws-2" { "ws-5" } else { "ws-2" };
        assert_eq!(
            quit.window_done(first),
            vec![
                QuitAction::Destroy {
                    label: first.clone()
                },
                QuitAction::Teardown {
                    label: second.to_string(),
                    last: true
                }
            ]
        );
    }

    #[test]
    fn the_trigger_leaving_idle_fixes_the_restart_intent() {
        let mut quit = QuitMachine::default();
        let (_, actions) = quit.request(&labels(&["main", "ws-2"]), true);
        assert_eq!(actions, vec![QuitAction::RequestAll { restart: true }]);
        assert!(quit.restart);

        // A plain Cmd+Q while the restart is voting joins it; the dialogs
        // already say "restart", so the intent stands.
        let (_, actions) = quit.request(&labels(&["main", "ws-2"]), false);
        assert_eq!(actions, vec![QuitAction::RequestAll { restart: true }]);
        assert!(quit.restart);

        // A cancel forgets it, and the next trigger decides afresh.
        quit.cancel();
        assert!(!quit.restart);
        quit.request(&labels(&["main", "ws-2"]), false);
        let (_, actions) = quit.request(&labels(&["main", "ws-2"]), true);
        assert_eq!(actions, vec![QuitAction::RequestAll { restart: false }]);
        assert!(!quit.restart, "a restart joining a plain quit does not relaunch it");

        // Walking: the intent stands through a repeat trigger and the exit.
        let mut walking = QuitMachine::default();
        walking.request(&labels(&["main"]), true);
        walking.vote("main");
        walking.request(&labels(&["main"]), false);
        assert_eq!(walking.proceed(), vec![QuitAction::Exit]);
        assert!(walking.approved && walking.restart);
    }

    /// An approved exit parked on the cleanup gate sits in `Idle`, and the
    /// macOS menu's Cmd+Q still reaches `request_quit` there.
    #[test]
    fn a_trigger_after_approval_cannot_rewrite_the_exit() {
        let mut restart = QuitMachine::default();
        restart.request(&labels(&[]), true);
        assert!(restart.approved && restart.restart);
        restart.request(&labels(&[]), false);
        assert!(restart.restart, "the pending relaunch survives a late Cmd+Q");

        let mut quit = QuitMachine::default();
        quit.request(&labels(&[]), false);
        quit.request(&labels(&[]), true);
        assert!(!quit.restart, "a late restart cannot turn an approved quit into one");
    }

    #[test]
    fn a_deferred_quit_carries_its_restart_intent() {
        let mut queue = ArrivalQueue::default();
        let live = || HashSet::from(["main".to_string()]);
        assert_eq!(queue.defer_quit(true), None, "nothing in flight: the restart runs now");
        queue.push(arrival("main", "ws-2"));
        assert_eq!(queue.defer_quit(true), Some(true));
        // The first request to queue fixes the intent.
        assert_eq!(queue.defer_quit(false), Some(true));
        let settled = queue.pop().unwrap();
        assert_eq!(queue.take_ready(live), (Some(true), vec![]));
        assert_eq!(queue.take_ready(live), (None, vec![]));

        queue.push(settled);
        queue.defer_quit(true);
        queue.cancel_deferred();
        assert_eq!(queue.defer_quit(false), Some(false), "a cancel forgets the queued intent");
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

    /// Cancel, then X again while the first watchdog still sleeps: the second
    /// close must not be handed the token the first watchdog holds, or its wake
    /// would destroy the window 1.2 s into the user's second dialog.
    #[test]
    fn a_cleared_close_never_hands_its_seq_to_the_next_request() {
        let mut close = CloseMachine::default();
        let first = close.request("ws-2");
        close.ack("ws-2");
        close.clear("ws-2");
        let second = close.request("ws-2");
        assert_ne!(first, second);
        assert!(close.stale("ws-2", first), "the cancelled close's watchdog stands down");
        assert!(!close.stale("ws-2", second));
        // The cleared ack does not carry over to the new close either.
        assert!(!close.acked("ws-2"));
    }
}
