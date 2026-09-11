use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
mod log_tail;
mod quit_state;
mod routing;
mod workspaces;
// The Dock's Quit, an `osascript` quit and a logout reach AppKit without ever
// raising `RunEvent::ExitRequested` (docs/specs/standalone.md §Trigger
// interception).
#[cfg(target_os = "macos")]
mod macos_terminate;
use quit_state::{CloseMachine, QuitAction, QuitMachine};
use routing::{Route, RouteView};
use std::{
    collections::{HashMap, HashSet},
    env,
    fs::{create_dir_all, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicU64, AtomicUsize, Ordering},
    sync::mpsc,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, PredefinedMenuItem, Submenu},
    AppHandle, DragDropEvent, Emitter, Manager, RunEvent, WebviewWindowBuilder, WindowEvent,
};
#[cfg(target_os = "macos")]
use tauri::menu::MenuItem;
#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;
use process_wrap::std::{ChildWrapper, CommandWrap};
#[cfg(windows)]
use process_wrap::std::{CreationFlags, JobObject};
#[cfg(unix)]
use process_wrap::std::ProcessGroup;
#[cfg(windows)]
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

// Native Win32 clipboard reads, so a paste never spawns a console-window-popping
// PowerShell child. macOS/Linux keep the sidecar path (no console flicker there).
#[cfg(windows)]
mod clipboard_win;

// Shared with build.rs (via `#[path]`); the PE subsystem offsets live in one place.
#[cfg(windows)]
mod pe_subsystem;

type SidecarSender = mpsc::Sender<String>;
type PendingRequests = Arc<Mutex<HashMap<String, mpsc::Sender<JsonValue>>>>;
type SharedChild = Arc<Mutex<Box<dyn ChildWrapper + Send + Sync>>>;

struct SidecarState {
    tx: SidecarSender,
    pending_requests: PendingRequests,
    next_request_id: AtomicU64,
    child: SharedChild,
}

/// A lock taken for a short read or write, treating poisoning as recoverable:
/// every value behind one here is plain bookkeeping that a panicking thread
/// cannot leave half-written into an unusable shape.
fn guard<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ── Window ownership (docs/specs/standalone.md §Windows) ──────────────────────
//
// The sidecar has no window concept, so Rust keeps the map from PTY to window
// and routes every stdout line through `routing::route`.

/// The three maps a sidecar line is routed against, behind **one** lock: they
/// are always read together, so a PTY chunk costs one acquisition rather than
/// three, and every label the routing table hands back stays borrowed out of
/// this guard instead of being cloned per line.
#[derive(Default)]
struct RoutingState {
    /// ptyId -> window label. Minted only in `pty_spawn`, dropped by
    /// `pty_kill`, an exit, or a window going away; reassigned by a transfer.
    owners: HashMap<String, String>,
    /// Ids whose output is suppressed until the replay their new owner is about
    /// to be sent has been emitted, each with the instant it began.
    awaiting_replay: HashMap<String, Instant>,
    /// dor requestId -> the window handling it, so a cancel reaches the window
    /// holding the subscription, watch or completion claim it releases.
    dor_targets: HashMap<String, String>,
    /// Protocol events that arrived while their id was suppressed, delivered
    /// to the new owner behind its replay (`routing::Route::Hold`). Only ever
    /// emptied together with `awaiting_replay` (`lift_suppression`).
    held: HashMap<String, Vec<routing::HeldEvent>>,
}

impl RoutingState {
    /// `routing::lift_suppression` over this state's two halves. The caller
    /// republishes `WindowState::suppressed` after it, still under the lock.
    fn lift_suppression(&mut self, id: &str) -> Vec<routing::HeldEvent> {
        routing::lift_suppression(&mut self.awaiting_replay, &mut self.held, id)
    }
}

#[derive(Default)]
struct WindowState {
    routing: Mutex<RoutingState>,
    /// `awaiting_replay.len()`, readable without the lock. Nothing is
    /// transferring in the steady state, and this is what lets a chunk skip the
    /// sweep and the `Instant::now()` it needs.
    suppressed: AtomicUsize,
    /// Window labels, most recently focused first.
    focus_order: Mutex<Vec<String>>,
    /// Every Workspace in flight, from the source's invoke until its target
    /// adopts it or dies (`routing::Arrival`). Pulled, never pushed.
    ///
    /// **Never take this lock while holding `routing`.** `dispatch_sidecar_event`
    /// reads it before it takes `routing`, so the two are only ever acquired in
    /// that order.
    arrivals: Mutex<routing::Arrivals>,
    /// The window currently showing a cross-window drop caret, so the previous
    /// one can be told to clear it.
    hover_target: Mutex<Option<String>>,
    /// Labels whose snapshot has been deliberately removed. A save arriving
    /// from a webview that is going away must not put the file back; the entry
    /// is dropped once that webview is destroyed and can no longer save.
    closing: Mutex<HashSet<String>>,
    /// The next `ws-<n>`, seeded above every live and saved label at setup.
    next_ws: AtomicU64,
    /// Every window's Workspaces under their stable refs (§Workspace registry).
    registry: Mutex<workspaces::Registry>,
    /// The next `workspace-<n>`, seeded above every id on disk at setup and
    /// handed out in blocks so a webview can mint synchronously.
    next_workspace: AtomicU64,
}

impl RoutingState {
    /// Every id `label` owns.
    fn owned_by(&self, label: &str) -> Vec<String> {
        self.owners
            .iter()
            .filter(|(_, owner)| owner.as_str() == label)
            .map(|(id, _)| id.clone())
            .collect()
    }
}

impl WindowState {
    fn owned_by(&self, label: &str) -> Vec<String> {
        guard(&self.routing).owned_by(label)
    }

    /// A window spawned a PTY: it owns it until a transfer moves it.
    ///
    /// Clears any suppression left under this id. A spawn reusing an id whose
    /// transfer never completed would otherwise start life silenced, with no
    /// replay coming to lift it — the sweep's 5 s of a dead pane.
    fn mint(&self, id: &str, label: &str) {
        let mut routing = guard(&self.routing);
        routing.owners.insert(id.to_string(), label.to_string());
        // Whatever was held belonged to the PTY that never arrived, not this one.
        routing.lift_suppression(id);
        self.suppressed
            .store(routing.awaiting_replay.len(), Ordering::Relaxed);
    }

    /// Refuse every later `save_session` for `label` (a deliberate close removed
    /// its snapshot). Cleared by `Destroyed`, after which no save can arrive.
    fn begin_closing(&self, label: &str) {
        guard(&self.closing).insert(label.to_string());
    }

    fn refuses_save(&self, label: &str) -> bool {
        guard(&self.closing).contains(label)
    }

    /// Hand `ids` to `label`. `suppress` holds their output until each one's
    /// replay has been emitted to it (docs/specs/standalone.md §Transfer);
    /// without it the ids go straight back into service, which is how a refused
    /// arrival returns them to the window that still has them.
    fn reassign(&self, ids: &[String], label: &str, suppress: bool) {
        let mut routing = guard(&self.routing);
        let now = Instant::now();
        for id in ids {
            routing.owners.insert(id.clone(), label.to_string());
            if suppress {
                routing.awaiting_replay.insert(id.clone(), now);
            } else {
                // A hand-back. The gap is lost here: the source was suppressed
                // like any other non-owner from the invoke on, and no replay
                // follows a hand-back, so the bytes and everything derived from
                // them are gone from its pane. A later stage recovers the gap
                // (docs/specs/standalone.md -> "Arrival queue").
                routing.lift_suppression(id);
            }
        }
        self.suppressed
            .store(routing.awaiting_replay.len(), Ordering::Relaxed);
    }

    /// Forget one PTY entirely (a kill, or its exit).
    fn forget_pty(&self, id: &str) {
        let mut routing = guard(&self.routing);
        routing.owners.remove(id);
        routing.lift_suppression(id);
        self.suppressed
            .store(routing.awaiting_replay.len(), Ordering::Relaxed);
    }

    /// Drop any suppression on `ids`, leaving ownership alone. What settles an
    /// adopted arrival: each replay lifted its own on the way out, and this is
    /// the defensive clear for an id whose replay never came because the shell
    /// exited mid-transfer.
    fn clear_suppression(&self, ids: &[String]) {
        let mut routing = guard(&self.routing);
        for id in ids {
            routing.lift_suppression(id);
        }
        self.suppressed
            .store(routing.awaiting_replay.len(), Ordering::Relaxed);
    }

    /// Forget a window: its ownership, its outstanding `dor` requests and its
    /// focus entry. Returns the arrivals it can no longer take — **whose shells
    /// are deliberately not in the second half** — and the ids it owned outright,
    /// which the caller reaps.
    fn drop_window(&self, label: &str) -> (Vec<routing::Arrival>, Vec<String>) {
        // Taken first, and their ids dropped from `owners` before `owned_by`
        // reads it: an arriving shell belongs to its source again, and reaping
        // it here would kill a terminal the source is still showing.
        let lost = routing::take_arrivals_to(&mut guard(&self.arrivals), label);
        let owned = {
            let mut routing = guard(&self.routing);
            for id in lost.iter().flat_map(|arrival| &arrival.terminal_ids) {
                routing.owners.remove(id);
                routing.lift_suppression(id);
            }
            let owned = routing.owned_by(label);
            for id in &owned {
                routing.owners.remove(id);
            }
            // Its answers can never arrive, so neither can the cancels that
            // would have retired them.
            routing.dor_targets.retain(|_, target| target != label);
            self.suppressed
                .store(routing.awaiting_replay.len(), Ordering::Relaxed);
            owned
        };
        guard(&self.focus_order).retain(|entry| entry != label);
        (lost, owned)
    }

    fn touch_focus(&self, label: &str) {
        let mut order = guard(&self.focus_order);
        order.retain(|entry| entry != label);
        order.insert(0, label.to_string());
    }

    /// The most recently focused window: where a sidecar event naming no window
    /// is delivered (`Route::Focused`). The quit walk never reads focus — its
    /// order is `quit_order`, `main` last and the rest unordered.
    fn focused(&self) -> Option<String> {
        guard(&self.focus_order).first().cloned()
    }
}

/// Where one sidecar line goes, owning its label so the routing lock can be
/// released before anything is serialized or emitted.
enum Delivery {
    Nowhere,
    Broadcast,
    To(String),
    UnownedSurface { request_id: String, surface_id: String },
}

static EMPTY_REGISTRY: std::sync::LazyLock<workspaces::Registry> =
    std::sync::LazyLock::new(workspaces::Registry::default);

/// Route one sidecar stdout line to the window it belongs to.
///
/// The hot path — once per PTY chunk — so it takes the routing lock once, reads
/// no clock unless something is actually mid-transfer, and copies only the one
/// label it needs.
///
/// **Never hold the routing lock across an emit.** Serializing the payload and
/// queueing it are unbounded work with the main thread possibly parked in
/// `pty_spawn` waiting for this very lock, and Tauri's `tracing` feature swaps
/// the emit for one that blocks on a main-thread reply — which would deadlock.
fn dispatch_sidecar_event(app: &AppHandle, event: &str, data: JsonValue) {
    let Some(state) = app.try_state::<WindowState>() else {
        let _ = app.emit(event, data);
        return;
    };

    let mut released: Vec<String> = Vec::new();
    // Held events an expired suppression releases, flushed to the owner below.
    let mut flushed: Vec<(String, Vec<routing::HeldEvent>)> = Vec::new();
    let delivery = {
        // Before the routing lock, never inside it (§`arrivals`). Nothing is
        // transferring in the steady state, so this second acquisition is paid
        // only while something is.
        let arriving = if state.suppressed.load(Ordering::Relaxed) > 0 {
            routing::arrival_ids(&guard(&state.arrivals))
        } else {
            HashSet::new()
        };
        // Only a `dor` request consults the registry; a PTY chunk never pays
        // for the lock. Taken before the routing lock and released with it.
        let registry_guard = (event == "dor:controlRequest").then(|| guard(&state.registry));
        let registry: &workspaces::Registry = match registry_guard.as_deref() {
            Some(registry) => registry,
            None => &EMPTY_REGISTRY,
        };
        let mut routing = guard(&state.routing);
        if state.suppressed.load(Ordering::Relaxed) > 0 {
            released = routing::sweep_awaiting(
                &mut routing.awaiting_replay,
                Instant::now(),
                routing::AWAITING_REPLAY_MAX,
                &arriving,
            );
            if !released.is_empty() {
                state
                    .suppressed
                    .store(routing.awaiting_replay.len(), Ordering::Relaxed);
                for id in &released {
                    // The sweep already took the map entry; this takes the queue.
                    let queue = routing.lift_suppression(id);
                    if let (false, Some(label)) = (queue.is_empty(), routing.owners.get(id)) {
                        flushed.push((label.clone(), queue));
                    }
                }
            }
        }

        match routing::route(
            event,
            &data,
            &RouteView {
                owners: &routing.owners,
                awaiting_replay: &routing.awaiting_replay,
                dor_targets: &routing.dor_targets,
                registry: &registry,
            },
        ) {
            Route::Drop => Delivery::Nowhere,
            Route::Hold => {
                if let Some(id) = data.get("id").and_then(JsonValue::as_str) {
                    routing::hold_event(&mut routing.held, id, event, data.clone());
                }
                Delivery::Nowhere
            }
            Route::Broadcast => Delivery::Broadcast,
            Route::EmitTo(label) => Delivery::To(label.to_string()),
            // Resolved here, where the focus order is a sibling of the map the
            // table read; the lock over it is separate and taken for one clone.
            Route::Focused => match state.focused() {
                Some(label) => Delivery::To(label),
                None => Delivery::Broadcast,
            },
            Route::UnownedSurface {
                request_id,
                surface_id,
            } => Delivery::UnownedSurface {
                request_id: request_id.to_string(),
                surface_id: surface_id.to_string(),
            },
        }
    };

    for (label, queue) in flushed {
        for (held_event, held_data) in queue {
            let _ = app.emit_to(label.as_str(), held_event.as_str(), &held_data);
        }
    }

    let mut delivered: Option<&str> = None;
    match &delivery {
        Delivery::Nowhere => {}
        Delivery::Broadcast => {
            let _ = app.emit(event, &data);
        }
        Delivery::To(label) => {
            delivered = Some(label.as_str());
            let _ = app.emit_to(label.as_str(), event, &data);
        }
        Delivery::UnownedSurface {
            request_id,
            surface_id,
        } => {
            // Never a sibling window: acting on the wrong terminal is worse
            // than failing (docs/specs/dor-cli.md → "Standalone").
            if let Some(sidecar) = app.try_state::<SidecarState>() {
                let response = serde_json::json!({
                    "event": "dor:controlResponse",
                    "data": {
                        "requestId": request_id,
                        "ok": false,
                        "error": format!("No Dormouse window owns surface '{surface_id}'"),
                    },
                });
                send_to_sidecar(&sidecar, response.to_string());
            }
        }
    }

    // Bookkeeping strictly after the emit, so a replay lifts its own suppression
    // only once the new owner has actually been sent it. Only these four events
    // pay a second acquisition; a PTY chunk takes the lock once and is done.
    let id = || data.get("id").and_then(JsonValue::as_str);
    let request_id = || data.get("requestId").and_then(JsonValue::as_str);
    match event {
        "pty:exit" => {
            if let Some(id) = id() {
                state.forget_pty(id);
            }
        }
        "pty:replay" => {
            if let Some(id) = id() {
                let queue = {
                    let mut routing = guard(&state.routing);
                    let queue = routing.lift_suppression(id);
                    state
                        .suppressed
                        .store(routing.awaiting_replay.len(), Ordering::Relaxed);
                    queue
                };
                // Behind the replay, to the window that just received it: the
                // events describe bytes the replay carried.
                if let Some(label) = delivered {
                    for (held_event, held_data) in queue {
                        let _ = app.emit_to(label, held_event.as_str(), &held_data);
                    }
                }
            }
        }
        "dor:controlRequest" => {
            if let (Some(label), Some(request_id)) = (delivered, request_id()) {
                guard(&state.routing)
                    .dor_targets
                    .insert(request_id.to_string(), label.to_string());
            }
        }
        "dor:controlCancel" => {
            if let Some(request_id) = request_id() {
                guard(&state.routing).dor_targets.remove(request_id);
            }
        }
        // The collector settles on having heard from every window the ask
        // reached, and only Rust knows this one reached exactly its Surface's
        // owner (docs/specs/standalone.md -> "Burrow service").
        "burrow:ask" => {
            if let (Some(label), Some(sidecar)) =
                (delivered, app.try_state::<SidecarState>())
            {
                if let Some(burrow_request_id) =
                    data.get("burrowRequestId").and_then(JsonValue::as_str)
                {
                    send_to_sidecar(
                        &sidecar,
                        serde_json::json!({
                            "event": "burrow:askDelivered",
                            "data": { "burrowRequestId": burrow_request_id, "windows": [label] },
                        })
                        .to_string(),
                    );
                }
            }
        }
        _ => {}
    }

    // Logged outside the lock: a chatty log write must never sit in front of the
    // next PTY chunk's routing decision.
    for id in released {
        append_log(format!(
            "[window] suppression for {id} expired with no arrival claiming it; releasing"
        ));
    }
}

/// Tell the sidecar's Burrow which webviews will answer an ask
/// (docs/specs/standalone.md §Burrow service). Labels, not a count: the
/// collector settles on having heard from each named window, so it can tell a
/// window that closed mid-fan-out from one that answered twice.
fn send_window_labels(app: &AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };
    let labels = window_labels(app);
    send_to_sidecar(
        &state,
        serde_json::json!({ "event": "burrow:windows", "data": { "labels": labels } }).to_string(),
    );
}

// ── Quit interception ─────────────────────────────────────────────────────────
//
// Every quit trigger funnels through `request_quit`, which asks each window's
// orchestrator (standalone/src/quit.ts) to vote, then walks them one at a time.
// Protocol + watchdog phases: docs/specs/standalone.md §Quit flow.
#[derive(Default)]
struct QuitState {
    machine: Mutex<QuitMachine>,
    close: Mutex<CloseMachine>,
}

// Phase 1: no ack within this window ⇒ a webview listener is dead — exit.
const QUIT_ACK_TIMEOUT_MS: u64 = 2_000;
// Phase 3: per-phase budget once teardown is running. Each reported phase
// (teardown, install) refreshes it, so it bounds a single stalled phase, not the
// sum of all teardown work. Comfortably exceeds the webview's own teardown
// ceiling (docs/specs/standalone.md §Quit flow) — `QUIT_TEARDOWN_CEILING_MS` in
// `standalone/src/quit.ts`, pinned under this by
// `lib/src/lib/mirrored-constants.test.ts`.
const QUIT_PHASE_TIMEOUT_MS: u64 = 14_000;
const QUIT_POLL_STEP_MS: u64 = 500;
// A per-window close whose webview never acks: its listener is dead, so close it.
const CLOSE_ACK_TIMEOUT_MS: u64 = 2_000;

fn quit_approved(app: &AppHandle) -> bool {
    app.try_state::<QuitState>()
        .is_some_and(|state| guard(&state.machine).approved)
}

/// Whether the windows are already being torn down, in which case a `destroy`
/// must not re-enter the quit as a fresh close.
fn quit_walking(app: &AppHandle) -> bool {
    app.try_state::<QuitState>().is_some_and(|state| {
        matches!(
            guard(&state.machine).phase,
            quit_state::QuitPhase::Walking { .. }
        )
    })
}

fn window_labels(app: &AppHandle) -> Vec<String> {
    app.webview_windows().keys().cloned().collect()
}

/// Perform what a `QuitMachine` transition asked for.
fn apply_quit_actions(app: &AppHandle, actions: Vec<QuitAction>) {
    for action in actions {
        match action {
            QuitAction::RequestAll => {
                // The count is what tells each window whether to name itself in
                // its confirmation dialog.
                let _ = app.emit(
                    "dormouse://quit-requested",
                    serde_json::json!({ "windows": app.webview_windows().len() }),
                );
            }
            QuitAction::CancelAll => {
                let _ = app.emit("dormouse://quit-cancelled", ());
            }
            QuitAction::Teardown { label, last } => {
                let _ = app.emit_to(
                    label.as_str(),
                    "dormouse://quit-teardown",
                    serde_json::json!({ "last": last }),
                );
            }
            QuitAction::Destroy { label } => {
                // The snapshot stays on disk — that is what separates a quit
                // from a per-window close. Ownership and the sidecar's window
                // list are settled by the `Destroyed` arm.
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.destroy();
                }
            }
            QuitAction::Exit => {
                if let Some(state) = app.try_state::<QuitState>() {
                    guard(&state.machine).approved = true;
                }
                app.exit(0);
            }
        }
    }
}

fn request_quit(app: &AppHandle) {
    let Some(state) = app.try_state::<QuitState>() else {
        return;
    };
    let labels = window_labels(app);
    append_log(format!("[quit] requested across {labels:?}"));
    let (my_seq, actions) = guard(&state.machine).request(&labels);
    apply_quit_actions(app, actions);

    // Watchdog: a cloned handle polls the machine so a dead or wedged webview
    // can't make quit hang. A repeated trigger bumps seq, so this (now-stale)
    // watchdog returns and the fresh request_quit spawns a replacement.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(QUIT_ACK_TIMEOUT_MS));
        let give_up = |reason: &str| {
            append_log(format!("[quit] {reason}; exiting"));
            if let Some(state) = app.try_state::<QuitState>() {
                guard(&state.machine).approved = true;
            }
            app.exit(0);
        };
        let Some(acked) = read_quit(&app, my_seq, QuitMachine::all_acked) else {
            return;
        };
        if !acked {
            give_up("a window never acked");
            return;
        }
        // Phase 2: acked but no window has begun tearing down. Each may be
        // parked on its confirmation dialog waiting for a human, who must never
        // be force-quit out from under it — so hold with no deadline.
        loop {
            let Some(walking) = read_quit(&app, my_seq, |machine| {
                machine.walking_progress().is_some()
            }) else {
                return;
            };
            if walking {
                break;
            }
            std::thread::sleep(Duration::from_millis(QUIT_POLL_STEP_MS));
        }
        // Phase 3: one window is tearing down. Bound it, but a `quit_progress`
        // bump (a phase boundary) or the walk advancing to the next window
        // refreshes the deadline, so each phase gets its own budget.
        let mut last = read_quit(&app, my_seq, QuitMachine::walking_progress);
        let mut elapsed = 0u64;
        loop {
            std::thread::sleep(Duration::from_millis(QUIT_POLL_STEP_MS));
            let Some(now) = read_quit(&app, my_seq, QuitMachine::walking_progress) else {
                return;
            };
            if Some(&now) != last.as_ref() {
                last = Some(now);
                elapsed = 0;
                continue;
            }
            elapsed += QUIT_POLL_STEP_MS;
            if elapsed >= QUIT_PHASE_TIMEOUT_MS {
                give_up("teardown phase stalled");
                return;
            }
        }
    });
}

/// Read the quit machine on behalf of a watchdog spawned for `seq`. `None`
/// means the watchdog has been superseded (a repeat trigger or a cancel) or the
/// app is already exiting, and it must stand down without acting.
fn read_quit<T>(app: &AppHandle, seq: u64, read: impl FnOnce(&QuitMachine) -> T) -> Option<T> {
    let state = app.try_state::<QuitState>()?;
    let machine = guard(&state.machine);
    if machine.stale(seq) {
        return None;
    }
    Some(read(&machine))
}

/// Ask one window to close itself (docs/specs/standalone.md §Per-window close).
/// The app keeps running; only the last window's close is a quit.
fn request_window_close(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<QuitState>() else {
        return;
    };
    append_log(format!("[window] close requested for {label}"));
    let my_seq = guard(&state.close).request(label);
    let _ = app.emit_to(label, "dormouse://window-close-requested", ());

    let app = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(CLOSE_ACK_TIMEOUT_MS));
        let Some(state) = app.try_state::<QuitState>() else {
            return;
        };
        let close = guard(&state.close);
        if close.stale(&label, my_seq) || close.acked(&label) {
            return;
        }
        drop(close);
        append_log(format!(
            "[window] {label} never acked its close; closing it anyway"
        ));
        finish_window_close(&app, &label);
    });
}

/// The last step of a per-window close: take the window's snapshot off disk and
/// destroy it. Called from `close_window`, and from the ack watchdog when the
/// webview never answered.
///
/// The rest — forgetting its PTYs, telling the quit machine, telling the
/// sidecar's Burrow — happens in the `Destroyed` arm, which is the first moment
/// Tauri has actually taken the label out of `webview_windows()`.
fn finish_window_close(app: &AppHandle, label: &str) {
    append_log(format!("[window] closing {label} and removing its snapshot"));
    if let Some(state) = app.try_state::<QuitState>() {
        guard(&state.close).clear(label);
    }
    if let Some(state) = app.try_state::<WindowState>() {
        // Before the removal, not after: a save already in flight from this
        // webview would otherwise put the snapshot back. Reached from the
        // watchdog too, where the webview never called `remove_window_session`.
        state.begin_closing(label);
    }
    if let Ok(dir) = sessions_dir(app) {
        if let Err(err) = close_window_snapshot(&dir, label) {
            append_log(format!("[session] {err}"));
        }
    }
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.destroy();
    }
}

/// SIGTERM the PTYs a window left behind.
///
/// Reached whenever a window goes away still owning shells — the close
/// ack-timeout path ran no teardown at all, and a teardown that overran its
/// budget can leave stragglers. Unowned output routes nowhere
/// (`routing::owner`), so without this they would run on invisibly.
fn reap_orphaned_ptys(app: &AppHandle, label: &str, ids: Vec<String>) {
    if ids.is_empty() {
        return;
    }
    let Some(sidecar) = app.try_state::<SidecarState>() else {
        return;
    };
    append_log(format!(
        "[window] {label} left {} PTY(s) with no owner; killing them",
        ids.len()
    ));
    send_to_sidecar(
        &sidecar,
        serde_json::json!({
            "event": "pty:gracefulKill",
            "data": { "ids": ids, "timeout": 2000 },
        })
        .to_string(),
    );
}

const LOG_FILE_ENV: &str = "DORMOUSE_LOG_FILE";

fn log_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn default_log_path() -> PathBuf {
    if let Some(path) = env::var_os(LOG_FILE_ENV) {
        return PathBuf::from(path);
    }

    #[cfg(target_os = "windows")]
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local_app_data)
            .join("Dormouse Terminal")
            .join("dormouse.log");
    }

    env::temp_dir().join("dormouse.log")
}

fn log_path() -> &'static Path {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(default_log_path)
}

// `append_log` runs per stdout/stderr line from the sidecar; reopening
// the file each call costs a syscall + dir-walk per chatty subprocess
// log line. Cache an append handle for the life of the process.
fn log_file() -> Option<&'static Mutex<File>> {
    static FILE: OnceLock<Option<Mutex<File>>> = OnceLock::new();
    FILE.get_or_init(|| {
        let path = log_path();
        if let Some(parent) = path.parent() {
            let _ = create_dir_all(parent);
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()
            .map(Mutex::new)
    })
    .as_ref()
}

fn init_log() {
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = create_dir_all(parent);
    }

    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
    {
        let _ = writeln!(
            file,
            "[{}] Dormouse log started at {}",
            log_timestamp(),
            path.display()
        );
    }
}

fn append_log(message: impl AsRef<str>) {
    let Some(file) = log_file() else { return };
    if let Ok(mut file) = file.lock() {
        let _ = writeln!(file, "[{}] {}", log_timestamp(), message.as_ref());
    }
}

#[cfg(target_os = "macos")]
fn set_macos_dock_icon() {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let mtm = unsafe { MainThreadMarker::new_unchecked() };
    let app = NSApplication::sharedApplication(mtm);
    // The largest size exploded from icon.icns (1024×1024) — it carries the
    // built-in transparent padding the bundle's edge-to-edge 128x128@2x.png lacks.
    let data = NSData::with_bytes(include_bytes!("../icons/dock-icon.png"));
    let Some(app_icon) = NSImage::initWithData(NSImage::alloc(), &data) else {
        append_log("[app] failed to create macOS dock icon image");
        return;
    };

    unsafe {
        app.setApplicationIconImage(Some(&app_icon));
    }
}

fn read_log_tail(max_bytes: usize) -> Result<String, String> {
    let path = log_path();
    File::open(path)
        .and_then(|mut file| log_tail::read_utf8_tail(&mut file, max_bytes))
        .map_err(|e| format!("read {}: {e}", path.display()))
}

#[derive(Serialize, Deserialize, Clone)]
struct PtySpawnOptions {
    helper: Option<JsonValue>,
    cols: Option<u16>,
    rows: Option<u16>,
    cwd: Option<String>,
    shell: Option<String>,
    args: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DorControlResponse {
    request_id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DorCliPaths {
    bin_dir: PathBuf,
    entrypoint: PathBuf,
}

fn send_to_sidecar(state: &SidecarState, line: String) {
    let _ = state.tx.send(line);
}

fn request_from_sidecar(
    state: &SidecarState,
    event: &str,
    data: JsonValue,
) -> Result<JsonValue, String> {
    request_from_sidecar_timeout(state, event, data, Duration::from_secs(1))
}

/// INVARIANT: every `#[tauri::command]` that reaches these two blocking helpers
/// must be declared `#[tauri::command(async)]` (or be an `async fn`). Tauri runs
/// a plain sync command on the **main thread**, where the `recv_timeout` below
/// stops the webview from painting for the whole round trip — up to
/// `AGENT_BROWSER_TIMEOUT` (30s) for a hung agent-browser, and a visible ~3s
/// freeze on a cold `agent-browser open`, which is long enough to look like a
/// pane that never appeared. `(async)` moves the same blocking body onto a
/// runtime worker, so the UI keeps rendering while the sidecar works.

fn request_from_sidecar_timeout(
    state: &SidecarState,
    event: &str,
    data: JsonValue,
    timeout: Duration,
) -> Result<JsonValue, String> {
    let request_id = format!(
        "req-{}",
        state.next_request_id.fetch_add(1, Ordering::Relaxed)
    );
    let (tx, rx) = mpsc::channel();
    state
        .pending_requests
        .lock()
        .map_err(|_| "failed to lock pending request map".to_string())?
        .insert(request_id.clone(), tx);

    let mut payload = match data {
        JsonValue::Object(map) => map,
        _ => JsonMap::new(),
    };
    payload.insert("requestId".into(), JsonValue::String(request_id.clone()));

    let msg = serde_json::json!({
        "event": event,
        "data": JsonValue::Object(payload)
    });
    send_to_sidecar(state, msg.to_string());

    match rx.recv_timeout(timeout) {
        Ok(response) => Ok(response),
        Err(err) => {
            if let Ok(mut pending) = state.pending_requests.lock() {
                pending.remove(&request_id);
            }
            // Disconnected means the reaper cleared pending_requests because
            // the sidecar exited — surface that distinctly from a real timeout.
            match err {
                mpsc::RecvTimeoutError::Timeout => {
                    Err(format!("timed out waiting for {event}"))
                }
                mpsc::RecvTimeoutError::Disconnected => {
                    Err(format!("sidecar exited before responding to {event}"))
                }
            }
        }
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// The only place PTY ownership is minted: whichever window asked for the PTY
/// owns it until a transfer moves it (docs/specs/standalone.md §Windows).
#[tauri::command]
fn pty_spawn(
    window: tauri::Window,
    state: tauri::State<'_, SidecarState>,
    windows: tauri::State<'_, WindowState>,
    id: String,
    options: Option<PtySpawnOptions>,
) {
    windows.mint(&id, window.label());
    let msg = serde_json::json!({
        "event": "pty:spawn",
        "data": { "id": id, "options": options }
    });
    send_to_sidecar(&state, msg.to_string());
}

#[tauri::command]
fn pty_write(state: tauri::State<'_, SidecarState>, id: String, data: String) {
    let msg = serde_json::json!({
        "event": "pty:input",
        "data": { "id": id, "data": data }
    });
    send_to_sidecar(&state, msg.to_string());
}

#[tauri::command]
fn pty_resize(state: tauri::State<'_, SidecarState>, id: String, cols: u16, rows: u16) {
    let msg = serde_json::json!({
        "event": "pty:resize",
        "data": { "id": id, "cols": cols, "rows": rows }
    });
    send_to_sidecar(&state, msg.to_string());
}

// The webview's resolved terminal colors, so the sidecar's parser can answer
// OSC 10/11/12 (docs/specs/terminal-escapes.md). Opaque here: the shape belongs
// to the parser at the other end, and Rust has no reason to know it.
#[tauri::command]
fn pty_theme_colors(state: tauri::State<'_, SidecarState>, colors: JsonValue) {
    let msg = serde_json::json!({
        "event": "pty:themeColors",
        "data": colors
    });
    send_to_sidecar(&state, msg.to_string());
}

#[tauri::command]
fn pty_kill(state: tauri::State<'_, SidecarState>, windows: tauri::State<'_, WindowState>, id: String) {
    windows.forget_pty(&id);
    let msg = serde_json::json!({
        "event": "pty:kill",
        "data": { "id": id }
    });
    send_to_sidecar(&state, msg.to_string());
}

/// List and replay only what this window owns. The answer names the window, so
/// the `pty:list` and every `pty:replay` behind it route back to the asker
/// alone (docs/specs/standalone.md §Windows).
///
/// **Excludes every id an in-flight arrival claims.** Ownership moves the
/// instant the source invokes, so a window booting with a Workspace already
/// queued for it would otherwise list those shells here and place them as
/// top-level panes — beside the Workspace the arrival is about to mount them
/// into. They come through `adopt_ready`, and only there.
///
/// `request_id` is the asking collector's own token, echoed on the answer:
/// one window can have two collections outstanding (a boot and an arrival), and
/// neither may finish on the other's list (docs/specs/transport.md §Reconnection).
#[tauri::command]
fn pty_request_init(
    window: tauri::Window,
    state: tauri::State<'_, SidecarState>,
    windows: tauri::State<'_, WindowState>,
    request_id: Option<String>,
) {
    let ids = routing::boot_list_ids(
        windows.owned_by(window.label()),
        &guard(&windows.arrivals),
    );
    let msg = serde_json::json!({
        "event": "pty:requestInit",
        "data": {
            "forWindow": window.label(),
            "ids": ids,
            "requestId": request_id,
        },
    });
    send_to_sidecar(&state, msg.to_string());
}

// One passthrough for the whole burrow bridge: the webview and the sidecar
// service share a contract (lib/src/host/remote/service-protocol.ts) that Rust
// has no reason to know, so the payload rides through opaquely. Replies come
// back on the sidecar's own stdout events, not from this invoke.
#[tauri::command]
fn burrow_command(
    window: tauri::Window,
    state: tauri::State<'_, SidecarState>,
    mut payload: JsonValue,
) {
    // The one field Rust adds: which webview this came from. An ask fans out to
    // every window and settles on having heard from each, and a webview cannot
    // name itself to the Burrow (§Burrow service).
    if let Some(command) = payload.as_object_mut() {
        command.insert(
            "window".to_string(),
            JsonValue::String(window.label().to_string()),
        );
    }
    let msg = serde_json::json!({
        "event": "burrow:command",
        "data": payload,
    });
    send_to_sidecar(&state, msg.to_string());
}

// The two app-global alert stores live in the sidecar so N windows share one
// answer (docs/specs/alert.md -> "Alarm settings"). One opaque passthrough, like
// `burrow_command`: the payload names its own op, and the shape belongs to
// `lib/src/host/alert-store-host.ts` at the other end. The canonical snapshot
// comes back as a broadcast `alert:settings` / `alert:watchedCommands`.
#[tauri::command]
fn alert_command(state: tauri::State<'_, SidecarState>, payload: JsonValue) {
    let msg = serde_json::json!({ "event": "alert:command", "data": payload });
    send_to_sidecar(&state, msg.to_string());
}

#[tauri::command]
fn dor_control_response(
    state: tauri::State<'_, SidecarState>,
    windows: tauri::State<'_, WindowState>,
    response: DorControlResponse,
) {
    // The request is answered, so nothing is left for a cancel to reach
    // (§Routing).
    guard(&windows.routing)
        .dor_targets
        .remove(&response.request_id);
    let msg = serde_json::json!({
        "event": "dor:controlResponse",
        "data": response,
    });
    send_to_sidecar(&state, msg.to_string());
}

#[tauri::command(async)]
fn pty_context(state: tauri::State<'_, SidecarState>, request: JsonValue) -> Result<JsonValue, String> {
    request_from_sidecar_timeout(&state, "pty:context", request, Duration::from_secs(10))
}

#[tauri::command(async)]
fn pty_get_cwd(
    state: tauri::State<'_, SidecarState>,
    id: String,
) -> Result<Option<String>, String> {
    let response = request_from_sidecar(&state, "pty:getCwd", serde_json::json!({ "id": id }))?;
    Ok(response
        .get("cwd")
        .and_then(|cwd| cwd.as_str().map(String::from)))
}

/// Every id's cwd in one sidecar round trip. A save probes each terminal pane,
/// and the sidecar resolves them with a synchronous process scan on its only
/// event loop, so N panes must cost one scan rather than N
/// (docs/specs/transport.md -> "Persisted session").
#[tauri::command(async)]
fn pty_get_cwds(
    state: tauri::State<'_, SidecarState>,
    ids: Vec<String>,
) -> Result<JsonValue, String> {
    let response = request_from_sidecar_timeout(
        &state,
        "pty:getCwds",
        serde_json::json!({ "ids": ids }),
        Duration::from_secs(2),
    )?;
    Ok(response
        .get("cwds")
        .cloned()
        .unwrap_or_else(|| JsonValue::Object(JsonMap::new())))
}

// Mirrors `OPEN_PORT_TIMEOUT_MS` in `lib/src/lib/platform/types.ts` — pinned by
// `lib/src/lib/mirrored-constants.test.ts`.
const OPEN_PORT_TIMEOUT_MS: u64 = 3000;

// Mirrors `OPEN_PORT_TIMEOUT_PER_ID_MS` in `lib/src/lib/platform/types.ts` —
// pinned by `lib/src/lib/mirrored-constants.test.ts`.
const OPEN_PORT_TIMEOUT_PER_ID_MS: u64 = 100;

// Mirrors platform/types.ts; pinned by mirrored-constants.test.ts.
const OPEN_PORT_ROUND_TRIP_MARGIN_MS: u64 = 1000;

/// Budget for either port command over `count` ids, including 1 s for IPC. The sidecar runs two
/// scans serially: the process table under `OPEN_PORT_TIMEOUT_MS`, then one
/// socket scan under that cap plus `OPEN_PORT_TIMEOUT_PER_ID_MS` per id
/// (`getOpenPortsForPids` in `standalone/sidecar/pty-core.js`) — so the whole
/// Window is not held to one terminal's budget, and the reply outlasts both.
fn open_ports_many_timeout(count: usize) -> Duration {
    Duration::from_millis(2 * OPEN_PORT_TIMEOUT_MS + OPEN_PORT_TIMEOUT_PER_ID_MS * count as u64 + OPEN_PORT_ROUND_TRIP_MARGIN_MS)
}

#[tauri::command(async)]
fn pty_get_open_ports(
    state: tauri::State<'_, SidecarState>,
    id: String,
) -> Result<JsonValue, String> {
    let response = request_from_sidecar_timeout(
        &state,
        "pty:getOpenPorts",
        serde_json::json!({ "id": id }),
        open_ports_many_timeout(1),
    )?;
    Ok(response
        .get("ports")
        .cloned()
        .unwrap_or_else(|| JsonValue::Array(Vec::new())))
}

/// Every id's listening ports in one sidecar round trip, for a listing that spans
/// terminals (`dor list --ports`, and `--all` across every Workspace). The
/// sidecar resolves them with synchronous process scans on its only event loop,
/// so N terminals must cost one scan rather than N.
#[tauri::command(async)]
fn pty_get_open_ports_many(
    state: tauri::State<'_, SidecarState>,
    ids: Vec<String>,
) -> Result<JsonValue, String> {
    let timeout = open_ports_many_timeout(ids.len());
    let response = request_from_sidecar_timeout(
        &state,
        "pty:getOpenPortsMany",
        serde_json::json!({ "ids": ids }),
        timeout,
    )?;
    Ok(response
        .get("ports")
        .cloned()
        .unwrap_or_else(|| JsonValue::Object(JsonMap::new())))
}

// Wait for PTY exits and their final output before shutdown. Async: waits up to
// `timeout` plus a margin for the round trip beyond the sidecar's own kill
// timer, and must not block the main thread for that long. The margin here and
// in `capture_agent_recovery` is `SIDECAR_ROUND_TRIP_MARGIN_MS` in
// `standalone/src/quit.ts` — pinned by `lib/src/lib/mirrored-constants.test.ts`.
//
// **The target set is the caller's own PTYs**, and only those: a window tearing
// down must never kill a sibling's terminals.
#[tauri::command]
async fn pty_graceful_kill(
    window: tauri::Window,
    state: tauri::State<'_, SidecarState>,
    windows: tauri::State<'_, WindowState>,
    timeout: u64,
) -> Result<(), String> {
    // Minus every id an arrival claims: ownership moves at the source's invoke,
    // so those shells are still shown by the window that sent them
    // (`pty_request_init` filters the same set). Bound here so the arrivals
    // guard is released before the blocking round trip below.
    let ids = routing::boot_list_ids(
        windows.owned_by(window.label()),
        &guard(&windows.arrivals),
    );
    request_from_sidecar_timeout(
        &state,
        "pty:gracefulKill",
        serde_json::json!({ "ids": ids, "timeout": timeout }),
        Duration::from_millis(timeout + 1500),
    )?;
    Ok(())
}

// --- Agent recovery (docs/specs/standalone.md -> "Agent recovery") ------------
//
// Both commands are thin: the sidecar owns the capture machine and the record,
// because the replay buffers the detection reads live there and its lifetime is
// exactly one activation. Both are `(async)` because they reach the blocking
// sidecar helper (see the INVARIANT above `request_from_sidecar_timeout`;
// `sidecar_commands_are_async` enforces it).

/// Interrupt the live PTYs and let the sidecar detect and record each agent's
/// resume invocation. First step of the quit teardown: the hint exists only
/// between the interrupt and the kill.
#[tauri::command(async)]
fn capture_agent_recovery(
    window: tauri::Window,
    state: tauri::State<'_, SidecarState>,
    windows: tauri::State<'_, WindowState>,
    timeout: u64,
) -> Result<(), String> {
    // This window's own PTYs, and only those: a quit walks the windows one at a
    // time, and interrupting a sibling's agents would destroy the very hint the
    // sibling is about to capture. An arriving Workspace's shells are the
    // source's until it adopts them, and Ctrl-C there would hit agents the
    // source is still showing (`pty_graceful_kill` filters the same set).
    let ids = routing::boot_list_ids(
        windows.owned_by(window.label()),
        &guard(&windows.arrivals),
    );
    request_from_sidecar_timeout(
        &state,
        "pty:captureRecovery",
        serde_json::json!({ "ids": ids, "timeout": timeout }),
        // Margin for the round trip beyond the sidecar's own ceiling; the same
        // one `pty_graceful_kill` adds (see its comment for the pin).
        Duration::from_millis(timeout + 1500),
    )?;
    Ok(())
}

/// Claim the resume invocations belonging to `pane_ids`. Destructive on the
/// sidecar's first call, so nothing can replay them.
#[tauri::command(async)]
fn take_recovery_commands(
    state: tauri::State<'_, SidecarState>,
    pane_ids: Vec<String>,
) -> Result<JsonValue, String> {
    let response = request_from_sidecar_timeout(
        &state,
        "recovery:take",
        serde_json::json!({ "paneIds": pane_ids }),
        Duration::from_secs(5),
    )?;
    Ok(response
        .get("commands")
        .cloned()
        .unwrap_or_else(|| JsonValue::Object(JsonMap::new())))
}

// Stands up the loopback iframe proxy in the sidecar and returns the
// IframeProxyResult JSON the webview's IframePanel expects. The proxy server is
// the shared lib/src/host/iframe-proxy.ts; this only bridges the request.
#[tauri::command(async)]
fn iframe_create_proxy_url(
    state: tauri::State<'_, SidecarState>,
    target: String,
    // The webview's own ancestor chain, which is what decides who may frame the
    // proxy. Forwarded verbatim and validated in the proxy itself
    // (`normalizeEmbedderOrigins`), so this stays a bridge and nothing more.
    embedder_origins: Option<Vec<String>>,
) -> Result<JsonValue, String> {
    let response = request_from_sidecar_timeout(
        &state,
        "iframe:createProxyUrl",
        serde_json::json!({
            "target": target,
            "embedderOrigins": embedder_origins.unwrap_or_default(),
        }),
        Duration::from_secs(5),
    )?;
    Ok(response.get("result").cloned().unwrap_or(JsonValue::Null))
}

// ── agent-browser host (docs/specs/dor-browser.md → "Agent-Browser Host Capabilities").
// Thin forwarders to the Node sidecar, which runs the shared
// lib/src/host/agent-browser-host.ts — the very same module the VS Code
// extension host runs. Mirrors iframe_create_proxy_url; the logic lives in lib,
// not here, so the two hosts can't drift. ──────────────────────────────────────

// agent-browser launches Chrome (slow on first run), and pop-out is a
// close + relaunch, so allow a generous window before a forward times out.
const AGENT_BROWSER_TIMEOUT: Duration = Duration::from_secs(30);

fn agent_browser_forward(
    state: &SidecarState,
    event: &str,
    data: JsonValue,
) -> Result<JsonValue, String> {
    let response = request_from_sidecar_timeout(state, event, data, AGENT_BROWSER_TIMEOUT)?;
    Ok(response.get("result").cloned().unwrap_or(JsonValue::Null))
}

#[tauri::command(async)]
fn agent_browser_command(
    state: tauri::State<'_, SidecarState>,
    session: String,
    args: Vec<String>,
    binary_path: Option<String>,
) -> Result<JsonValue, String> {
    agent_browser_forward(
        &state,
        "agentBrowser:command",
        serde_json::json!({ "session": session, "args": args, "binaryPath": binary_path }),
    )
}

#[tauri::command(async)]
fn agent_browser_edit(
    state: tauri::State<'_, SidecarState>,
    session: String,
    op: String,
    binary_path: Option<String>,
) -> Result<JsonValue, String> {
    agent_browser_forward(
        &state,
        "agentBrowser:edit",
        serde_json::json!({ "session": session, "op": op, "binaryPath": binary_path }),
    )
}

#[tauri::command(async)]
fn agent_browser_stream_status(
    state: tauri::State<'_, SidecarState>,
    session: String,
    binary_path: Option<String>,
) -> Result<JsonValue, String> {
    agent_browser_forward(
        &state,
        "agentBrowser:streamStatus",
        serde_json::json!({ "session": session, "binaryPath": binary_path }),
    )
}

#[tauri::command(async)]
fn agent_browser_open(
    state: tauri::State<'_, SidecarState>,
    url: String,
    headed: Option<bool>,
    binary_path: Option<String>,
) -> Result<JsonValue, String> {
    agent_browser_forward(
        &state,
        "agentBrowser:open",
        serde_json::json!({ "url": url, "headed": headed, "binaryPath": binary_path }),
    )
}

// `rect` is accepted by the adapter but unused — no window positioning today.
#[tauri::command(async)]
fn agent_browser_pop_out(
    state: tauri::State<'_, SidecarState>,
    session: String,
    url: Option<String>,
    binary_path: Option<String>,
) -> Result<JsonValue, String> {
    agent_browser_forward(
        &state,
        "agentBrowser:popOut",
        serde_json::json!({ "session": session, "url": url, "binaryPath": binary_path }),
    )
}

#[tauri::command(async)]
fn agent_browser_pop_in(
    state: tauri::State<'_, SidecarState>,
    session: String,
    url: Option<String>,
    binary_path: Option<String>,
) -> Result<JsonValue, String> {
    agent_browser_forward(
        &state,
        "agentBrowser:popIn",
        serde_json::json!({ "session": session, "url": url, "binaryPath": binary_path }),
    )
}

// The sidecar hands back the screenshot's temp-file PATH (bytes no longer ride
// the JSON-lines stdio shared with PTY traffic). Read the file here and return a
// raw tauri::ipc::Response so the webview gets an ArrayBuffer (the path the panel
// decodes with createImageBitmap). A base64 `bytesBase64` field is kept as a
// fallback for a stale sidecar bundle (dev-time version skew), but the path
// branch is preferred.
#[tauri::command(async)]
fn agent_browser_screenshot(
    state: tauri::State<'_, SidecarState>,
    session: String,
    format: Option<String>,
    quality: Option<u32>,
    binary_path: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let result = agent_browser_forward(
        &state,
        "agentBrowser:screenshot",
        serde_json::json!({ "session": session, "format": format, "quality": quality, "binaryPath": binary_path }),
    )?;
    if result.get("ok").and_then(JsonValue::as_bool) != Some(true) {
        return Err(result
            .get("error")
            .and_then(JsonValue::as_str)
            .unwrap_or("screenshot failed")
            .to_string());
    }
    if let Some(path) = result.get("path").and_then(JsonValue::as_str) {
        let bytes = std::fs::read(path)
            .map_err(|err| format!("could not read screenshot file '{path}': {err}"))?;
        return Ok(tauri::ipc::Response::new(bytes));
    }
    // Fallback: an older sidecar bundle still base64s the bytes over stdio.
    let b64 = result
        .get("bytesBase64")
        .and_then(JsonValue::as_str)
        .ok_or("screenshot returned no path or bytes")?;
    let bytes = BASE64
        .decode(b64)
        .map_err(|err| format!("bad screenshot base64: {err}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

// Clipboard reads run natively on Windows (see clipboard_win) to avoid the
// console-window flicker of shelling out to PowerShell; other platforms keep the
// sidecar path (pbpaste/xclip never pop a console window).
#[tauri::command(async)]
fn read_clipboard_file_paths(
    state: tauri::State<'_, SidecarState>,
) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        let _ = &state;
        return Ok(clipboard_win::read_file_paths());
    }
    #[cfg(not(windows))]
    {
        let response =
            request_from_sidecar_timeout(&state, "clipboard:readFiles", serde_json::json!({}), Duration::from_secs(5))?;
        Ok(response
            .get("paths")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default())
    }
}

#[tauri::command(async)]
fn read_clipboard_image_as_file_path(
    state: tauri::State<'_, SidecarState>,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let _ = &state;
        return Ok(clipboard_win::read_image_as_file_path());
    }
    #[cfg(not(windows))]
    {
        let response =
            request_from_sidecar_timeout(&state, "clipboard:readImage", serde_json::json!({}), Duration::from_secs(10))?;
        Ok(response
            .get("path")
            .and_then(|path| path.as_str().map(String::from)))
    }
}

#[tauri::command(async)]
fn read_clipboard_text(
    state: tauri::State<'_, SidecarState>,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        let _ = &state;
        return Ok(clipboard_win::read_text().unwrap_or_default());
    }
    #[cfg(not(windows))]
    {
        let response =
            request_from_sidecar_timeout(&state, "clipboard:readText", serde_json::json!({}), Duration::from_secs(5))?;
        Ok(response
            .get("text")
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default())
    }
}

#[tauri::command(async)]
fn read_update_log() -> Result<String, String> {
    read_log_tail(10_000)
}

// --- Per-window session persistence (docs/specs/standalone.md §Persistence) ---
//
// The webview's persisted-session blob (a `PersistedWindow`) is stored as one
// atomic file per Tauri window, keyed by the window label. This replaces webview
// `localStorage`, whose WKWebView SQLite WAL grew unbounded because WebKit pins
// its own WAL with a long-lived reader and never truncates during a days-long
// session. A plain file we overwrite atomically has no WAL and cannot grow.
//
// Window identity is implicit: each command keys by the invoking window's label,
// so the frontend stays window-agnostic and a second window (`win-2`, …) persists
// to its own file without ever rewriting the first window's blob.

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))
}

/// Everything this build's own state lives under.
///
/// `app_data_dir()` is keyed by the Tauri identifier, so a `pnpm dev:standalone`
/// run and the installed app resolve to the same directory: without this split a
/// dev launch would restore the installed app's Workspaces and the two would
/// clobber one another's snapshot. The notepad archive and the Burrow state
/// directory stay shared — they are machine-local stores, not this build's copy
/// of the user's window.
fn state_root_from(app_data: PathBuf) -> PathBuf {
    if cfg!(debug_assertions) {
        app_data.join("dev")
    } else {
        app_data
    }
}

fn state_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(state_root_from(app_data_dir(app)?))
}

fn sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(state_root(app)?.join("sessions"))
}

// Window labels are app-controlled (e.g. "main"), but sanitize defensively so a
// label can never escape the sessions directory or embed a path separator.
fn session_file_name(label: &str) -> String {
    let safe: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{safe}.json")
}

fn read_session_from(dir: &Path, label: &str) -> Result<Option<String>, String> {
    let path = dir.join(session_file_name(label));
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read session {label}: {e}")),
    }
}

/// Tighten a path to owner-only. Session snapshots carry layout and metadata;
/// legacy snapshots can contain transcripts. The session writer fails before
/// writing bytes if either the directory or temp-file restriction fails.
/// Other callers choose whether to propagate or log the error.
///
/// The `mode` is a unix mode and is ignored on Windows, which has no such
/// concept — there the equivalent is a DACL protected from inheritance carrying
/// exactly one entry, for the user this process runs as. That is the same shape
/// `deploy/local/install-windows.ps1` applies to the server's `state\`, and it
/// is needed for the same reason: a unix mode is a silent no-op on Windows, so
/// without this the directory simply keeps whatever `%LOCALAPPDATA%` hands
/// down, which is never owner-only. That inheritance always carries SYSTEM and
/// Administrators (as a `0700` does not exclude root either), and in practice
/// often stale entries from earlier installs — this machine's carried two
/// unresolvable `S-1-5-21-…` principals from other Windows domains with
/// read/write. Those particular entries are inert, since no account here can
/// present a foreign install's SID, so what this closes is the parity gap with
/// the unix mode rather than a demonstrated live hole.
#[cfg(unix)]
fn restrict_to_owner(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| format!("set_permissions: {e}"))
}

/// Replace `path`'s DACL with a single full-control entry for the current
/// user, and mark it protected so nothing is inherited from the parent.
///
/// Reports failures to the caller; snapshot writes require success before bytes
/// are written, while Burrow state-directory setup logs failures.
#[cfg(windows)]
fn restrict_to_owner(path: &Path, _mode: u32) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::{
        SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, SET_ACCESS, SE_FILE_OBJECT,
        TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, ACE_FLAGS, ACL, CONTAINER_INHERIT_ACE,
        DACL_SECURITY_INFORMATION, NO_INHERITANCE, OBJECT_INHERIT_ACE,
        PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // FILE_ALL_ACCESS, not GENERIC_ALL. The generic rights map to different
    // concrete masks for containers and for objects, so SetEntriesInAclW splits
    // a single inheritable GENERIC_ALL entry into an effective ACE plus an
    // inherit-only one -- two entries where the intent was one. A concrete mask
    // needs no such split, which is what keeps the DACL to exactly one ACE.
    const FILE_ALL_ACCESS: u32 = 0x001F_01FF;

    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|e| format!("OpenProcessToken: {e}"))?;
        // Size query first: TOKEN_USER is variable-length because the SID is.
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            let _ = CloseHandle(token);
            return Err("GetTokenInformation reported a zero-length TOKEN_USER".into());
        }
        let mut buf = vec![0u8; needed as usize];
        let got = GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr().cast()),
            needed,
            &mut needed,
        );
        let _ = CloseHandle(token);
        got.map_err(|e| format!("GetTokenInformation: {e}"))?;

        // The SID points into `buf`, so `buf` must outlive every use below.
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let sid = user.User.Sid;

        // A directory carries the entry down to what the Node sidecar and the
        // rest of the app write inside it; a file inherits nothing.
        let inheritance = if path.is_dir() {
            ACE_FLAGS(CONTAINER_INHERIT_ACE.0 | OBJECT_INHERIT_ACE.0)
        } else {
            NO_INHERITANCE
        };

        let access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_ALL_ACCESS,
            grfAccessMode: SET_ACCESS,
            grfInheritance: inheritance,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: Default::default(),
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                // With TRUSTEE_IS_SID this field carries the SID pointer, not a
                // name. That is the documented Win32 convention, not a cast bug.
                ptstrName: PWSTR(sid.0 as *mut u16),
            },
        };

        let mut acl: *mut ACL = std::ptr::null_mut();
        let rc = SetEntriesInAclW(Some(&mut [access]), None, &mut acl);
        if rc != ERROR_SUCCESS {
            return Err(format!("SetEntriesInAclW: {rc:?}"));
        }

        let mut wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // PROTECTED_DACL_SECURITY_INFORMATION is the half that matters: without
        // it the inherited entries survive alongside ours and nothing is
        // actually revoked.
        let rc = SetNamedSecurityInfoW(
            PWSTR(wide.as_mut_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(acl),
            None,
        );
        // Freed before the early return: the ACL is LocalAlloc'd by
        // SetEntriesInAclW and belongs to us whether or not the apply worked.
        let _ = LocalFree(Some(HLOCAL(acl.cast())));
        if rc != ERROR_SUCCESS {
            return Err(format!("SetNamedSecurityInfoW: {rc:?}"));
        }
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
fn restrict_to_owner(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

/// The sibling this file is written through before being renamed into place.
/// Also what a crash before that rename leaves behind, which is why the clearing
/// paths look for it by the same name.
fn temp_write_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    path.with_file_name(name)
}

/// The directory `path` is written into, created and tightened to owner-only
/// by `restrict` (`restrict_to_owner` outside tests).
fn ensure_parent_with(
    path: &Path,
    restrict: impl Fn(&Path, u32) -> Result<(), String>,
) -> Result<&Path, String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("no parent directory for {}", path.display()))?;
    create_dir_all(dir).map_err(|e| format!("create dir {}: {e}", dir.display()))?;
    restrict(dir, 0o700)?;
    Ok(dir)
}

/// Write `contents` to `path` atomically and owner-only.
///
/// The one implementation behind both machine-local stores this app owns — the
/// per-window session snapshot and the notepad archive — because both carry user
/// text and both must survive a crash mid-write
/// (docs/specs/security-local.md -> "Persisted state"). Owner-only before any
/// bytes are written, and atomic-replace, both live here
/// (docs/specs/standalone.md -> "Persistence").
fn write_file_atomically(path: &Path, contents: &str) -> Result<(), String> {
    write_file_with_permissions(path, contents, restrict_to_owner)
}

/// `write_file_atomically` with the permission step injected, so a test can
/// fail either tightening and check that no bytes were written.
fn write_file_with_permissions(
    path: &Path,
    contents: &str,
    restrict: impl Fn(&Path, u32) -> Result<(), String>,
) -> Result<(), String> {
    let dir = ensure_parent_with(path, &restrict)?;
    let tmp = temp_write_path(path);
    // Atomic replace: write a sibling temp file, fsync it, then rename over the
    // target so a crash mid-write can never truncate the previous good copy.
    // Every failure below takes the temp file with it, so only a crash — never a
    // returned error — can leave one behind for the boot sweep to find.
    let written = (|| -> Result<(), String> {
        let mut f = File::create(&tmp).map_err(|e| format!("open temp: {e}"))?;
        // Before any bytes land: the rename below preserves the temp file's
        // mode, so tightening here is what makes the final snapshot 0600.
        restrict(&tmp, 0o600)?;
        f.write_all(contents.as_bytes())
            .map_err(|e| format!("write temp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync temp: {e}"))
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename {}: {e}", path.display()));
    }
    // The temp file's own fsync doesn't make the rename durable — on unix the
    // directory entry that now points at the new inode must be fsynced too, or a
    // crash right after quit could leave the rename unrecorded. Best-effort: a
    // failure here doesn't invalidate the (already-written) data. Windows has no
    // equivalent dir-fsync concept, so this is unix-only.
    #[cfg(unix)]
    {
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

fn write_session_to(dir: &Path, label: &str, state: &str) -> Result<(), String> {
    write_file_atomically(&dir.join(session_file_name(label)), state)
}

// Async so the file IO (and save's two fsyncs — temp file + dir, both
// F_FULLFSYNC on macOS) runs off the main/event-loop thread. Ordering is safe:
// the webview store issues at most one save_session at a time (its coalescer).
#[tauri::command]
async fn load_session(window: tauri::Window) -> Result<Option<String>, String> {
    read_session_from(&sessions_dir(window.app_handle())?, window.label())
}

#[tauri::command]
async fn save_session(window: tauri::Window, state: String) -> Result<(), String> {
    let _disk = guard(&ARRIVAL_DISK_LOCK);
    // A deliberate close removes the snapshot; a save still in flight from the
    // webview that is going away must not put it back
    // (docs/specs/standalone.md §Per-window close).
    if let Some(windows) = window.app_handle().try_state::<WindowState>() {
        if windows.refuses_save(window.label()) {
            return Ok(());
        }
    }
    let dir = sessions_dir(window.app_handle())?;
    write_session_to(&dir, window.label(), &state)?;
    retire_saved_arrivals(&dir)
}

/// The suffix `write_file_atomically` leaves on a session snapshot's temp
/// sibling. Pinned against the real writer by
/// `session_temp_suffix_matches_what_the_writer_leaves`, so changing the
/// convention cannot leave the sweep below looking for a name nothing makes.
const SESSION_TEMP_SUFFIX: &str = ".json.tmp";

/// Delete every orphaned temp write in the sessions directory, at boot.
///
/// The writer removes its own temp on every error path, so what remains here is
/// the legacy and hard-crash migration: a kill between the temp write and the
/// rename leaves a file `load_session` cannot see and nothing else will ever
/// overwrite — and a snapshot written before Dormouse stopped storing
/// transcripts carries one. Deleting is the point: those bytes have to leave the
/// disk (docs/specs/transport.md -> "Retiring the transcripts already on disk").
/// Never touches a live snapshot; the window that owns one rewrites it itself.
fn sweep_orphan_session_temps(dir: &Path) -> Result<(), String> {
    let suffix = SESSION_TEMP_SUFFIX;
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // No sessions directory yet (a first launch) is the desired end state.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("read sessions dir {}: {e}", dir.display())),
    };
    let mut first_error = None;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.ends_with(suffix) {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) if first_error.is_none() => {
                first_error = Some(format!(
                    "remove orphaned session temp {}: {e}",
                    entry.path().display()
                ));
            }
            Err(_) => {}
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Delete everything a window leaves on disk: its snapshot, any temp write, and
/// its geometry sibling. A per-window close is deliberate, so unlike a quit it
/// takes the window off the next launch's restore list
/// (docs/specs/standalone.md §Per-window close).
fn remove_session_from(dir: &Path, label: &str) -> Result<(), String> {
    let mut first_error = None;
    let session = dir.join(session_file_name(label));
    for path in [temp_write_path(&session), geometry_path(dir, label), session] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) if first_error.is_none() => {
                first_error = Some(format!("remove {}: {e}", path.display()));
            }
            Err(_) => {}
        }
    }
    first_error.map_or(Ok(()), Err)
}

// --- Window geometry (docs/specs/standalone.md §Windows) ---------------------
//
// A sibling of the session snapshot rather than `tauri-plugin-window-state`:
// one store answers "which windows exist", the boot enumeration is already
// Rust's job, and no new Cargo/npm dependency rides the disclosure and cooldown.

/// Logical, not physical: a snapshot taken on one display must reopen sensibly
/// on another with a different scale factor.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
struct WindowGeometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Moves and resizes arrive per frame while a window is dragged; write at most
/// one file per window per this interval.
const GEOMETRY_DEBOUNCE_MS: u64 = 400;

/// One window's outer box in **physical** pixels, plus the scale that turns it
/// logical. Kept live from the `Moved` / `Resized` payloads, so neither the
/// debounced write nor the drag hit test has to ask the platform per event.
#[derive(Clone, Copy, Debug, PartialEq)]
struct CachedRect {
    origin: (i32, i32),
    size: (u32, u32),
    scale: f64,
}

impl CachedRect {
    /// Fold in a window event, which carries only the half that changed.
    fn apply(&mut self, origin: Option<(i32, i32)>, size: Option<(u32, u32)>) {
        if let Some(origin) = origin {
            self.origin = origin;
        }
        if let Some(size) = size {
            self.size = size;
        }
    }

    /// The box a snapshot stores. Logical, not physical: one taken on one
    /// display must reopen sensibly on another with a different scale factor.
    fn to_logical(self) -> WindowGeometry {
        WindowGeometry {
            x: f64::from(self.origin.0) / self.scale,
            y: f64::from(self.origin.1) / self.scale,
            width: f64::from(self.size.0) / self.scale,
            height: f64::from(self.size.1) / self.scale,
        }
    }

    /// How the cross-window drag hit test sees this window.
    fn hit_rect(self, label: &str, hittable: bool) -> routing::WindowRect {
        routing::WindowRect {
            label: label.to_string(),
            origin: self.origin,
            size: self.size,
            scale: self.scale,
            hittable,
        }
    }
}

/// What the debounce thread owes, behind one lock.
///
/// The two are always read together, and the atomicity is the point: the flush
/// slot released *after* the dirty set was taken leaves a window whose `Moved`
/// landed in between marked dirty with no thread left to write it — and that
/// window is exactly one whose last move was its final position.
#[derive(Default)]
struct GeometryFlush {
    /// Labels whose cached rect has not reached disk yet.
    dirty: HashSet<String>,
    /// Whether a debounce thread is already going to drain `dirty`.
    flushing: bool,
}

/// Each window's outer box, plus what the debounce thread owes.
///
/// **Never call a platform query while holding `rects`.** Off the main thread
/// `scale_factor()` and `is_minimized()` block on the event loop, and the main
/// thread may be inside `window_at_cursor` waiting for this very lock. The flush
/// reads those values first and hands them to `refresh_rect`, which takes no
/// window at all so the rule cannot be broken by accident.
#[derive(Default)]
struct GeometryState {
    rects: Mutex<HashMap<String, CachedRect>>,
    flush: Mutex<GeometryFlush>,
}

impl GeometryState {
    /// Mark `label` dirty. `true` when the caller owes a debounce thread.
    fn mark_dirty(&self, label: &str) -> bool {
        let mut flush = guard(&self.flush);
        flush.dirty.insert(label.to_string());
        !std::mem::replace(&mut flush.flushing, true)
    }

    /// Everything pending, releasing the flush slot in the same step.
    fn take_dirty(&self) -> HashSet<String> {
        let mut flush = guard(&self.flush);
        flush.flushing = false;
        std::mem::take(&mut flush.dirty)
    }

    /// Fold a platform-read scale into the cached box and hand back a copy.
    /// Takes the value rather than the window: nothing may ask the platform
    /// anything while this lock is held.
    fn refresh_rect(&self, label: &str, scale: Option<f64>) -> Option<CachedRect> {
        let mut rects = guard(&self.rects);
        let rect = rects.get_mut(label)?;
        if let Some(scale) = scale {
            rect.scale = scale;
        }
        Some(*rect)
    }

    /// A window went away: its box and any pending write go with it.
    fn forget(&self, label: &str) {
        guard(&self.rects).remove(label);
        guard(&self.flush).dirty.remove(label);
    }
}

fn geometry_path(dir: &Path, label: &str) -> PathBuf {
    let safe = session_file_name(label);
    let stem = safe.strip_suffix(".json").unwrap_or(&safe);
    dir.join(format!("{stem}.geometry.json"))
}

fn read_geometry(dir: &Path, label: &str) -> Option<WindowGeometry> {
    let raw = std::fs::read_to_string(geometry_path(dir, label)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Seed the cache from the platform. Once per window, at creation: from there
/// the `Moved` / `Resized` payloads carry the new box themselves.
fn seed_geometry(app: &AppHandle, label: &str) {
    let (Some(state), Some(window)) = (
        app.try_state::<GeometryState>(),
        app.get_webview_window(label),
    ) else {
        return;
    };
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    // Every platform read before the lock (`GeometryState`).
    let scale = window.scale_factor().unwrap_or(1.0);
    guard(&state.rects).insert(
        label.to_string(),
        CachedRect {
            origin: (position.x, position.y),
            size: (size.width, size.height),
            scale,
        },
    );
}

/// Update the cached box from a window event and schedule the debounced write.
/// The event carries the new value, so this costs no platform round trip; the
/// minimized and scale checks belong to the flush, which runs once per window
/// per debounce window rather than once per frame of a drag.
fn note_geometry(app: &AppHandle, label: &str, origin: Option<(i32, i32)>, size: Option<(u32, u32)>) {
    let Some(state) = app.try_state::<GeometryState>() else {
        return;
    };
    {
        let mut rects = guard(&state.rects);
        let Some(rect) = rects.get_mut(label) else {
            // No seed means no window we know of; a `Destroyed` racing the last
            // `Moved` is the ordinary way here.
            return;
        };
        rect.apply(origin, size);
    }
    if !state.mark_dirty(label) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(GEOMETRY_DEBOUNCE_MS));
        let Some(state) = app.try_state::<GeometryState>() else {
            return;
        };
        let dirty = state.take_dirty();
        let Ok(dir) = sessions_dir(&app) else { return };
        for label in dirty {
            // A window that closed inside the debounce took its geometry file
            // with it; do not resurrect one for it.
            let Some(window) = app.get_webview_window(&label) else {
                continue;
            };
            // Both platform reads happen here, before the lock: this thread is
            // not the main one, so each of them parks on the event loop
            // (`GeometryState`). A minimized window reports a nonsense box on
            // some platforms; keep the last real one instead.
            if window.is_minimized().unwrap_or(false) {
                continue;
            }
            // Refreshed here, and only here: the drag hit test reads the cache
            // between flushes, and a `Moved` is what follows a window crossing
            // onto a display with a different scale factor.
            let scale = window.scale_factor().ok();
            let Some(rect) = state.refresh_rect(&label, scale) else {
                continue;
            };
            let Ok(json) = serde_json::to_string(&rect.to_logical()) else {
                continue;
            };
            if let Err(err) = write_file_atomically(&geometry_path(&dir, &label), &json) {
                append_log(format!("[window] geometry write for {label}: {err}"));
            }
        }
    });
}

// --- Notepad archive (docs/specs/notepad.md) ---------------------------------
//
// One machine-local archive per host, kept as `<app_data_dir>/notepad-archive-v1.json`
// — outside `sessions/`, and outside the state root, so dev and the installed app
// share it. A Surface's notes outlive the window whose closure archived them, so
// they must not ride the per-window session blob or be swept with that directory.
//
// The port is compare-and-swap (`NotepadArchivePort` in
// lib/src/lib/notepad/types.ts): the webview reads the bytes plus an opaque
// revision, applies its mutation, and writes back naming the revision it read.
// A stale revision answers "conflict" and the webview retries against a fresh
// read, so two overlapping mutations cannot drop one another's batches.
//
// The revision is a hash of the stored bytes, and every load, save and reset
// runs under an exclusive lock on a sidecar lock file. Both are needed because
// `app_data_dir()` is keyed by the Tauri identifier and nothing enforces one
// launch per identifier: two launches of the installed app share a data
// directory, as do two `pnpm dev:standalone` runs in one worktree, whose
// identifier is per-worktree and stable. A hash is the only revision two
// processes agree on without talking to each other: a counter only ever
// tracked this process's own writes, so the loser of an overlapping load→save
// silently overwrote the winner's batches. The lock makes read-compare-rename
// one step, so the loser is told "conflict" and retries instead. `None` means
// nothing is stored — what a first save names as its base, and what a reset
// leaves behind.

const NOTEPAD_ARCHIVE_FILE: &str = "notepad-archive-v1.json";

#[derive(Default)]
struct NotepadArchiveState {
    /// Serializes this process's own load / save / reset, ahead of the
    /// interprocess file lock those take: the intra-process path is then
    /// ordered regardless of how a platform scopes an advisory lock, and two
    /// threads here can never queue on each other through the filesystem.
    gate: Mutex<()>,
}

fn notepad_archive_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(NOTEPAD_ARCHIVE_FILE))
}

/// The lock guarding every access to `path`, derived from its name so the two
/// can never drift apart.
///
/// A *separate* file, never renamed: the archive itself is replaced by rename on
/// every save, so its inode is a new one each time and cannot carry a lock.
fn notepad_archive_lock_path(path: &Path) -> PathBuf {
    path.with_extension("lock")
}

/// Exclusive access to the archive, released when it drops.
///
/// Taken gate first, then the interprocess file lock. The fields are declared
/// in the reverse of that on purpose — Rust drops them in declaration order, and
/// a gate released ahead of the file lock would let the next thread through only
/// to block on the filesystem, which is the one thing the gate exists to prevent
/// (`NotepadArchiveState::gate`).
struct ArchiveLock<'a> {
    _file: File,
    _gate: MutexGuard<'a, ()>,
}

/// The one way in: no caller may take either half on its own.
fn lock_archive<'a>(gate: &'a Mutex<()>, path: &Path) -> Result<ArchiveLock<'a>, String> {
    let gate = gate
        .lock()
        .map_err(|_| "failed to lock the notepad archive".to_string())?;
    let file = lock_notepad_archive(path)?;
    Ok(ArchiveLock {
        _file: file,
        _gate: gate,
    })
}

/// Take the interprocess lock, blocking until it is ours; released when the
/// returned handle drops.
///
/// Reported rather than swallowed: this lock is what makes the compare-and-swap
/// correct across processes, so carrying on without it would silently reinstate
/// the overwrite it exists to close. Blocking is safe because every caller is a
/// `#[tauri::command(async)]` off the event loop, and each holder does one small
/// read or write.
fn lock_notepad_archive(path: &Path) -> Result<File, String> {
    ensure_parent_with(path, restrict_to_owner)?;
    let lock_path = notepad_archive_lock_path(path);
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        // Never truncated: the file is a lock, and its bytes (none) are not
        // state anyone reads.
        .truncate(false)
        .open(&lock_path)
        .map_err(|e| format!("open notepad archive lock: {e}"))?;
    // Carries no bytes, but it names the archive and sits beside it, so it gets
    // the same owner-only mode the archive does.
    let _ = restrict_to_owner(&lock_path, 0o600);
    file.lock()
        .map_err(|e| format!("lock notepad archive: {e}"))?;
    Ok(file)
}

/// The compare-and-swap token: a hash of exactly the bytes on disk.
///
/// `DefaultHasher::new()` is fixed-key rather than randomly seeded, which is the
/// property that matters — two processes, and two runs of one process, must
/// derive the same token from the same file or every save after a restart would
/// read as a conflict.
fn archive_revision(contents: &str) -> String {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    contents.hash(&mut hasher);
    format!("{}-{:016x}", contents.len(), hasher.finish())
}

/// The stored bytes and their revision, with the lock already held.
fn read_notepad_archive_locked(path: &Path) -> Result<Option<(String, String)>, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => {
            let revision = archive_revision(&contents);
            Ok(Some((contents, revision)))
        }
        // Nothing stored — including after a reset moved it aside — so the next
        // save must name a null base revision.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read notepad archive: {e}")),
    }
}

fn read_notepad_archive_from(
    path: &Path,
    gate: &Mutex<()>,
) -> Result<Option<(String, String)>, String> {
    let _lock = lock_archive(gate, path)?;
    read_notepad_archive_locked(path)
}

fn write_notepad_archive_to(
    path: &Path,
    gate: &Mutex<()>,
    state: &str,
    base_revision: Option<&str>,
) -> Result<String, String> {
    // Held across the whole compare-and-write: the comparison is worth nothing
    // if another save — this process's or another Dormouse's — can land between
    // it and the rename.
    let _lock = lock_archive(gate, path)?;
    // Re-read under the lock rather than trusting anything cached: a revision
    // nobody minted (a garbled one, or one whose bytes another process has since
    // replaced) then reads as a conflict rather than as an error the caller
    // would have to handle separately.
    let current = read_notepad_archive_locked(path)?.map(|(_, revision)| revision);
    if current.as_deref() != base_revision {
        return Ok("conflict".to_string());
    }
    write_file_atomically(path, state)?;
    Ok("ok".to_string())
}

/// Move an unreadable archive aside, never delete it.
///
/// The recovery that calls this knows only that the stored bytes do not parse;
/// they are still the user's notes, so they are renamed to
/// `notepad-archive-v1.unreadable-<unix-millis>.json` beside the original and
/// left for whoever wants to salvage them (docs/specs/notepad.md).
fn reset_notepad_archive_at(path: &Path, gate: &Mutex<()>) -> Result<(), String> {
    let _lock = lock_archive(gate, path)?;
    let dir = path
        .parent()
        .ok_or_else(|| format!("no parent directory for {}", path.display()))?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    // Derived from the archive's own name so the two can never drift apart.
    let stem = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    // The name is per-millisecond; on the vanishing chance two recoveries land
    // inside one, disambiguate rather than let the rename overwrite the earlier
    // quarantine — surviving is the entire point of this file.
    let mut target = dir.join(format!("{stem}.unreadable-{millis}.json"));
    let mut nth = 2;
    while target.exists() {
        target = dir.join(format!("{stem}.unreadable-{millis}-{nth}.json"));
        nth += 1;
    }
    match std::fs::rename(path, &target) {
        Ok(()) => {}
        // Nothing stored is the desired end state, not a failure.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("quarantine notepad archive: {e}")),
    }
    // A temp file left by a crash before its rename was never a readable
    // archive, so unlike the file above it is dropped rather than kept.
    let tmp = temp_write_path(path);
    match std::fs::remove_file(&tmp) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("remove notepad archive temp: {e}")),
    }
    Ok(())
}

// Async like the session commands: the read, and the save's two fsyncs, run off
// the main/event-loop thread.
#[tauri::command(async)]
fn load_notepad_archive(
    app: AppHandle,
    archive: tauri::State<'_, NotepadArchiveState>,
) -> Result<Option<(String, String)>, String> {
    read_notepad_archive_from(&notepad_archive_path(&app)?, &archive.gate)
}

/// `"ok"` or `"conflict"` — the stored archive moved since `base_revision` was
/// read, and the caller owes it a retry.
#[tauri::command(async)]
fn save_notepad_archive(
    app: AppHandle,
    archive: tauri::State<'_, NotepadArchiveState>,
    state: String,
    base_revision: Option<String>,
) -> Result<String, String> {
    write_notepad_archive_to(
        &notepad_archive_path(&app)?,
        &archive.gate,
        &state,
        base_revision.as_deref(),
    )
}

#[tauri::command(async)]
fn reset_notepad_archive(
    app: AppHandle,
    archive: tauri::State<'_, NotepadArchiveState>,
) -> Result<(), String> {
    reset_notepad_archive_at(&notepad_archive_path(&app)?, &archive.gate)
}

// ── Window lifecycle (docs/specs/standalone.md §Windows) ─────────────────────

/// Every file name in the sessions directory, for the boot enumeration.
fn session_file_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .collect()
}

/// Give `main` back its saved box and reopen every other saved window, in the
/// order `restorable_labels` produced (`main` first). The cap is a ceiling on
/// how many windows one launch may open; the excess stays on disk untouched.
fn restore_windows(app: &AppHandle, dir: &Path, labels: &[String]) {
    if let Some(window) = app.get_webview_window(routing::MAIN_LABEL) {
        if let Some(geometry) = read_geometry(dir, routing::MAIN_LABEL) {
            let _ = window.set_position(tauri::LogicalPosition::new(geometry.x, geometry.y));
            let _ = window.set_size(tauri::LogicalSize::new(geometry.width, geometry.height));
        }
    }
    let mut opened = 1usize;
    for label in labels.iter().filter(|label| *label != routing::MAIN_LABEL) {
        if opened >= routing::MAX_RESTORED_WINDOWS {
            append_log(format!(
                "[window] not reopening {label}: {} windows is the cap; its snapshot stays on disk",
                routing::MAX_RESTORED_WINDOWS
            ));
            continue;
        }
        // An unreadable snapshot still opens its window: the webview boots
        // fresh, which is a window the user can use rather than one they lost.
        if let Err(err) = build_window(app, label, read_geometry(dir, label)) {
            append_log(format!("[window] {err}"));
            continue;
        }
        opened += 1;
    }
    // Last, so it comes up in front of the windows opened behind it.
    if let Some(window) = app.get_webview_window(routing::MAIN_LABEL) {
        let _ = window.set_focus();
    }
}


/// Open a window cloned from `tauri.conf.json`'s first window config, so
/// `titleBarStyle`, `hiddenTitle`, `dragDropEnabled` and the CSP carry across
/// without a second copy of any of them.
fn build_window(
    app: &AppHandle,
    label: &str,
    geometry: Option<WindowGeometry>,
) -> Result<(), String> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "no window config to clone".to_string())?;
    config.label = label.to_string();
    if let Some(geometry) = geometry {
        config.x = Some(geometry.x);
        config.y = Some(geometry.y);
        config.width = geometry.width;
        config.height = geometry.height;
        // An explicit position and a centering request are contradictory.
        config.center = false;
    }
    let window = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|err| format!("configure window {label}: {err}"))?
        .build()
        .map_err(|err| format!("build window {label}: {err}"))?;
    // macOS keeps `titleBarStyle: "Overlay"` from the config, which preserves
    // rounded corners and native traffic lights; everywhere else the title bar
    // is fully custom (§AppBar).
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_decorations(false);
    }
    #[cfg(target_os = "macos")]
    let _ = &window;
    // The only platform read of this window's box: from here the `Moved` /
    // `Resized` payloads keep the cache current (§Boot and geometry).
    seed_geometry(app, label);
    Ok(())
}

/// The label a new window takes: `ws-<n>` above every live and saved one.
fn next_window_label(windows: &WindowState) -> String {
    format!(
        "{}{}",
        routing::WS_LABEL_PREFIX,
        windows.next_ws.fetch_add(1, Ordering::SeqCst)
    )
}

fn payload_terminal_ids(payload: &JsonValue) -> Vec<String> {
    payload
        .get("terminalIds")
        .and_then(JsonValue::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

// ── Pending arrivals on disk (docs/specs/standalone.md §Arrival queue) ───────
//
// A transferring Workspace is in neither window's snapshot: the source omits it
// from its saves the moment the invoke returns and the target writes only after
// adoption. `sessions/arrivals.json` — a JSON array of
// `{ workspaceId, from, to, workspace }` — is what a crash in that gap restores
// it from. Its own file, never an entry planted in a snapshot: a tear-out
// window that finds a snapshot boots as a restore (`bootFromTearOut`) and then
// throws on adopting the same id, and a live target's own debounced flush
// rewrites its file without anything it has not adopted yet. On the normal
// path the record retires after both windows flush their new membership.

const ARRIVALS_FILE: &str = "arrivals.json";
// Serializes journal updates with snapshot writes and retirement checks. Never
// acquired while emitting events; helpers below do not acquire it recursively.
static ARRIVAL_DISK_LOCK: Mutex<()> = Mutex::new(());

/// An adopted arrival stays recoverable until BOTH snapshots reflect the move.
fn retire_saved_arrivals(dir: &Path) -> Result<(), String> {
    let records = read_arrivals_from(dir)?;
    let mut keep = Vec::new();
    for record in &records {
        let durable = (|| -> Result<bool, String> {
            if record.get("settled").and_then(JsonValue::as_bool) != Some(true) { return Ok(false); }
            let Some(id) = record_workspace_id(record) else { return Ok(false); };
            let Some(from) = record.get("from").and_then(JsonValue::as_str) else { return Ok(false); };
            let Some(to) = record.get("to").and_then(JsonValue::as_str) else { return Ok(false); };
            let target_has = read_snapshot_from(dir, to)?.is_some_and(|s| workspaces::snapshot_ids(&s).iter().any(|v| v == id));
            let source_has = read_snapshot_from(dir, from)?.is_some_and(|s| workspaces::snapshot_ids(&s).iter().any(|v| v == id));
            Ok(if record.get("discarded").and_then(JsonValue::as_bool) == Some(true) {
                !target_has && !source_has
            } else { target_has && !source_has })
        })();
        if !matches!(durable, Ok(true)) { keep.push(record.clone()); }
    }
    if keep.len() != records.len() { write_arrivals_to(dir, &keep)?; }
    Ok(())
}

fn mark_arrival_adopted_on_disk(dir: &Path, workspace_id: &str) -> Result<(), String> {
    let _disk = guard(&ARRIVAL_DISK_LOCK);
    let mut records = read_arrivals_from(dir)?;
    for record in &mut records {
        if record_workspace_id(record) == Some(workspace_id) { record["settled"] = JsonValue::Bool(true); }
    }
    write_arrivals_to(dir, &records)?;
    retire_saved_arrivals(dir)
}

/// Refusal reverses the durable destination before the source is told to save.
fn return_arrival_on_disk(dir: &Path, arrival: &routing::Arrival) -> Result<(), String> {
    let _disk = guard(&ARRIVAL_DISK_LOCK);
    let mut records = read_arrivals_from(dir)?;
    records.retain(|r| record_workspace_id(r) != Some(&arrival.workspace_id));
    records.push(serde_json::json!({
        "workspaceId": arrival.workspace_id, "from": arrival.to, "to": arrival.from,
        "workspace": arrival.payload["workspace"], "settled": true,
    }));
    write_arrivals_to(dir, &records)?;
    retire_saved_arrivals(dir)
}

/// A deliberate close cancels recovery into this window. Keep a tombstone
/// while another snapshot still contains the transferred Workspace, so boot
/// removes that stale copy instead of resurrecting it in either window.
fn close_window_snapshot(dir: &Path, label: &str) -> Result<(), String> {
    let _disk = guard(&ARRIVAL_DISK_LOCK);
    let mut records = read_arrivals_from(dir)?;
    let mut changed = false;
    for record in &mut records {
        if record.get("to").and_then(JsonValue::as_str) == Some(label)
            && record.get("settled").and_then(JsonValue::as_bool) == Some(true)
        {
            record["discarded"] = JsonValue::Bool(true);
            changed = true;
        }
    }
    if changed { write_arrivals_to(dir, &records)?; }
    remove_session_from(dir, label)?;
    retire_saved_arrivals(dir)
}

fn remove_workspace_from_disk(dir: &Path, label: &str, id: &str) -> Result<(), String> {
    let Some(mut snapshot) = read_snapshot_from(dir, label)? else { return Ok(()); };
    if !snapshot_without_workspace(&mut snapshot, id) { return Ok(()); }
    if snapshot.get("workspaces").and_then(JsonValue::as_array).is_some_and(Vec::is_empty) {
        remove_session_from(dir, label)
    } else { write_session_to(dir, label, &snapshot.to_string()) }
}

fn arrivals_path(dir: &Path) -> PathBuf {
    dir.join(ARRIVALS_FILE)
}

fn read_arrivals_from(dir: &Path) -> Result<Vec<JsonValue>, String> {
    match std::fs::read_to_string(arrivals_path(dir)) {
        Ok(contents) => serde_json::from_str::<Vec<JsonValue>>(&contents)
            .map_err(|e| format!("unreadable {ARRIVALS_FILE}: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read {ARRIVALS_FILE}: {e}")),
    }
}

/// An empty list removes the file, so a run with nothing in flight leaves none.
fn write_arrivals_to(dir: &Path, records: &[JsonValue]) -> Result<(), String> {
    if records.is_empty() {
        return match std::fs::remove_file(arrivals_path(dir)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("remove {ARRIVALS_FILE}: {e}")),
        };
    }
    write_file_atomically(&arrivals_path(dir), &JsonValue::Array(records.to_vec()).to_string())
}

fn record_workspace_id(record: &JsonValue) -> Option<&str> {
    record.get("workspaceId").and_then(JsonValue::as_str)
}

/// Append one arrival's record, replacing any earlier record of the same id.
fn record_arrival_on_disk(dir: &Path, arrival: &routing::Arrival) -> Result<(), String> {
    let _disk = guard(&ARRIVAL_DISK_LOCK);
    let Some(workspace) = arrival.payload.get("workspace") else {
        return Err("arrival payload carries no workspace".to_string());
    };
    let mut records = read_arrivals_from(dir)?;
    records.retain(|record| record_workspace_id(record) != Some(&arrival.workspace_id));
    records.push(serde_json::json!({
        "workspaceId": arrival.workspace_id,
        "from": arrival.from,
        "to": arrival.to,
        "workspace": workspace,
    }));
    write_arrivals_to(dir, &records)
}

/// Drop the record: the arrival settled, one way or the other. Adopted, the
/// target flushes the Workspace itself; handed back, the source persists it
/// again as soon as it clears the transferring mark. A no-op for an id that
/// was never recorded.
fn forget_arrival_on_disk(dir: &Path, workspace_id: &str) -> Result<(), String> {
    let _disk = guard(&ARRIVAL_DISK_LOCK);
    let mut records = read_arrivals_from(dir)?;
    let before = records.len();
    records.retain(|record| record_workspace_id(record) != Some(workspace_id));
    if records.len() == before {
        return Ok(());
    }
    write_arrivals_to(dir, &records)
}

/// `snapshot` (a `PersistedWindow`, or none for a window that never wrote one)
/// with `workspace` in its list, replacing any entry of the same id. A snapshot
/// created here holds just this Workspace, active.
fn snapshot_with_workspace(
    snapshot: Option<JsonValue>,
    workspace: &JsonValue,
) -> Result<JsonValue, String> {
    let Some(id) = workspace.get("id").and_then(JsonValue::as_str) else {
        return Err("arrival record names no workspace.id".to_string());
    };
    let mut snapshot = snapshot.unwrap_or_else(
        || serde_json::json!({ "version": 1, "workspaces": [], "activeWorkspaceId": id }),
    );
    let workspaces = snapshot
        .get_mut("workspaces")
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| "snapshot has no workspaces list".to_string())?;
    workspaces.retain(|entry| entry.get("id").and_then(JsonValue::as_str) != Some(id));
    workspaces.push(workspace.clone());
    Ok(snapshot)
}

/// Take `id` out of `snapshot`'s list; whether it was there.
fn snapshot_without_workspace(snapshot: &mut JsonValue, id: &str) -> bool {
    let Some(workspaces) = snapshot.get_mut("workspaces").and_then(JsonValue::as_array_mut) else {
        return false;
    };
    let before = workspaces.len();
    workspaces.retain(|entry| entry.get("id").and_then(JsonValue::as_str) != Some(id));
    workspaces.len() != before
}

fn read_snapshot_from(dir: &Path, label: &str) -> Result<Option<JsonValue>, String> {
    read_session_from(dir, label)?
        .map(|contents| {
            serde_json::from_str::<JsonValue>(&contents)
                .map_err(|e| format!("unreadable snapshot for {label}: {e}"))
        })
        .transpose()
}

/// Every record still on disk at boot is a crash's leftover, so the Workspace
/// is in no snapshot. Put it into its target's — a tear-out target that never
/// opened gets a file, which the boot enumeration then reopens — and take it
/// out of the source's where that still names it (the source crashed before its
/// own flush), so it restores once. A source emptied that way is removed like
/// a closed window: its last Workspace left. The file goes last, so a crash
/// mid-merge replays it; a failed record stays for retry. An unreadable journal
/// is logged and dropped because its entries cannot be recovered.
fn restore_arrivals(dir: &Path) -> Result<(), String> {
    let _disk = guard(&ARRIVAL_DISK_LOCK);
    let records = match read_arrivals_from(dir) {
        Ok(records) => records,
        Err(e) => {
            let _ = write_arrivals_to(dir, &[]);
            return Err(e);
        }
    };
    if records.is_empty() {
        return Ok(());
    }
    let mut failed = Vec::new();
    for record in &records {
        if let Err(e) = restore_arrival(dir, record) {
            append_log(format!("[window] retaining a record from {ARRIVALS_FILE}: {e}"));
            failed.push(record.clone());
        }
    }
    write_arrivals_to(dir, &failed)
}

/// One record of the boot merge above: into the target's snapshot, out of the
/// source's.
fn restore_arrival(dir: &Path, record: &JsonValue) -> Result<(), String> {
    let fields = (
        record_workspace_id(record),
        record.get("from").and_then(JsonValue::as_str),
        record.get("to").and_then(JsonValue::as_str),
        record.get("workspace"),
    );
    let (Some(id), Some(from), Some(to), Some(workspace)) = fields else {
        return Err("malformed record".to_string());
    };
    if record.get("discarded").and_then(JsonValue::as_bool) == Some(true) {
        remove_workspace_from_disk(dir, from, id)?;
        return remove_workspace_from_disk(dir, to, id);
    }
    append_log(format!(
        "[window] {id} was in flight from {from} to {to} at the last exit; restoring it in {to}"
    ));
    // Read both before writing either. If trimming the source fails after the
    // target write, restore its old bytes and retain the journal for retry.
    let previous_target = read_snapshot_from(dir, to)?;
    let source = read_snapshot_from(dir, from)?;
    // Once adoption settled, the target may already hold a newer snapshot.
    // Preserve that record while finishing the source side of the transaction.
    let existing = previous_target.as_ref()
        .and_then(|s| s.get("workspaces")).and_then(JsonValue::as_array)
        .and_then(|entries| entries.iter().find(|entry| entry.get("id").and_then(JsonValue::as_str) == Some(id)));
    let restore = if record.get("settled").and_then(JsonValue::as_bool) == Some(true) {
        existing.unwrap_or(workspace)
    } else { workspace };
    let merged = snapshot_with_workspace(previous_target.clone(), restore)?;
    write_session_to(dir, to, &merged.to_string())?;
    let trim = (|| -> Result<(), String> {
        let Some(mut source) = source else { return Ok(()); };
        if !snapshot_without_workspace(&mut source, id) { return Ok(()); }
        let emptied = source.get("workspaces").and_then(JsonValue::as_array).is_some_and(Vec::is_empty);
        if emptied { remove_session_from(dir, from) }
        else { write_session_to(dir, from, &source.to_string()) }
    })();
    if let Err(error) = trim {
        let rollback = match previous_target {
            Some(snapshot) => write_session_to(dir, to, &snapshot.to_string()),
            None => std::fs::remove_file(dir.join(session_file_name(to))).map_err(|e| e.to_string()),
        };
        if let Err(e) = rollback { append_log(format!("[window] arrival rollback failed: {e}")); }
        return Err(error);
    }
    Ok(())
}

/// The record one drop becomes.
fn arrival_from(from: &str, to: &str, payload: JsonValue) -> Result<routing::Arrival, String> {
    let workspace_id = payload
        .get("workspaceId")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| "a transfer payload must name its workspaceId".to_string())?
        .to_string();
    let terminal_ids = payload_terminal_ids(&payload);
    Ok(routing::Arrival {
        workspace_id,
        from: from.to_string(),
        to: to.to_string(),
        terminal_ids,
        payload,
        queued_at: Instant::now(),
    })
}

/// Open one arrival: reassign its shells to the target and suppress them, then
/// queue the record. **Ownership moves synchronously here**, before either
/// window is told anything — the single Rust reader thread processes sidecar
/// lines in order, so every byte after this point is either dropped (and present
/// in the replay the target is about to get) or delivered to the target
/// (docs/specs/standalone.md §Transfer).
fn begin_arrival(
    app: &AppHandle,
    windows: &WindowState,
    arrival: routing::Arrival,
) -> Result<(), String> {
    {
        let mut arrivals = guard(&windows.arrivals);
        if routing::has_arrival(&arrivals, &arrival.workspace_id) {
            return Err(format!(
                "Workspace '{}' is already in flight",
                arrival.workspace_id
            ));
        }
        windows.reassign(&arrival.terminal_ids, &arrival.to, true);
        routing::queue_arrival(&mut arrivals, arrival.clone());
    }
    // Recorded on disk here, in neither window's snapshot: the source omits a
    // transferring Workspace from its saves and the target writes only after
    // adoption, so a crash in the gap would otherwise restore it nowhere
    // (§Arrival queue). Never fatal: a failed write is logged and the transfer
    // proceeds.
    match sessions_dir(app) {
        Ok(dir) => {
            if let Err(e) = record_arrival_on_disk(&dir, &arrival) {
                append_log(format!("[window] could not record {} on disk: {e}", arrival.workspace_id));
            }
        }
        Err(e) => append_log(format!("[window] {e}")),
    }
    spawn_arrival_watchdog(app.clone(), &arrival);
    Ok(())
}

/// Bound an arrival: a target that never settles it — alive but wedged, so
/// `Destroyed` never hands it back either — would leave the Workspace marked
/// transferring in the source and its shells silent for good. Past
/// `ARRIVAL_MAX` the record is retired and handed back like any refusal.
fn spawn_arrival_watchdog(app: AppHandle, arrival: &routing::Arrival) {
    let workspace_id = arrival.workspace_id.clone();
    let to = arrival.to.clone();
    let queued_at = arrival.queued_at;
    std::thread::spawn(move || {
        std::thread::sleep(routing::ARRIVAL_MAX);
        let Some(windows) = app.try_state::<WindowState>() else {
            return;
        };
        let expired = routing::expire_arrival(
            &mut guard(&windows.arrivals),
            &workspace_id,
            &to,
            queued_at,
        );
        if let Some(arrival) = expired {
            hand_back_arrival(&app, &windows, &arrival, "the target never adopted it");
        }
    });
}

/// One arrival will never be adopted: give its shells back to the source,
/// unsuppressed, and tell the source so it clears the Workspace's transferring
/// mark. **The Workspace simply stays where it is** — nothing was released, so
/// there is nothing to put back.
///
/// The record must already be out of the queue; the caller took it.
fn hand_back_arrival(
    app: &AppHandle,
    windows: &WindowState,
    arrival: &routing::Arrival,
    reason: &str,
) {
    append_log(format!(
        "[window] {} never arrived in {} ({reason}); handing it back to {}",
        arrival.workspace_id, arrival.to, arrival.from
    ));
    if app.get_webview_window(&arrival.from).is_some() {
        if let Ok(dir) = sessions_dir(app) {
            if let Err(e) = return_arrival_on_disk(&dir, arrival) {
                append_log(format!("[window] could not record hand-back: {e}"));
            }
        }
        windows.reassign(&arrival.terminal_ids, &arrival.from, false);
        let _ = app.emit_to(
            arrival.from.as_str(),
            "dormouse://workspace-arrival-failed",
            serde_json::json!({ "workspaceId": arrival.workspace_id, "reason": reason }),
        );
        return;
    }
    if let Ok(dir) = sessions_dir(app) {
        if let Err(e) = forget_arrival_on_disk(&dir, &arrival.workspace_id) {
            append_log(format!("[window] could not forget orphaned arrival: {e}"));
        }
    }
    // Both ends are gone, so these shells belong to no window and nothing would
    // ever paint them (`routing::owner`).
    for id in &arrival.terminal_ids {
        windows.forget_pty(id);
    }
    reap_orphaned_ptys(app, &arrival.from, arrival.terminal_ids.clone());
}

/// Tear a Workspace out into a brand-new window under the cursor.
///
/// The payload is *queued*, never emitted: an `emit_to` a window that does not
/// exist yet is lost, so the new webview drains it with `take_arrivals` during
/// its own boot (docs/specs/standalone.md §Arrival queue).
#[tauri::command(async)]
fn open_workspace_window(
    app: AppHandle,
    window: tauri::Window,
    windows: tauri::State<'_, WindowState>,
    payload: JsonValue,
) -> Result<String, String> {
    let label = next_window_label(&windows);
    // Positioned so the dragged tab lands under the cursor, at the source
    // window's size. Only Rust knows where the cursor is on screen, so the
    // webview sends the offset the tab should keep inside the new window.
    let geometry = {
        let scale = window.scale_factor().unwrap_or(1.0);
        let size = window
            .outer_size()
            .map(|size| size.to_logical::<f64>(scale))
            .ok();
        let grab = payload.get("grab");
        let offset = grab
            .and_then(|grab| grab.get("x")?.as_f64().zip(grab.get("y")?.as_f64()))
            .unwrap_or((0.0, 0.0));
        match (app.cursor_position().ok(), size) {
            (Some(cursor), Some(size)) => Some(WindowGeometry {
                x: cursor.x / scale - offset.0,
                y: cursor.y / scale - offset.1,
                width: size.width,
                height: size.height,
            }),
            _ => None,
        }
    };
    let arrival = arrival_from(window.label(), &label, payload)?;
    // The one thing needed after the record is queued, so the payload itself is
    // moved rather than cloned.
    let workspace_id = arrival.workspace_id.clone();
    append_log(format!("[window] tearing {workspace_id} out into {label}"));
    begin_arrival(&app, &windows, arrival)?;
    if let Err(err) = build_window(&app, &label, geometry) {
        // Nothing will ever drain the queue, and the PTYs would stay suppressed
        // and ownerless. The source is waiting on this `Err` and has released
        // nothing, so the ids go back in silence — no `arrival-failed`, which
        // would clear a transferring mark that was never set.
        if let Some(arrival) =
            routing::take_arrival(&mut guard(&windows.arrivals), &workspace_id, &label)
        {
            windows.reassign(&arrival.terminal_ids, &arrival.from, false);
            if let Ok(dir) = sessions_dir(&app) {
                let _ = return_arrival_on_disk(&dir, &arrival);
            }
        }
        return Err(err);
    }
    send_window_labels(&app);
    Ok(label)
}

/// Move a Workspace into a window that already exists.
#[tauri::command(async)]
fn transfer_workspace(
    app: AppHandle,
    window: tauri::Window,
    windows: tauri::State<'_, WindowState>,
    to: String,
    payload: JsonValue,
) -> Result<(), String> {
    if app.get_webview_window(&to).is_none() {
        return Err(format!("no window '{to}'"));
    }
    if to == window.label() {
        return Err("a Workspace cannot be transferred to its own window".to_string());
    }
    let arrival = arrival_from(window.label(), &to, payload)?;
    append_log(format!(
        "[window] transferring {} from {} to {to}",
        arrival.workspace_id,
        window.label()
    ));
    // Queued, not emitted: the target may be booting, or torn out moments ago,
    // and have no listener yet — and it is a legal drop target either way
    // (docs/specs/standalone.md §Arrival queue).
    begin_arrival(&app, &windows, arrival)?;
    // Forward before the content lands: the user dropped here, so this is the
    // window they are now looking at, and a background webview may be throttled
    // out of answering `adopt_ready` promptly.
    if let Some(target) = app.get_webview_window(&to) {
        let _ = target.set_focus();
    }
    // A nudge, carrying nothing: the payload is in the queue, and a window with
    // no listener yet finds it there.
    let _ = app.emit_to(to.as_str(), "dormouse://workspace-arriving", ());
    Ok(())
}

/// The target has armed its collector for one arrival; ask the sidecar to list
/// and replay **exactly that arrival's** PTYs. This hop is what removes the
/// whole "arrived before armed" bug class.
///
/// **Never "everything suppressed for this window".** Two Workspaces can be in
/// flight into one window at once — a tear-out with a second tab dropped on it
/// moments later — and a window-wide answer would let each collector finish on
/// the other's shells, resuming a Workspace over panes that belong to its
/// neighbour.
///
/// **Always answers**, even with no ids at all: the collector waits on its own
/// `pty:list`, and a Workspace of browser panes alone would otherwise sit out
/// its whole timeout. An empty `ids` is an empty list, never everything
/// (`list` in `standalone/sidecar/pty-core.js`).
#[tauri::command]
fn adopt_ready(
    window: tauri::Window,
    state: tauri::State<'_, SidecarState>,
    windows: tauri::State<'_, WindowState>,
    workspace_id: String,
    request_id: Option<String>,
) -> Result<(), String> {
    let label = window.label();
    let ids = {
        let arrivals = guard(&windows.arrivals);
        let arrival = routing::find_arrival(&arrivals, &workspace_id)
            .filter(|arrival| arrival.to == label)
            .ok_or_else(|| format!("no arrival of '{workspace_id}' into {label}"))?;
        arrival.terminal_ids.clone()
    };
    let msg = serde_json::json!({
        "event": "pty:requestInit",
        "data": { "forWindow": label, "ids": ids, "requestId": request_id },
    });
    send_to_sidecar(&state, msg.to_string());
    Ok(())
}

/// The target has mounted the Workspace. Retire the record, drop what is left of
/// its suppression, and **only now** tell the source it may commit.
///
/// One Workspace, one message: a source with two Workspaces in flight into the
/// same window must not lose both because one of them landed.
#[tauri::command(async)]
fn adopt_done(
    app: AppHandle,
    window: tauri::Window,
    windows: tauri::State<'_, WindowState>,
    workspace_id: String,
) -> Result<(), String> {
    let arrival = routing::take_arrival(
        &mut guard(&windows.arrivals),
        &workspace_id,
        window.label(),
    )
    .ok_or_else(|| format!("no arrival of '{workspace_id}' into {}", window.label()))?;
    windows.clear_suppression(&arrival.terminal_ids);
    // Keep the journal until source and target saves both reflect the move.
    if let Ok(dir) = sessions_dir(&app) {
        if let Err(e) = mark_arrival_adopted_on_disk(&dir, &workspace_id) {
            append_log(format!("[window] could not forget {workspace_id} on disk: {e}"));
        }
    }
    append_log(format!(
        "[window] {workspace_id} adopted by {}; telling {}",
        arrival.to, arrival.from
    ));
    let _ = app.emit_to(
        arrival.from.as_str(),
        "dormouse://workspace-departed",
        serde_json::json!({ "workspaceId": arrival.workspace_id }),
    );
    Ok(())
}

/// The target refused the arrival — its PTYs never answered, or the mount threw.
#[tauri::command(async)]
fn adopt_failed(
    app: AppHandle,
    window: tauri::Window,
    windows: tauri::State<'_, WindowState>,
    workspace_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let arrival = routing::take_arrival(
        &mut guard(&windows.arrivals),
        &workspace_id,
        window.label(),
    )
    .ok_or_else(|| format!("no arrival of '{workspace_id}' into {}", window.label()))?;
    hand_back_arrival(
        &app,
        &windows,
        &arrival,
        reason.as_deref().unwrap_or("the target refused it"),
    );
    Ok(())
}

/// Every Workspace id every snapshot on disk names. Read once at setup to
/// seed the id counter; an unreadable file contributes nothing, which is safe
/// because such a file restores nothing either.
fn saved_workspace_ids(dir: &Path) -> Vec<String> {
    session_file_names(dir)
        .iter()
        .filter_map(|name| name.strip_suffix(".json"))
        .filter_map(|label| read_session_from(dir, label).ok().flatten())
        .filter_map(|contents| serde_json::from_str::<JsonValue>(&contents).ok())
        .flat_map(|snapshot| workspaces::snapshot_ids(&snapshot))
        .collect()
}

/// Hand a webview a block of ids to mint from. Ids come only from this
/// counter, so a ref is stable for the life of the Workspace and unique
/// across windows; an unused reservation is a gap in the numbering, nothing
/// more (§Workspace registry).
#[tauri::command]
fn workspace_reserve_ids(windows: tauri::State<'_, WindowState>, count: u64) -> Vec<String> {
    let count = count.clamp(1, 64);
    // Setup seeds this above every id on disk, but skips that when
    // `sessions_dir` fails; `workspace-1` is the bare Wall's own and
    // `workspace:0` names nothing (§Workspace registry).
    windows.next_workspace.fetch_max(2, Ordering::SeqCst);
    let first = windows.next_workspace.fetch_add(count, Ordering::SeqCst);
    (first..first + count)
        .map(|n| format!("workspace-{n}"))
        .collect()
}

/// A window's Workspace list, as it stands. Broadcast to every window when it
/// changed: the strip's move menu and `dor` routing read the union.
#[tauri::command]
fn workspace_report(
    app: AppHandle,
    window: tauri::Window,
    windows: tauri::State<'_, WindowState>,
    entries: Vec<workspaces::Entry>,
) {
    // A reported id above the counter (a snapshot restored from a newer
    // build, say) must never be minted again.
    let above = workspaces::seed_next(entries.iter().map(|entry| entry.id.as_str()));
    windows.next_workspace.fetch_max(above, Ordering::SeqCst);
    let changed = workspaces::report(&mut guard(&windows.registry), window.label(), entries);
    if changed {
        broadcast_registry(&app, &windows);
    }
}

/// The registry as it stands, for a webview that booted after the last
/// broadcast.
#[tauri::command]
fn workspace_registry(windows: tauri::State<'_, WindowState>) -> JsonValue {
    workspaces::snapshot(&guard(&windows.registry))
}

fn broadcast_registry(app: &AppHandle, windows: &WindowState) {
    let snapshot = workspaces::snapshot(&guard(&windows.registry));
    let _ = app.emit("dormouse://workspaces", snapshot);
}

/// Every Workspace in flight into this window, oldest first.
///
/// **Not consumed**: the record settles at `adopt_done`, so a webview that
/// drains at boot and again when its listener is installed sees only what it has
/// yet to adopt. The webview dedupes what it is already mounting.
#[tauri::command]
fn take_arrivals(window: tauri::Window, windows: tauri::State<'_, WindowState>) -> Vec<JsonValue> {
    routing::arrival_payloads(&guard(&windows.arrivals), window.label())
}

/// Remove this window's persisted snapshot and stop it being written again.
#[tauri::command]
async fn remove_window_session(window: tauri::Window) -> Result<(), String> {
    let app = window.app_handle();
    if let Some(windows) = app.try_state::<WindowState>() {
        windows.begin_closing(window.label());
    }
    close_window_snapshot(&sessions_dir(app)?, window.label())
}

/// Which window is under the cursor, in that window's own logical client space.
///
/// Runs off the geometry cache (§Boot and geometry) rather than re-asking the
/// platform for four numbers per window: a drag probes this ~16 times a second.
/// Visibility is not cached, being the one part no window event carries
/// reliably.
///
/// Tauri exposes no z-order, so among the windows containing the point the most
/// recently focused wins — right for a drag, and the hover caret makes a wrong
/// guess visible before release.
#[tauri::command]
fn window_at_cursor(
    app: AppHandle,
    windows: tauri::State<'_, WindowState>,
    geometry: tauri::State<'_, GeometryState>,
) -> Option<routing::CursorHit> {
    let point = app.cursor_position().ok()?;
    // Copied out first: the visibility queries below reach the platform, and
    // nothing may ask it anything while `rects` is held (`GeometryState`).
    let cached: Vec<(String, CachedRect)> = guard(&geometry.rects)
        .iter()
        .map(|(label, rect)| (label.clone(), *rect))
        .collect();
    let rects: Vec<routing::WindowRect> = cached
        .into_iter()
        .filter_map(|(label, rect)| {
            let window = app.get_webview_window(&label)?;
            let hittable =
                window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false);
            Some(rect.hit_rect(&label, hittable))
        })
        .collect();
    let focus_order = guard(&windows.focus_order).clone();
    routing::window_at(&rects, &focus_order, (point.x, point.y))
}

/// Show (or clear) another window's drop caret while a tab is dragged over it.
/// The previously hovered window is always cleared, so a caret can never be
/// left behind in a window the pointer has since left.
#[tauri::command]
fn hover_workspace_target(
    app: AppHandle,
    windows: tauri::State<'_, WindowState>,
    label: Option<String>,
    x: f64,
    y: f64,
) {
    let mut current = guard(&windows.hover_target);
    if current.as_deref() != label.as_deref() {
        if let Some(previous) = current.as_deref() {
            let _ = app.emit_to(previous, "dormouse://workspace-drop-hover", JsonValue::Null);
        }
    }
    *current = label.clone();
    if let Some(label) = label {
        let _ = app.emit_to(
            label.as_str(),
            "dormouse://workspace-drop-hover",
            serde_json::json!({ "x": x, "y": y }),
        );
    }
}

#[tauri::command]
fn kill_sidecar_now(state: tauri::State<'_, SidecarState>) {
    kill_sidecar_and_wait(&state.child);
}

// ── Quit protocol commands (docs/specs/standalone.md §Quit flow) ─────────────
//
// Every one keys by the invoking window's label: a quit is N conversations, and
// only the window that voted may be the window that tears down.

// This window's quit orchestrator received quit-requested and its listener is
// alive; stand the phase-1 ack watchdog down.
#[tauri::command]
fn quit_ack(window: tauri::Window, state: tauri::State<'_, QuitState>) {
    guard(&state.machine).ack(window.label());
}

// This window is ready to be torn down: its confirmation and archive gates are
// done. The last vote starts the walk.
#[tauri::command]
fn quit_vote(app: AppHandle, window: tauri::Window, state: tauri::State<'_, QuitState>) {
    let actions = guard(&state.machine).vote(window.label());
    apply_quit_actions(&app, actions);
}

// This window has started (or advanced) its teardown: the vote wait is over,
// and this phase boundary refreshes the watchdog's per-phase deadline. Sent at
// teardown start and again before installing an update, so a long install gets
// its own budget instead of sharing the teardown clock.
#[tauri::command]
fn quit_progress(window: tauri::Window, state: tauri::State<'_, QuitState>) {
    guard(&state.machine).progress(window.label());
}

// A window declined the quit. Bumping seq invalidates any live watchdog so
// nothing exits, every window's dialog is told to close, and nothing has been
// destroyed — which is the whole reason the windows vote before they walk.
#[tauri::command]
fn quit_cancel(app: AppHandle, state: tauri::State<'_, QuitState>) {
    let actions = guard(&state.machine).cancel();
    apply_quit_actions(&app, actions);
}

// A non-last window finished its teardown: destroy it and start the next one.
// Its snapshot stays on disk, which is what a relaunch restores it from.
#[tauri::command]
fn quit_window_done(app: AppHandle, window: tauri::Window, state: tauri::State<'_, QuitState>) {
    let actions = guard(&state.machine).window_done(window.label());
    apply_quit_actions(&app, actions);
}

// The last window is done (or its orchestrator bailed under its own timeout);
// approve so the app.exit(0) re-enters ExitRequested with approved=true.
#[tauri::command]
fn quit_proceed(app: AppHandle, state: tauri::State<'_, QuitState>) {
    let actions = guard(&state.machine).proceed();
    apply_quit_actions(&app, actions);
}

// ── Per-window close (docs/specs/standalone.md §Per-window close) ─────────────

// This window's close orchestrator is alive; stand its ack watchdog down.
#[tauri::command]
fn window_close_ack(window: tauri::Window, state: tauri::State<'_, QuitState>) {
    guard(&state.close).ack(window.label());
}

// The user declined the close, or its archive gate refused it. The window stays
// exactly as it was.
#[tauri::command]
fn window_close_cancel(window: tauri::Window, state: tauri::State<'_, QuitState>) {
    guard(&state.close).clear(window.label());
}

// This window is done with itself: its close orchestrator archived, removed the
// snapshot and killed its PTYs, or its last Workspace moved away and there was
// nothing to end at all. Rust's half is the same either way; what separates the
// two is what the webview did first, so the intent lives at the call sites
// (standalone/src/window-close.ts, standalone/src/workspace-move.ts).
#[tauri::command(async)]
fn close_window(app: AppHandle, window: tauri::Window) {
    finish_window_close(&app, window.label());
}

// Normal app quit should let the Node sidecar run its shutdown handler first:
// that handler closes headed agent-browser pop-out windows before killing PTYs.
// If the sidecar is wedged, fall back to the same hard kill path so quit remains
// bounded.
fn shutdown_sidecar_and_wait(state: &SidecarState) {
    const POLL_INTERVAL: Duration = Duration::from_millis(20);
    const MAX_POLLS: u32 = 125;

    append_log("[sidecar] requesting graceful shutdown");
    send_to_sidecar(
        state,
        serde_json::json!({ "event": "sidecar:shutdown", "data": {} }).to_string(),
    );

    let Ok(mut guard) = state.child.lock() else {
        return;
    };
    for _ in 0..MAX_POLLS {
        match guard.try_wait() {
            Ok(Some(status)) => {
                append_log(format!(
                    "[sidecar] confirmed graceful exit (status: {status})"
                ));
                return;
            }
            Ok(None) => std::thread::sleep(POLL_INTERVAL),
            Err(err) => {
                append_log(format!(
                    "[sidecar] wait error during graceful shutdown: {err}"
                ));
                return;
            }
        }
    }

    append_log("[sidecar] graceful shutdown timed out (~2.5s); killing");
    let _ = guard.start_kill();
}

// Job Object on Windows / process group on Unix — kill propagates to the
// sidecar's grandchildren (the spawned shells). On Unix this is SIGKILL to
// the whole process group, which is more thorough than the previous
// SIGTERM-to-just-node path that left node-pty grandchildren orphaned.
//
// The updater calls this before launching the Windows NSIS installer: NSIS
// overwrites files inside the bundled sidecar (e.g. node-pty's `conpty.node`),
// and Windows refuses to overwrite a native module the live sidecar still has
// loaded — surfacing as "Error opening file for writing". Releasing those
// handles first requires the node process to be gone, not merely signalled.
//
// We poll `try_wait` rather than block on `wait()`: `try_wait` is idempotent
// and can't hang, whereas the job-object `wait()` consumes a completion-port
// message the reaper thread may already have drained (e.g. if the sidecar had
// crashed earlier), which would block forever. The ~5s cap means a wedged
// sidecar can't stall quit indefinitely.
fn kill_sidecar_and_wait(child: &SharedChild) {
    // Poll for exit at this cadence, up to ~5s total (MAX_POLLS × POLL_INTERVAL).
    const POLL_INTERVAL: Duration = Duration::from_millis(20);
    const MAX_POLLS: u32 = 250;

    let Ok(mut guard) = child.lock() else { return };
    append_log(format!(
        "[sidecar] killing and waiting for exit (pid={})",
        guard.id()
    ));
    let _ = guard.start_kill();
    for _ in 0..MAX_POLLS {
        match guard.try_wait() {
            Ok(Some(status)) => {
                append_log(format!("[sidecar] confirmed exit during kill (status: {status})"));
                return;
            }
            Ok(None) => std::thread::sleep(POLL_INTERVAL),
            Err(err) => {
                append_log(format!("[sidecar] wait error during kill: {err}"));
                return;
            }
        }
    }
    append_log("[sidecar] kill wait timed out (~5s); proceeding anyway");
}

#[derive(Serialize, Deserialize, Clone)]
struct ShellInfo {
    name: String,
    path: String,
    #[serde(default)]
    args: Vec<String>,
}

#[tauri::command(async)]
fn get_available_shells(state: tauri::State<'_, SidecarState>) -> Result<Vec<ShellInfo>, String> {
    let response = request_from_sidecar_timeout(&state, "pty:getShells", serde_json::json!({}), Duration::from_secs(10))?;
    let shells: Vec<ShellInfo> = response
        .get("shells")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    Ok(shells)
}

fn resolve_sidecar_path(resource_dir: Option<PathBuf>, manifest_dir: &Path) -> PathBuf {
    if let Some(ref dir) = resource_dir {
        // Tauri maps `../sidecar` to `_up_/sidecar` when bundling resources
        for prefix in &["sidecar", "_up_/sidecar"] {
            let path = dir.join(prefix).join("main.js");
            if path.is_file() {
                // resource_dir() hands back a `\\?\` verbatim path in the
                // bundled/dev layout. Normalize once here, at the boundary, so
                // every consumer (the node script arg, the dor-cli paths derived
                // from this path's parent) gets a plain path. cmd.exe can't
                // execute a batch file via a verbatim path; Rust's APIs accept
                // both, so stripping is always safe.
                return strip_windows_verbatim_prefix(&path.to_string_lossy()).unwrap_or(path);
            }
        }
    }

    manifest_dir.join("..").join("sidecar").join("main.js")
}

fn strip_windows_verbatim_prefix(path_string: &str) -> Option<PathBuf> {
    if let Some(stripped) = path_string.strip_prefix(r"\\?\UNC\") {
        return Some(PathBuf::from(format!(r"\\{stripped}")));
    }
    if let Some(stripped) = path_string.strip_prefix(r"\\?\") {
        return Some(PathBuf::from(stripped));
    }

    None
}

fn resolve_node_binary_path() -> Result<PathBuf, String> {
    let exe = env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current_exe has no parent".to_string())?;
    find_node_binary(dir, env!("TAURI_ENV_TARGET_TRIPLE"))
        .ok_or_else(|| format!("node sidecar not found in {}", dir.display()))
}

// tauri-bundler sometimes strips the target-triple suffix (e.g. install dir
// has `node.exe`, dev/bundle has `node-x86_64-pc-windows-msvc.exe`).
fn find_node_binary(dir: &Path, target_triple: &str) -> Option<PathBuf> {
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let candidates = [
        dir.join(format!("node-{target_triple}{suffix}")),
        dir.join(format!("node{suffix}")),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

// The node the `dor` CLI runs under. On Windows the bundled node.exe is patched
// to the GUI subsystem at build time (build.rs `force_windows_gui_subsystem`) so
// spawning the sidecar from our GUI process doesn't trigger Win11's DefTerm
// handoff and flash a stray terminal window. A GUI-subsystem node, however, does
// not attach to an *inherited* console: when `dor` runs inside a shell's ConPTY
// its stdout/stderr are console handles (not STARTUPINFO pipes), so every byte it
// prints is silently dropped and commands appear to produce no output. `dor`
// already runs inside a pseudo-console and can never cause a stray window, so it
// needs a console-subsystem node. Derive one by copying the bundled node and
// flipping the PE subsystem byte back to console; cache it in app data. The
// sidecar itself keeps running under the GUI node.
#[cfg(windows)]
fn resolve_dor_node_path(gui_node: &Path, app: &AppHandle) -> PathBuf {
    match ensure_console_subsystem_node(gui_node, app) {
        Ok(path) => path,
        Err(err) => {
            append_log(format!(
                "[dor] console-subsystem node derivation failed ({err}); dor output may be lost"
            ));
            gui_node.to_path_buf()
        }
    }
}

#[cfg(not(windows))]
fn resolve_dor_node_path(gui_node: &Path, _app: &AppHandle) -> PathBuf {
    gui_node.to_path_buf()
}

#[cfg(windows)]
fn ensure_console_subsystem_node(gui_node: &Path, app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    create_dir_all(&dir).map_err(|e| format!("create cache dir: {e}"))?;
    let dest = dir.join("dor-node.exe");
    let src_len = std::fs::metadata(gui_node)
        .map_err(|e| format!("stat bundled node: {e}"))?
        .len();
    // Reuse the cached copy only when it matches the current bundled node's size
    // and is already console-subsystem; re-derive when missing or stale (e.g. an
    // app update swapped the bundled node). read_subsystem seeks to the field
    // rather than reading the whole ~80MB binary on every launch.
    if let Ok(meta) = std::fs::metadata(&dest) {
        if meta.len() == src_len
            && pe_subsystem::read_subsystem(&dest).ok() == Some(pe_subsystem::CONSOLE)
        {
            return Ok(dest);
        }
    }
    // Copy the bundled node with its subsystem flipped back to console. Writing a
    // fresh file (rather than fs::copy + re-patch) reads the source only once and
    // sidesteps fs::copy propagating the source's read-only attribute.
    let mut bytes = std::fs::read(gui_node).map_err(|e| format!("read bundled node: {e}"))?;
    pe_subsystem::set_subsystem(&mut bytes, pe_subsystem::CONSOLE)?;
    std::fs::write(&dest, &bytes).map_err(|e| format!("write dor node: {e}"))?;
    Ok(dest)
}

fn dor_control_token() -> String {
    // Must be unguessable: it is the shared secret both ends of the private `dor`
    // control channel prove knowledge of (never sent on the wire — see
    // standalone/sidecar/dor-control-server.js). A PID+timestamp value is locally
    // discoverable (`ps`) and bounded by the app's launch window, so draw 24 bytes
    // from the OS CSPRNG and hex-encode them — matching the VS Code host's
    // randomBytes(24).toString('hex') in pty-manager.ts. Aborting on CSPRNG failure
    // is deliberate: never fall back to a weak token.
    //
    // The socket path is not set here: the sidecar picks it (hardened per-user
    // directory on POSIX, unguessable pipe name on Windows) and exports
    // DORMOUSE_CONTROL_SOCKET into spawned shells itself, only once it is bound.
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).expect("OS CSPRNG unavailable for dor control token");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn dor_cli_paths_from_root(root: PathBuf) -> DorCliPaths {
    DorCliPaths {
        bin_dir: root.join("bin"),
        entrypoint: root.join("dist").join("dor.js"),
    }
}

fn resolve_dor_cli_paths(sidecar_path: &Path, manifest_dir: &Path) -> DorCliPaths {
    if let Some(sidecar_dir) = sidecar_path.parent() {
        let bundled = dor_cli_paths_from_root(sidecar_dir.join("dor-cli"));
        if bundled.entrypoint.is_file() {
            return bundled;
        }
    }

    let staged = dor_cli_paths_from_root(manifest_dir.join("..").join("sidecar").join("dor-cli"));
    if staged.entrypoint.is_file() {
        return staged;
    }

    dor_cli_paths_from_root(manifest_dir.join("..").join("..").join("dor"))
}

// Where the sidecar's Burrow persists its enrollment (a bearer credential)
// and its ACL, as one 0600 file it writes itself
// (lib/src/host/remote/burrow-state-store.ts). Created here so a first launch
// hands the sidecar a directory that exists; if it can't be made, the sidecar is
// told nothing and runs without persistence rather than not at all.
fn burrow_state_dir(app: &AppHandle) -> Option<String> {
    let dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            append_log(format!("[sidecar] app_data_dir unavailable: {e}"));
            return None;
        }
    };
    if let Err(e) = create_dir_all(&dir) {
        append_log(format!("[sidecar] create state dir: {e}"));
        return None;
    }
    // The Node sidecar writes the Burrow enrollment here, and that record carries
    // `burrowToken` — a bearer credential for `/ws/burrow`. `FileBurrowStateStore`
    // asks for `0700`/`0600`, which Windows ignores entirely, so on Windows this
    // is the only thing that restricts it: lock the directory here, before the
    // sidecar is spawned, and everything it writes inside inherits the single
    // owner-only entry — while an enrollment file a prior version already left
    // there is tightened by propagation instead, which is the leg
    // `restrict_to_owner_leaves_one_owner_only_ace` covers with `before.json`.
    // On unix the store's own modes already do the job and this is a harmless
    // re-assert of the same intent.
    if let Err(e) = restrict_to_owner(&dir, 0o700) {
        // Not fatal — a Burrow that cannot start is worse than one whose state
        // directory kept the OS default — but never silent: on Windows this
        // call is the only thing restricting `burrowToken`, so its failure is a
        // downgrade of the sole control and has to be visible.
        append_log(format!(
            "[sidecar] WARNING could not restrict state dir {}: {e}",
            dir.display()
        ));
    }
    Some(dir.to_string_lossy().into_owned())
}

/// Where the sidecar writes the single-use agent-recovery record. Under the
/// state root, so a dev run never consumes the installed app's. Created here so
/// a first launch hands the sidecar a directory that exists; owner-only for the
/// same reason the Burrow's is — the record holds command lines the user typed,
/// and a unix mode is a silent no-op on Windows.
fn recovery_state_dir(app: &AppHandle) -> Option<String> {
    let dir = match state_root(app) {
        Ok(dir) => dir,
        Err(e) => {
            append_log(format!("[recovery] state root unavailable: {e}"));
            return None;
        }
    };
    if let Err(e) = create_dir_all(&dir) {
        append_log(format!("[recovery] create state dir: {e}"));
        return None;
    }
    if let Err(e) = restrict_to_owner(&dir, 0o700) {
        append_log(format!(
            "[recovery] WARNING could not restrict state dir {}: {e}",
            dir.display()
        ));
    }
    Some(dir.to_string_lossy().into_owned())
}

fn start_sidecar(app: &AppHandle) -> Result<SidecarState, String> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let sidecar_path = resolve_sidecar_path(app.path().resource_dir().ok(), manifest_dir);
    let node_path = resolve_node_binary_path()?;
    let dor_cli_paths = resolve_dor_cli_paths(&sidecar_path, manifest_dir);
    let dor_node_path = resolve_dor_node_path(&node_path, app);
    let dor_control_token = dor_control_token();
    let state_dir = burrow_state_dir(app);
    let recovery_dir = recovery_state_dir(app);
    append_log(format!(
        "[sidecar] resolved script: {}",
        sidecar_path.display()
    ));
    append_log(format!("[sidecar] node binary: {}", node_path.display()));
    append_log(format!("[dor] node binary: {}", dor_node_path.display()));
    append_log(format!(
        "[dor] CLI bin dir: {}",
        dor_cli_paths.bin_dir.display()
    ));
    append_log(format!(
        "[dor] CLI entrypoint: {}",
        dor_cli_paths.entrypoint.display()
    ));
    append_log(format!(
        "[burrow] state dir: {}",
        state_dir.as_deref().unwrap_or("(none)")
    ));
    append_log(format!(
        "[recovery] state dir: {}",
        recovery_dir.as_deref().unwrap_or("(none)")
    ));

    let mut wrap = CommandWrap::with_new(&node_path, |c| {
        c.arg(&sidecar_path)
            .env("DORMOUSE_HOST", "standalone")
            .env("DORMOUSE_NODE", &dor_node_path)
            .env("DORMOUSE_CLI_BIN", &dor_cli_paths.bin_dir)
            .env("DORMOUSE_CLI_JS", &dor_cli_paths.entrypoint)
            .env("DORMOUSE_CONTROL_TOKEN", &dor_control_token)
            .env("DORMOUSE_STATE_DIR", state_dir.as_deref().unwrap_or(""))
            .env(
                "DORMOUSE_RECOVERY_DIR",
                recovery_dir.as_deref().unwrap_or(""),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
    });
    #[cfg(windows)]
    {
        wrap.wrap(CreationFlags(CREATE_NO_WINDOW));
        wrap.wrap(JobObject);
    }
    #[cfg(unix)]
    {
        wrap.wrap(ProcessGroup::leader());
    }

    let mut child = wrap
        .spawn()
        .map_err(|err| format!("failed to start Node.js sidecar: {err}"))?;
    let child_pid = child.id();
    append_log(format!("[sidecar] spawned Node.js runtime (pid={child_pid})"));

    // We piped all three streams ourselves, so `take` should always succeed —
    // but if it doesn't, the child is already running and would otherwise
    // outlive this function. Reap it before bailing.
    let stdin = child.stdin().take();
    let stdout = child.stdout().take();
    let stderr = child.stderr().take();
    let (mut stdin, stdout, stderr) = match (stdin, stdout, stderr) {
        (Some(i), Some(o), Some(e)) => (i, o, e),
        _ => {
            let _ = child.start_kill();
            return Err("sidecar pipes missing after spawn".to_string());
        }
    };

    let handle = app.clone();
    let pending_requests: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
    let pending_requests_for_task = Arc::clone(&pending_requests);

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line_result in reader.lines() {
            let Ok(line) = line_result else {
                break;
            };
            let Ok(mut msg) = serde_json::from_str::<JsonValue>(&line) else {
                append_log(format!("[sidecar stdout] {}", line.trim_end()));
                continue;
            };
            let Some(event) = msg.get("event").and_then(|e| e.as_str()).map(String::from)
            else {
                append_log("[sidecar stdout] JSON line missing event");
                continue;
            };
            let data = msg
                .as_object_mut()
                .and_then(|m| m.remove("data"))
                .unwrap_or(JsonValue::Null);

            if let Some(request_id) = data
                .get("requestId")
                .and_then(|request_id| request_id.as_str())
            {
                if let Ok(mut pending) = pending_requests_for_task.lock() {
                    if let Some(response_tx) = pending.remove(request_id) {
                        let _ = response_tx.send(data.clone());
                        continue;
                    }
                }
            }

            // Every line goes through the ownership map: one sidecar serves
            // every window (§Windows).
            dispatch_sidecar_event(&handle, &event, data);
        }
    });

    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line_result in reader.lines() {
            let Ok(line) = line_result else {
                break;
            };
            let message = format!("[sidecar] {}", line.trim_end());
            eprintln!("{message}");
            append_log(message);
        }
    });

    let (tx, writer_rx) = mpsc::channel::<String>();

    std::thread::spawn(move || {
        while let Ok(line) = writer_rx.recv() {
            let payload = format!("{}\n", line);
            if stdin.write_all(payload.as_bytes()).is_err() {
                append_log("[sidecar] stdin write failed");
                break;
            }
        }
    });

    let child: SharedChild = Arc::new(Mutex::new(child));

    // Reaper: poll for exit so we log a real exit status and unblock any
    // pending `request_from_sidecar_timeout` callers immediately instead of
    // making them wait the full timeout when the sidecar has already died.
    let child_for_reaper = Arc::clone(&child);
    let pending_for_reaper = Arc::clone(&pending_requests);
    std::thread::spawn(move || {
        loop {
            let status = match child_for_reaper.lock() {
                Ok(mut guard) => guard.try_wait(),
                Err(_) => return,
            };
            match status {
                Ok(Some(status)) => {
                    append_log(format!("[sidecar] exited (status: {status})"));
                    if let Ok(mut pending) = pending_for_reaper.lock() {
                        pending.clear();
                    }
                    return;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(250)),
                Err(err) => {
                    append_log(format!("[sidecar] wait error: {err}"));
                    return;
                }
            }
        }
    });

    Ok(SidecarState {
        tx,
        pending_requests,
        next_request_id: AtomicU64::new(0),
        child,
    })
}

// ── App entry point ─────────────────────────────────────────────────────────

/// The app menu's Quit item, matched in `on_menu_event`. Only the macOS menu
/// carries one; nothing else can ever raise this id.
const QUIT_MENU_ITEM_ID: &str = "dormouse-quit";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Replace Tauri's default menu, which binds Cmd+V to a native Paste
        // action that fights with the webview's DOM keydown handler. The
        // terminal owns Cmd+C / Cmd+V / Cmd+X in JS (see `Wall.tsx`).
        .menu(|handle| {
            #[cfg(target_os = "macos")]
            let pkg = handle.package_info();
            #[cfg(target_os = "macos")]
            let about = AboutMetadata {
                name: Some(pkg.name.clone()),
                version: Some(pkg.version.to_string()),
                ..Default::default()
            };
            let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<_>>> = Vec::new();
            #[cfg(target_os = "macos")]
            items.push(Box::new(Submenu::with_items(
                handle,
                pkg.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(handle, None, Some(about))?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::services(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::hide(handle, None)?,
                    &PredefinedMenuItem::hide_others(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    // Never `PredefinedMenuItem::quit`: muda wires that straight
                    // to AppKit's `terminate:`, which ends the process without
                    // ever raising `ExitRequested`. A custom item routes the
                    // menu and its Cmd+Q through `request_quit` like every other
                    // trigger (docs/specs/standalone.md §Trigger interception).
                    &MenuItem::with_id(
                        handle,
                        QUIT_MENU_ITEM_ID,
                        "Quit Dormouse Terminal",
                        true,
                        Some("CmdOrCtrl+Q"),
                    )?,
                ],
            )?));
            items.push(Box::new(Submenu::with_items(
                handle,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(handle, None)?,
                    &PredefinedMenuItem::maximize(handle, None)?,
                    #[cfg(target_os = "macos")]
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::close_window(handle, None)?,
                ],
            )?));
            let refs: Vec<&dyn tauri::menu::IsMenuItem<_>> = items.iter().map(|b| b.as_ref()).collect();
            Menu::with_items(handle, &refs)
        })
        .on_menu_event(|app, event| {
            if event.id() == QUIT_MENU_ITEM_ID {
                request_quit(app);
            }
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match event {
                // Inert while tauri.conf.json sets dragDropEnabled=false (needed for HTML5 pane drag). See diffplug/dormouse#38 and tauri-apps/tauri#14373.
                WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                    let payload: Vec<String> = paths
                        .iter()
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect();
                    let _ = window.emit("dormouse://files-dropped", serde_json::json!({ "paths": payload }));
                }
                // Focus order is the drag hit test's z-order stand-in and the
                // fallback owner for a `dor` request naming no Surface.
                WindowEvent::Focused(true) => {
                    if let Some(state) = app.try_state::<WindowState>() {
                        state.touch_focus(window.label());
                    }
                }
                // The payload is the new box, so nothing is asked of the
                // platform here (§Boot and geometry).
                WindowEvent::Moved(position) => {
                    note_geometry(app, window.label(), Some((position.x, position.y)), None);
                }
                WindowEvent::Resized(size) => {
                    note_geometry(app, window.label(), None, Some((size.width, size.height)));
                }
                // The close button: this window alone unless it is the last one,
                // which is the whole-app quit (§Per-window close). Gated on the
                // quit walk so a teardown's own destroy cannot re-enter it.
                WindowEvent::CloseRequested { api, .. } => {
                    // The flow's own destroys do not come through here, so an
                    // approved or walking quit meeting a close request means the
                    // user pressed the button mid-teardown: refuse it, or the
                    // window goes away from under its own teardown and the walk
                    // waits out its budget on a dead label.
                    if quit_approved(app) {
                        return;
                    }
                    api.prevent_close();
                    if quit_walking(app) {
                        return;
                    }
                    if app.webview_windows().len() > 1 {
                        request_window_close(app, window.label());
                    } else {
                        request_quit(app);
                    }
                }
                // The window is gone. Everything keyed by its label is settled
                // here, and only here: this is the first moment Tauri has taken
                // it out of `webview_windows()`.
                WindowEvent::Destroyed => {
                    let label = window.label().to_string();
                    let cleanup_app = app.clone();
                    let cleanup_label = label.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let app = &cleanup_app;
                        let label = cleanup_label;
                        if let Some(state) = app.try_state::<WindowState>() {
                            // Shells it still owned belong to nobody now, and
                            // unowned output routes nowhere.
                            let (lost, orphaned) = state.drop_window(&label);
                            // The webview is gone, so no save can arrive under this
                            // label again and the refusal can go with it.
                            guard(&state.closing).remove(&label);
                            reap_orphaned_ptys(app, &label, orphaned);
                            // A Workspace on its way here can never arrive: its
                            // source still shows it, still holds its Sessions, and
                            // has released nothing (§Arrival queue).
                            for arrival in lost {
                                hand_back_arrival(
                                    app,
                                    &state,
                                    &arrival,
                                    "the target window closed mid-arrival",
                                );
                            }
                            let changed = workspaces::forget_window(&mut guard(&state.registry), &label);
                            if changed {
                                broadcast_registry(app, &state);
                            }
                        }
                    });
                    if let Some(state) = app.try_state::<GeometryState>() {
                        state.forget(&label);
                    }
                    if let Some(state) = app.try_state::<QuitState>() {
                        guard(&state.close).clear(&label);
                        // A window that left outside the flow can never vote or
                        // finish, so the quit advances past it rather than
                        // waiting out its budget. Bound before the call: the
                        // guard would otherwise still be held inside
                        // `apply_quit_actions`, which takes the same lock.
                        let actions = {
                            let mut machine = guard(&state.machine);
                            if machine.approved {
                                // Already exiting: these destroys are the exit's
                                // own, and nothing is left to advance.
                                Vec::new()
                            } else {
                                machine.forget_window(&label)
                            }
                        };
                        apply_quit_actions(app, actions);
                    }
                    // The Burrow's ask collector settles on having heard from
                    // every live window, so it must learn about this one only
                    // now that asking it would be impossible.
                    send_window_labels(app);
                }
                _ => {}
            }
        })
        .setup(|app| {
            init_log();
            append_log("[app] setup started");

            // Managed before the sidecar starts: its stdout reader routes every
            // line through this map (§Windows).
            app.manage(WindowState::default());
            app.manage(GeometryState::default());

            let sidecar_state = start_sidecar(app.handle()).map_err(|err| {
                append_log(format!("[sidecar] {err}"));
                std::io::Error::new(std::io::ErrorKind::Other, err)
            })?;
            app.manage(sidecar_state);
            append_log("[app] sidecar state registered");

            // Quit-interception state (docs/specs/standalone.md §Quit flow).
            app.manage(QuitState::default());

            // A crash between a snapshot's temp write and its rename leaves a
            // file nothing will ever read or overwrite; one written before
            // Dormouse stopped storing transcripts carries one
            // (docs/specs/standalone.md §Persistence). Never fatal.
            match sessions_dir(app.handle()) {
                Ok(dir) => {
                    if let Err(e) = sweep_orphan_session_temps(&dir) {
                        append_log(format!("[session] {e}"));
                    }
                }
                Err(e) => append_log(format!("[session] {e}")),
            }

            // Serializes this process's notepad-archive access (§Notepad
            // archive); the revision itself is read off the stored bytes and
            // the cross-process exclusion is a lock file, so there is no
            // starting state to seed here.
            app.manage(NotepadArchiveState::default());

            // On non-macOS, remove native decorations for a fully custom title bar.
            // macOS uses titleBarStyle "Overlay" from config instead, which preserves
            // rounded corners and native traffic-light buttons.
            #[cfg(not(target_os = "macos"))]
            {
                if let Some(window) = app.get_webview_window(routing::MAIN_LABEL) {
                    let _ = window.set_decorations(false);
                }
            }

            // Reopen every window the last run left behind (§Windows). `main` is
            // already up from the config; the rest are cloned from it.
            match sessions_dir(app.handle()) {
                Ok(dir) => {
                    // First: a Workspace in flight at the last exit is in no
                    // snapshot until this puts it in its target's, and a
                    // tear-out target's file must exist before the enumeration
                    // below (§Arrival queue).
                    if let Err(e) = restore_arrivals(&dir) {
                        append_log(format!("[window] {e}"));
                    }
                    let labels = routing::restorable_labels(session_file_names(&dir));
                    // Above every SAVED label too, not just the live ones: a
                    // torn-out window must never claim a snapshot still on disk.
                    app.state::<WindowState>()
                        .next_ws
                        .store(routing::seed_next_ws(&labels), Ordering::SeqCst);
                    // Likewise above every Workspace id any snapshot names, so
                    // a fresh id never collides with one about to be restored.
                    app.state::<WindowState>()
                        .next_workspace
                        .store(workspaces::seed_next(saved_workspace_ids(&dir)), Ordering::SeqCst);
                    restore_windows(app.handle(), &dir, &labels);
                }
                Err(e) => append_log(format!("[window] {e}")),
            }
            if let Some(state) = app.try_state::<WindowState>() {
                state.touch_focus(routing::MAIN_LABEL);
            }
            // `main` came up from the config, so nothing has seeded its cached
            // box; the drag hit test reads that cache (§Boot and geometry).
            seed_geometry(app.handle(), routing::MAIN_LABEL);
            // The Burrow fans an ask out to every window and collects N answers.
            send_window_labels(app.handle());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_theme_colors,
            pty_kill,
            pty_get_cwd,
            pty_get_cwds,
            pty_context,
            pty_get_open_ports,
            pty_get_open_ports_many,
            pty_graceful_kill,
            capture_agent_recovery,
            take_recovery_commands,
            iframe_create_proxy_url,
            pty_request_init,
            dor_control_response,
            burrow_command,
            alert_command,
            kill_sidecar_now,
            quit_ack,
            quit_vote,
            quit_progress,
            quit_cancel,
            quit_window_done,
            quit_proceed,
            window_close_ack,
            window_close_cancel,
            close_window,
            open_workspace_window,
            transfer_workspace,
            adopt_ready,
            adopt_done,
            adopt_failed,
            take_arrivals,
            workspace_reserve_ids,
            workspace_report,
            workspace_registry,
            remove_window_session,
            window_at_cursor,
            hover_workspace_target,
            get_available_shells,
            read_clipboard_file_paths,
            read_clipboard_image_as_file_path,
            read_clipboard_text,
            read_update_log,
            load_session,
            save_session,
            load_notepad_archive,
            save_notepad_archive,
            reset_notepad_archive,
            agent_browser_command,
            agent_browser_edit,
            agent_browser_screenshot,
            agent_browser_stream_status,
            agent_browser_open,
            agent_browser_pop_out,
            agent_browser_pop_in,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Dormouse")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            RunEvent::Ready => {
                set_macos_dock_icon();
                // The delegate exists by now, which is what this splices onto.
                macos_terminate::install(app);
            }
            // Cmd+Q / app-menu / dock quit / interceptable OS logout (§Quit flow).
            // The flow's own app.exit(0) re-enters here with approved=true and
            // passes; `code` (None = user-initiated) is deliberately ignored.
            RunEvent::ExitRequested { api, .. } => {
                if !quit_approved(app) {
                    api.prevent_exit();
                    request_quit(app);
                }
            }
            // Harmless after teardown: the PTY map is already empty, so the
            // sidecar killAll no-ops. Still the backstop for any unclean exit.
            RunEvent::Exit => {
                if let Some(state) = app.try_state::<SidecarState>() {
                    append_log("[app] exit — shutting down sidecar");
                    shutdown_sidecar_and_wait(&state);
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{
        arrivals_path, find_node_binary, forget_arrival_on_disk, notepad_archive_lock_path,
        open_ports_many_timeout, read_arrivals_from, read_notepad_archive_from,
        read_session_from, record_arrival_on_disk, reset_notepad_archive_at,
        resolve_dor_cli_paths, resolve_sidecar_path, restore_arrivals, session_file_name,
        session_file_names, state_root_from, strip_windows_verbatim_prefix,
        sweep_orphan_session_temps, temp_write_path, write_notepad_archive_to,
        write_session_to, JsonValue, NOTEPAD_ARCHIVE_FILE, OPEN_PORT_TIMEOUT_MS,
        OPEN_PORT_TIMEOUT_PER_ID_MS, OPEN_PORT_ROUND_TRIP_MARGIN_MS, SESSION_TEMP_SUFFIX,
    };
    use super::routing;
    use super::guard;
    use std::collections::HashSet;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::Ordering;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A Window-wide port listing is budgeted for its batch: both of the
    /// sidecar's serial scans, plus the per-id allowance the socket scan gets.
    #[test]
    fn open_ports_many_timeout_scales_with_the_batch() {
        let one = open_ports_many_timeout(1).as_millis() as u64;
        let twenty = open_ports_many_timeout(20).as_millis() as u64;
        assert_eq!(one, 2 * OPEN_PORT_TIMEOUT_MS + OPEN_PORT_TIMEOUT_PER_ID_MS + OPEN_PORT_ROUND_TRIP_MARGIN_MS);
        assert_eq!(twenty - one, 19 * OPEN_PORT_TIMEOUT_PER_ID_MS);
    }

    // RAII guard so a failing assert doesn't leak the temp dir.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!("dormouse-{name}-{suffix}"));
            fs::create_dir_all(&path).expect("failed to create temp dir");
            TempDir(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // --- Pending arrivals on disk (§Arrival queue) ---------------------------

    fn workspace_json(id: &str, name: &str) -> JsonValue {
        serde_json::json!({ "id": id, "name": name, "session": { "version": 3, "panes": [] } })
    }

    fn arrival_of(id: &str, from: &str, to: &str) -> routing::Arrival {
        routing::Arrival {
            workspace_id: id.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            terminal_ids: Vec::new(),
            payload: serde_json::json!({ "workspaceId": id, "workspace": workspace_json(id, "Moved") }),
            queued_at: std::time::Instant::now(),
        }
    }

    fn snapshot_json(entries: &[(&str, &str)], active: &str) -> String {
        let workspaces: Vec<JsonValue> =
            entries.iter().map(|(id, name)| workspace_json(id, name)).collect();
        serde_json::json!({ "version": 1, "workspaces": workspaces, "activeWorkspaceId": active })
            .to_string()
    }

    fn read_snapshot(dir: &Path, label: &str) -> Option<JsonValue> {
        read_session_from(dir, label)
            .unwrap()
            .map(|contents| serde_json::from_str(&contents).unwrap())
    }

    fn snapshot_ids(snapshot: &JsonValue) -> Vec<String> {
        super::workspaces::snapshot_ids(snapshot)
    }

    #[test]
    fn an_arrival_record_round_trips_until_it_is_forgotten() {
        let dir = TempDir::new("arrivals-round-trip");
        // Nothing in flight is no file at all, and forgetting is then a no-op.
        assert!(read_arrivals_from(dir.path()).unwrap().is_empty());
        forget_arrival_on_disk(dir.path(), "workspace-7").unwrap();
        assert!(!arrivals_path(dir.path()).exists());

        record_arrival_on_disk(dir.path(), &arrival_of("workspace-7", "main", "ws-2")).unwrap();
        record_arrival_on_disk(dir.path(), &arrival_of("workspace-8", "main", "ws-3")).unwrap();
        // Recording the same id again replaces rather than duplicates.
        record_arrival_on_disk(dir.path(), &arrival_of("workspace-7", "main", "ws-2")).unwrap();
        let records = read_arrivals_from(dir.path()).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[1]["workspaceId"], "workspace-7");
        assert_eq!(records[1]["from"], "main");
        assert_eq!(records[1]["to"], "ws-2");
        assert_eq!(records[1]["workspace"]["name"], "Moved");
        // Neither window's snapshot was touched.
        assert!(read_session_from(dir.path(), "main").unwrap().is_none());
        assert!(read_session_from(dir.path(), "ws-2").unwrap().is_none());
        // The file is never a window the boot enumeration would reopen.
        assert_eq!(
            routing::restorable_labels(session_file_names(dir.path())),
            Vec::<String>::new()
        );

        forget_arrival_on_disk(dir.path(), "workspace-7").unwrap();
        let records = read_arrivals_from(dir.path()).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["workspaceId"], "workspace-8");
        // Forgetting the last record removes the file.
        forget_arrival_on_disk(dir.path(), "workspace-8").unwrap();
        assert!(!arrivals_path(dir.path()).exists());
    }

    #[test]
    fn a_leftover_arrival_boots_into_an_existing_target_snapshot() {
        let dir = TempDir::new("arrivals-existing-target");
        write_session_to(
            dir.path(),
            "main",
            &snapshot_json(&[("workspace-2", "A"), ("workspace-7", "Stale")], "workspace-2"),
        )
        .unwrap();
        record_arrival_on_disk(dir.path(), &arrival_of("workspace-7", "ws-3", "main")).unwrap();

        restore_arrivals(dir.path()).unwrap();

        // Appended, or here replaced by id: the target keeps what it had and
        // its own active Workspace.
        let main = read_snapshot(dir.path(), "main").unwrap();
        assert_eq!(snapshot_ids(&main), vec!["workspace-2", "workspace-7"]);
        assert_eq!(main["activeWorkspaceId"], "workspace-2");
        assert_eq!(main["workspaces"][1]["name"], "Moved");
        // A source that never had a snapshot gets none.
        assert!(read_session_from(dir.path(), "ws-3").unwrap().is_none());
    }

    #[test]
    fn a_leftover_arrival_boots_into_a_tear_out_targets_new_snapshot() {
        let dir = TempDir::new("arrivals-tear-out-target");
        record_arrival_on_disk(dir.path(), &arrival_of("workspace-7", "main", "ws-2")).unwrap();
        assert!(read_session_from(dir.path(), "ws-2").unwrap().is_none());

        restore_arrivals(dir.path()).unwrap();

        let ws2 = read_snapshot(dir.path(), "ws-2").unwrap();
        assert_eq!(snapshot_ids(&ws2), vec!["workspace-7"]);
        assert_eq!(ws2["activeWorkspaceId"], "workspace-7");
        assert_eq!(ws2["version"], 1);
        // The window the merge created is one the boot enumeration reopens.
        assert_eq!(routing::restorable_labels(session_file_names(dir.path())), vec!["ws-2"]);
    }

    #[test]
    fn a_leftover_arrival_leaves_a_source_snapshot_that_still_names_it() {
        let dir = TempDir::new("arrivals-source");
        // The source crashed before its own flush omitted the Workspace.
        write_session_to(
            dir.path(),
            "ws-3",
            &snapshot_json(&[("workspace-7", "Docs"), ("workspace-8", "Keep")], "workspace-7"),
        )
        .unwrap();
        // A source whose only Workspace left is a closed window.
        write_session_to(dir.path(), "ws-4", &snapshot_json(&[("workspace-9", "Only")], "workspace-9"))
            .unwrap();
        record_arrival_on_disk(dir.path(), &arrival_of("workspace-7", "ws-3", "main")).unwrap();
        record_arrival_on_disk(dir.path(), &arrival_of("workspace-9", "ws-4", "main")).unwrap();

        restore_arrivals(dir.path()).unwrap();

        let ws3 = read_snapshot(dir.path(), "ws-3").unwrap();
        assert_eq!(snapshot_ids(&ws3), vec!["workspace-8"]);
        assert!(read_session_from(dir.path(), "ws-4").unwrap().is_none());
        let main = read_snapshot(dir.path(), "main").unwrap();
        assert_eq!(snapshot_ids(&main), vec!["workspace-7", "workspace-9"]);
        // Each id is now in exactly one snapshot.
        assert_eq!(
            routing::restorable_labels(session_file_names(dir.path())),
            vec!["main", "ws-3"]
        );
    }

    #[test]
    fn adoption_keeps_the_journal_until_both_snapshots_are_durable() {
        let dir = TempDir::new("arrival-commit");
        write_session_to(dir.path(), "main", &snapshot_json(&[("workspace-7", "Moved")], "workspace-7")).unwrap();
        record_arrival_on_disk(dir.path(), &arrival_of("workspace-7", "main", "ws-2")).unwrap();
        super::mark_arrival_adopted_on_disk(dir.path(), "workspace-7").unwrap();
        assert_eq!(read_arrivals_from(dir.path()).unwrap().len(), 1);
        write_session_to(dir.path(), "ws-2", &snapshot_json(&[("workspace-7", "Moved")], "workspace-7")).unwrap();
        super::retire_saved_arrivals(dir.path()).unwrap();
        assert_eq!(read_arrivals_from(dir.path()).unwrap().len(), 1);
        write_session_to(dir.path(), "main", &snapshot_json(&[], "workspace-1")).unwrap();
        super::retire_saved_arrivals(dir.path()).unwrap();
        assert!(!arrivals_path(dir.path()).exists());
    }

    #[test]
    fn a_hand_back_is_recovered_in_the_source_before_its_next_flush() {
        let dir = TempDir::new("arrival-handback");
        let arrival = arrival_of("workspace-7", "main", "ws-2");
        record_arrival_on_disk(dir.path(), &arrival).unwrap();
        super::return_arrival_on_disk(dir.path(), &arrival).unwrap();
        assert_eq!(read_arrivals_from(dir.path()).unwrap()[0]["to"], "main");
        restore_arrivals(dir.path()).unwrap();
        assert_eq!(snapshot_ids(&read_snapshot(dir.path(), "main").unwrap()), vec!["workspace-7"]);
        assert!(read_session_from(dir.path(), "ws-2").unwrap().is_none());
    }

    #[test]
    fn closing_an_adopted_target_never_resurrects_either_copy() {
        let dir = TempDir::new("arrival-target-close");
        write_session_to(dir.path(), "main", &snapshot_json(&[("workspace-7", "Stale"), ("workspace-8", "Keep")], "workspace-8")).unwrap();
        record_arrival_on_disk(dir.path(), &arrival_of("workspace-7", "main", "ws-2")).unwrap();
        super::mark_arrival_adopted_on_disk(dir.path(), "workspace-7").unwrap();
        super::close_window_snapshot(dir.path(), "ws-2").unwrap();
        restore_arrivals(dir.path()).unwrap();
        assert!(read_session_from(dir.path(), "ws-2").unwrap().is_none());
        assert_eq!(snapshot_ids(&read_snapshot(dir.path(), "main").unwrap()), vec!["workspace-8"]);
        assert!(!arrivals_path(dir.path()).exists());
    }

    #[test]
    fn journal_commands_run_off_the_main_thread() {
        let source = include_str!("lib.rs").split("#[cfg(test)]").next().unwrap();
        for command in ["transfer_workspace", "open_workspace_window", "adopt_done", "adopt_failed", "close_window"] {
            assert!(source.contains(&format!("#[tauri::command(async)]\nfn {command}(")), "{command} must run off the UI thread");
        }
    }

    #[test]
    fn a_settled_recovery_preserves_the_targets_newer_snapshot() {
        let dir = TempDir::new("arrival-newer-target");
        record_arrival_on_disk(dir.path(), &arrival_of("workspace-7", "main", "ws-2")).unwrap();
        super::mark_arrival_adopted_on_disk(dir.path(), "workspace-7").unwrap();
        write_session_to(dir.path(), "ws-2", &snapshot_json(&[("workspace-7", "Renamed after adoption")], "workspace-7")).unwrap();
        restore_arrivals(dir.path()).unwrap();
        assert_eq!(read_snapshot(dir.path(), "ws-2").unwrap()["workspaces"][0]["name"], "Renamed after adoption");
    }

    #[test]
    fn a_failed_source_write_rolls_back_the_target_and_retries() {
        let dir = TempDir::new("arrival-source-write");
        write_session_to(dir.path(), "main", &snapshot_json(&[("workspace-7", "Moved"), ("workspace-8", "Keep")], "workspace-8")).unwrap();
        let before = snapshot_json(&[("workspace-9", "Target")], "workspace-9");
        write_session_to(dir.path(), "ws-2", &before).unwrap();
        record_arrival_on_disk(dir.path(), &arrival_of("workspace-7", "main", "ws-2")).unwrap();
        let blocked = temp_write_path(&dir.path().join(session_file_name("main")));
        fs::create_dir(&blocked).unwrap();
        restore_arrivals(dir.path()).unwrap();
        assert_eq!(read_snapshot(dir.path(), "ws-2").unwrap(), serde_json::from_str::<serde_json::Value>(&before).unwrap());
        assert_eq!(read_arrivals_from(dir.path()).unwrap().len(), 1);
        fs::remove_dir(blocked).unwrap();
        restore_arrivals(dir.path()).unwrap();
        assert!(!arrivals_path(dir.path()).exists());
        assert_eq!(snapshot_ids(&read_snapshot(dir.path(), "main").unwrap()), vec!["workspace-8"]);
    }

    #[test]
    fn an_unreadable_source_retains_the_record_without_changing_the_target() {
        let dir = TempDir::new("arrival-retry");
        record_arrival_on_disk(dir.path(), &arrival_of("workspace-7", "main", "ws-2")).unwrap();
        write_session_to(dir.path(), "main", "broken json").unwrap();
        restore_arrivals(dir.path()).unwrap();
        assert!(read_session_from(dir.path(), "ws-2").unwrap().is_none());
        assert_eq!(read_arrivals_from(dir.path()).unwrap().len(), 1);
        write_session_to(dir.path(), "main", &snapshot_json(&[("workspace-7", "Moved")], "workspace-7")).unwrap();
        restore_arrivals(dir.path()).unwrap();
        assert!(!arrivals_path(dir.path()).exists());
        assert_eq!(snapshot_ids(&read_snapshot(dir.path(), "ws-2").unwrap()), vec!["workspace-7"]);
    }

    #[test]
    fn the_arrivals_file_is_gone_after_the_boot_merge() {
        let dir = TempDir::new("arrivals-gone");
        record_arrival_on_disk(dir.path(), &arrival_of("workspace-7", "main", "ws-2")).unwrap();
        assert!(arrivals_path(dir.path()).exists());

        restore_arrivals(dir.path()).unwrap();
        assert!(!arrivals_path(dir.path()).exists());
        // Idempotent: a second boot has nothing to merge and changes nothing.
        restore_arrivals(dir.path()).unwrap();
        assert_eq!(snapshot_ids(&read_snapshot(dir.path(), "ws-2").unwrap()), vec!["workspace-7"]);

        // An unreadable file is dropped rather than replayed on every launch.
        fs::write(arrivals_path(dir.path()), "{not json").unwrap();
        assert!(restore_arrivals(dir.path()).is_err());
        assert!(!arrivals_path(dir.path()).exists());
    }

    /// The Windows half of `restrict_to_owner`: after it runs, the DACL must be
    /// protected from inheritance and grant exactly one principal — this user.
    ///
    /// Worth a test rather than prose because the failure is silent and
    /// invisible: a unix `mode` is a no-op on Windows, so before this existed
    /// the session snapshots simply kept whatever `%LOCALAPPDATA%` handed down
    /// — never owner-only — and nothing about the app would look different.
    #[test]
    #[cfg(windows)]
    fn restrict_to_owner_leaves_one_owner_only_ace() {
        use windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL};
        use windows::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
        use windows::Win32::Security::{
            EqualSid, GetAclInformation, GetSecurityDescriptorControl, AclSizeInformation, ACL,
            ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
            SE_DACL_PROTECTED,
        };
        use windows::core::PCWSTR;
        use std::os::windows::ffi::OsStrExt;

        let dir = TempDir::new("acl");
        let target = dir.path().join("sessions");
        fs::create_dir_all(&target).expect("failed to create target dir");

        // A file created BEFORE the lock, to prove the entry propagates down.
        fs::write(target.join("before.json"), b"{}").expect("failed to write");

        super::restrict_to_owner(&target, 0o700).expect("restrict_to_owner failed");

        let wide: Vec<u16> = target
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        unsafe {
            let mut dacl: *mut ACL = std::ptr::null_mut();
            let mut sd = PSECURITY_DESCRIPTOR::default();
            let rc = GetNamedSecurityInfoW(
                PCWSTR(wide.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut dacl),
                None,
                &mut sd,
            );
            assert_eq!(rc, ERROR_SUCCESS, "GetNamedSecurityInfoW failed");
            assert!(!dacl.is_null(), "no DACL on the locked directory");

            // Inheritance must be broken, or the parent's entries survive
            // alongside ours and nothing has actually been revoked.
            let mut control: u16 = 0;
            let mut revision = 0u32;
            GetSecurityDescriptorControl(sd, &mut control, &mut revision)
                .expect("GetSecurityDescriptorControl failed");
            assert!(
                control & SE_DACL_PROTECTED.0 != 0,
                "DACL is not protected from inheritance"
            );

            let mut info = ACL_SIZE_INFORMATION::default();
            GetAclInformation(
                dacl,
                std::ptr::addr_of_mut!(info).cast(),
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
            .expect("GetAclInformation failed");
            assert_eq!(
                info.AceCount, 1,
                "expected exactly one ACE, found {}",
                info.AceCount
            );

            // And that one entry must be *us*, not merely a single stranger.
            let mut ace: *mut std::ffi::c_void = std::ptr::null_mut();
            windows::Win32::Security::GetAce(dacl, 0, &mut ace).expect("GetAce failed");
            // ACCESS_ALLOWED_ACE: 4-byte header, 4-byte mask, then the SID.
            let sid_in_ace = PSID((ace as *mut u8).add(8).cast());

            let mut token = windows::Win32::Foundation::HANDLE::default();
            windows::Win32::System::Threading::OpenProcessToken(
                windows::Win32::System::Threading::GetCurrentProcess(),
                windows::Win32::Security::TOKEN_QUERY,
                &mut token,
            )
            .expect("OpenProcessToken failed");
            let mut needed = 0u32;
            let _ = windows::Win32::Security::GetTokenInformation(
                token,
                windows::Win32::Security::TokenUser,
                None,
                0,
                &mut needed,
            );
            let mut buf = vec![0u8; needed as usize];
            windows::Win32::Security::GetTokenInformation(
                token,
                windows::Win32::Security::TokenUser,
                Some(buf.as_mut_ptr().cast()),
                needed,
                &mut needed,
            )
            .expect("GetTokenInformation failed");
            let _ = windows::Win32::Foundation::CloseHandle(token);
            let me = (*(buf.as_ptr() as *const windows::Win32::Security::TOKEN_USER))
                .User
                .Sid;
            assert!(
                EqualSid(sid_in_ace, me).is_ok(),
                "the single ACE is not the current user"
            );

            // And it reached what was already inside. This is not decoration:
            // on an upgrade burrow.json already exists under the inherited
            // ACL holding a live burrowToken, so propagation to existing children
            // is the only thing that tightens that file.
            let child: Vec<u16> = target
                .join("before.json")
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let mut child_dacl: *mut ACL = std::ptr::null_mut();
            let mut child_sd = PSECURITY_DESCRIPTOR::default();
            assert_eq!(
                GetNamedSecurityInfoW(
                    PCWSTR(child.as_ptr()),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    None,
                    None,
                    Some(&mut child_dacl),
                    None,
                    &mut child_sd,
                ),
                ERROR_SUCCESS,
                "GetNamedSecurityInfoW failed on the pre-existing child"
            );
            let mut child_info = ACL_SIZE_INFORMATION::default();
            GetAclInformation(
                child_dacl,
                std::ptr::addr_of_mut!(child_info).cast(),
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
            .expect("GetAclInformation failed on the pre-existing child");
            assert_eq!(
                child_info.AceCount, 1,
                "the pre-existing child kept {} ACEs -- the entry did not propagate",
                child_info.AceCount
            );

            let _ = LocalFree(Some(HLOCAL(child_sd.0)));
            let _ = LocalFree(Some(HLOCAL(sd.0)));
        }
    }

    #[test]
    #[cfg(windows)]
    fn pe_subsystem_round_trips() {
        use super::pe_subsystem::{read_subsystem, set_subsystem, CONSOLE, GUI};
        let dir = TempDir::new("pe-subsystem");
        let path = dir.path().join("fake.exe");
        // Minimal PE: MZ magic, e_lfanew -> 0x80, "PE\0\0" signature, and a
        // Subsystem field 0x5C past the PE signature starting as console.
        let mut bytes = vec![0u8; 256];
        bytes[0] = b'M';
        bytes[1] = b'Z';
        let pe_offset: u32 = 0x80;
        bytes[0x3C..0x40].copy_from_slice(&pe_offset.to_le_bytes());
        let po = pe_offset as usize;
        bytes[po..po + 4].copy_from_slice(b"PE\0\0");
        bytes[po + 0x5C..po + 0x5C + 2].copy_from_slice(&CONSOLE.to_le_bytes());
        fs::write(&path, &bytes).expect("write fake pe");

        // read_subsystem seeks in the file; set_subsystem patches the image.
        assert_eq!(read_subsystem(&path).unwrap(), CONSOLE);
        set_subsystem(&mut bytes, GUI).unwrap(); // build.rs flips console -> GUI
        fs::write(&path, &bytes).unwrap();
        assert_eq!(read_subsystem(&path).unwrap(), GUI);
        set_subsystem(&mut bytes, CONSOLE).unwrap(); // dor derive flips it back
        fs::write(&path, &bytes).unwrap();
        assert_eq!(read_subsystem(&path).unwrap(), CONSOLE);
    }

    #[test]
    fn prefers_packaged_sidecar_when_resource_exists() {
        let resource_dir = TempDir::new("resource");
        let sidecar_dir = resource_dir.path().join("sidecar");
        let sidecar_path = sidecar_dir.join("main.js");

        fs::create_dir_all(&sidecar_dir).expect("failed to create sidecar dir");
        fs::write(&sidecar_path, "console.log('packaged');").expect("failed to create sidecar");

        let resolved = resolve_sidecar_path(
            Some(resource_dir.path().to_path_buf()),
            Path::new("/repo/standalone/src-tauri"),
        );

        assert_eq!(resolved, sidecar_path);
    }

    #[test]
    fn finds_sidecar_under_up_prefix() {
        let resource_dir = TempDir::new("resource-up");
        let sidecar_dir = resource_dir.path().join("_up_").join("sidecar");
        let sidecar_path = sidecar_dir.join("main.js");

        fs::create_dir_all(&sidecar_dir).expect("failed to create sidecar dir");
        fs::write(&sidecar_path, "console.log('packaged');").expect("failed to create sidecar");

        let resolved = resolve_sidecar_path(
            Some(resource_dir.path().to_path_buf()),
            Path::new("/repo/standalone/src-tauri"),
        );

        assert_eq!(resolved, sidecar_path);
    }

    #[test]
    fn falls_back_to_repo_sidecar_when_resource_is_missing() {
        let manifest_dir = Path::new("/repo/standalone/src-tauri");

        let resolved = resolve_sidecar_path(None, manifest_dir);

        assert_eq!(
            resolved,
            manifest_dir.join("..").join("sidecar").join("main.js")
        );
    }

    #[test]
    fn strips_windows_verbatim_prefix_for_node_main_script() {
        let path = strip_windows_verbatim_prefix(
            r"\\?\C:\Users\EdgarTwigg\AppData\Local\Dormouse\_up_\sidecar\main.js",
        )
        .expect("expected verbatim path to be stripped");

        assert_eq!(
            path,
            PathBuf::from(r"C:\Users\EdgarTwigg\AppData\Local\Dormouse\_up_\sidecar\main.js")
        );
    }

    #[test]
    fn strips_windows_verbatim_unc_prefix_for_node_main_script() {
        let path = strip_windows_verbatim_prefix(r"\\?\UNC\server\share\Dormouse\sidecar\main.js")
            .expect("expected verbatim UNC path to be stripped");

        assert_eq!(
            path,
            PathBuf::from(r"\\server\share\Dormouse\sidecar\main.js")
        );
    }

    #[test]
    fn finds_node_binary_with_triple_suffix() {
        let dir = TempDir::new("node-triple");
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let triple = "x86_64-pc-windows-msvc";
        let expected = dir.path().join(format!("node-{triple}{suffix}"));
        fs::write(&expected, b"fake").expect("failed to write fake binary");

        let resolved = find_node_binary(dir.path(), triple).expect("should resolve");
        assert_eq!(resolved, expected);
    }

    #[test]
    fn finds_node_binary_falls_back_to_stripped_name() {
        let dir = TempDir::new("node-stripped");
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let expected = dir.path().join(format!("node{suffix}"));
        fs::write(&expected, b"fake").expect("failed to write fake binary");

        let resolved =
            find_node_binary(dir.path(), "x86_64-pc-windows-msvc").expect("should resolve");
        assert_eq!(resolved, expected);
    }

    #[test]
    fn returns_none_when_no_node_binary_present() {
        let dir = TempDir::new("node-missing");

        assert!(find_node_binary(dir.path(), "x86_64-pc-windows-msvc").is_none());
    }

    #[test]
    fn resolves_staged_dor_cli_next_to_sidecar() {
        let resource_dir = TempDir::new("dor-cli-resource");
        let sidecar_dir = resource_dir.path().join("sidecar");
        let sidecar_path = sidecar_dir.join("main.js");
        let dor_root = sidecar_dir.join("dor-cli");
        let dor_entrypoint = dor_root.join("dist").join("dor.js");

        fs::create_dir_all(dor_entrypoint.parent().unwrap()).expect("failed to create dor dist");
        fs::create_dir_all(dor_root.join("bin")).expect("failed to create dor bin");
        fs::write(&sidecar_path, "console.log('sidecar');").expect("failed to create sidecar");
        fs::write(&dor_entrypoint, "console.log('dor');").expect("failed to create dor entrypoint");

        let resolved =
            resolve_dor_cli_paths(&sidecar_path, Path::new("/repo/standalone/src-tauri"));

        assert_eq!(resolved.bin_dir, dor_root.join("bin"));
        assert_eq!(resolved.entrypoint, dor_entrypoint);
    }

    #[test]
    fn resolves_repo_dor_cli_when_staged_copy_is_missing() {
        let sidecar_dir = TempDir::new("dor-cli-missing");
        let sidecar_path = sidecar_dir.path().join("main.js");
        let manifest_dir = Path::new("/repo/standalone/src-tauri");

        fs::write(&sidecar_path, "console.log('sidecar');").expect("failed to create sidecar");

        let resolved = resolve_dor_cli_paths(&sidecar_path, manifest_dir);

        let dor_root = manifest_dir.join("..").join("..").join("dor");
        assert_eq!(resolved.bin_dir, dor_root.join("bin"));
        assert_eq!(resolved.entrypoint, dor_root.join("dist").join("dor.js"));
    }

    // resource_dir() hands us a `\\?\` verbatim path on Windows. resolve_sidecar_path
    // is the single normalization boundary: it must strip the prefix so every
    // downstream consumer (the node script arg, and the dor-cli paths derived from
    // this path's parent) gets a plain path — otherwise cmd.exe can't launch
    // `dor.cmd` reached through DORMOUSE_CLI_BIN on PATH.
    #[test]
    #[cfg(windows)]
    fn resolve_sidecar_path_strips_verbatim_prefix() {
        let resource_dir = TempDir::new("sidecar-verbatim");
        let sidecar_path = resource_dir.path().join("sidecar").join("main.js");
        fs::create_dir_all(sidecar_path.parent().unwrap()).expect("failed to create sidecar dir");
        fs::write(&sidecar_path, "console.log('sidecar');").expect("failed to create sidecar");

        // A verbatim resource dir to the same real tree; is_file() still resolves it.
        let verbatim_resource = PathBuf::from(format!(r"\\?\{}", resource_dir.path().display()));
        let resolved =
            resolve_sidecar_path(Some(verbatim_resource), Path::new("/repo/standalone/src-tauri"));

        assert_eq!(resolved, sidecar_path);
        assert!(!resolved.to_string_lossy().contains(r"\\?\"));
    }

    #[test]
    fn session_missing_reads_none() {
        let dir = TempDir::new("sessions-missing");
        // No file yet — a fresh install / new window reads as None, not an error.
        assert_eq!(read_session_from(dir.path(), "main").unwrap(), None);
    }

    #[test]
    fn session_round_trips_and_isolates_windows() {
        let dir = TempDir::new("sessions-roundtrip");
        write_session_to(dir.path(), "main", r#"{"v":1,"who":"main"}"#).unwrap();
        assert_eq!(
            read_session_from(dir.path(), "main").unwrap().as_deref(),
            Some(r#"{"v":1,"who":"main"}"#),
        );

        // A second window persists to its own file and never touches the first's.
        write_session_to(dir.path(), "win-2", r#"{"v":1,"who":"win-2"}"#).unwrap();
        assert_eq!(
            read_session_from(dir.path(), "main").unwrap().as_deref(),
            Some(r#"{"v":1,"who":"main"}"#),
        );
        assert_eq!(
            read_session_from(dir.path(), "win-2").unwrap().as_deref(),
            Some(r#"{"v":1,"who":"win-2"}"#),
        );

        // Overwrite is atomic-replace, not append: the latest blob fully wins.
        write_session_to(dir.path(), "main", r#"{"v":2}"#).unwrap();
        assert_eq!(
            read_session_from(dir.path(), "main").unwrap().as_deref(),
            Some(r#"{"v":2}"#),
        );
    }

    #[test]
    fn session_permission_failures_preserve_previous_snapshot_without_writing_bytes() {
        for fail_mode in [0o700, 0o600] {
            let dir = TempDir::new("sessions-permission-failure");
            write_session_to(dir.path(), "main", "previous").unwrap();
            let result = super::write_file_with_permissions(
                &dir.path().join(session_file_name("main")),
                "private replacement",
                |path, mode| {
                    if mode == fail_mode {
                        Err("permission denied".to_owned())
                    } else {
                        super::restrict_to_owner(path, mode)
                    }
                },
            );
            assert_eq!(result.unwrap_err(), "permission denied");
            assert_eq!(
                read_session_from(dir.path(), "main").unwrap().as_deref(),
                Some("previous")
            );
            // The writer cleans up after itself, so a returned error never
            // leaves the boot sweep anything to find.
            assert!(!dir.path().join("main.json.tmp").exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn session_write_tightens_directory_and_existing_temp_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("sessions-permissions");
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        let tmp = dir.path().join("main.json.tmp");
        fs::write(&tmp, "legacy").unwrap();
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o644)).unwrap();
        write_session_to(dir.path(), "main", "private").unwrap();
        assert_eq!(
            fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(dir.path().join("main.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        // The geometry sibling rides the same writer, so it is owner-only too
        // (docs/specs/security-local.md -> "Persisted state").
        super::write_file_atomically(
            &super::geometry_path(dir.path(), "main"),
            r#"{"x":0.0,"y":0.0,"width":1.0,"height":1.0}"#,
        )
        .unwrap();
        assert_eq!(
            fs::metadata(super::geometry_path(dir.path(), "main"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    /// A per-window close is deliberate: everything the window left on disk
    /// goes, so the next launch does not reopen it
    /// (docs/specs/standalone.md -> "Per-window close").
    #[test]
    fn removing_a_window_session_takes_its_temp_and_geometry_with_it() {
        let dir = TempDir::new("sessions-remove");
        write_session_to(dir.path(), "ws-2", r#"{"v":1}"#).unwrap();
        write_session_to(dir.path(), "main", r#"{"v":1}"#).unwrap();
        fs::write(dir.path().join("ws-2.json.tmp"), b"orphan").unwrap();
        fs::write(super::geometry_path(dir.path(), "ws-2"), b"{}").unwrap();

        super::remove_session_from(dir.path(), "ws-2").unwrap();

        assert!(!dir.path().join("ws-2.json").exists());
        assert!(!dir.path().join("ws-2.json.tmp").exists());
        assert!(!super::geometry_path(dir.path(), "ws-2").exists());
        // Never a sibling window's.
        assert!(dir.path().join("main.json").exists());
        // Removing what is already gone is the desired end state, not an error.
        super::remove_session_from(dir.path(), "ws-2").unwrap();
    }

    /// The geometry sibling must not read back as a window: a boot that opened
    /// `ws-2.geometry` would fight the real `ws-2` for its snapshot.
    #[test]
    fn the_geometry_sibling_is_not_a_restorable_window() {
        let dir = TempDir::new("sessions-enumerate");
        write_session_to(dir.path(), "main", r#"{"v":1}"#).unwrap();
        write_session_to(dir.path(), "ws-2", r#"{"v":1}"#).unwrap();
        super::write_file_atomically(&super::geometry_path(dir.path(), "ws-2"), "{}").unwrap();
        let mut names = super::session_file_names(dir.path());
        names.sort();
        assert_eq!(
            super::routing::restorable_labels(&names),
            vec!["main".to_string(), "ws-2".to_string()]
        );
    }

    /// The cached box is fed by the window events alone, and it is what both the
    /// debounced write and the cross-window drag read (§Boot and geometry).
    #[test]
    fn the_geometry_cache_folds_window_events_and_drives_the_hit_test() {
        let mut rect = super::CachedRect {
            origin: (0, 0),
            size: (800, 600),
            scale: 2.0,
        };
        // A `Moved` carries only the origin, a `Resized` only the size.
        rect.apply(Some((100, 40)), None);
        rect.apply(None, Some((1000, 700)));
        assert_eq!(rect.origin, (100, 40));
        assert_eq!(rect.size, (1000, 700));

        // Stored logical, so the box reopens sensibly on another display.
        let geometry = rect.to_logical();
        assert_eq!(
            (geometry.x, geometry.y, geometry.width, geometry.height),
            (50.0, 20.0, 500.0, 350.0)
        );

        // The same cached rect is the hit test's input: a point inside the box
        // it moved to hits, and the client-space answer is relative to it.
        let hit = super::routing::window_at(
            &[rect.hit_rect("ws-2", true)],
            &["ws-2".to_string()],
            (300.0, 240.0),
        )
        .expect("the moved window is under the cursor");
        assert_eq!((hit.label.as_str(), hit.x, hit.y), ("ws-2", 100.0, 100.0));
        // Outside the box it moved to, and inside the one it left.
        assert_eq!(
            super::routing::window_at(&[rect.hit_rect("ws-2", true)], &[], (10.0, 10.0)),
            None
        );
    }

    /// The debounce thread's own bookkeeping. The dirty set and the flush slot
    /// move together, so a `Moved` arriving as the thread drains either rides
    /// the drain it is racing or schedules the next one — never neither, which
    /// is how a window's final position used to go unwritten.
    #[test]
    fn the_geometry_flush_slot_is_released_with_the_drain() {
        let state = super::GeometryState::default();
        // The first move owes a debounce thread; the ones behind it ride that
        // same thread rather than spawning one apiece.
        assert!(state.mark_dirty("main"));
        assert!(!state.mark_dirty("ws-2"));
        assert!(!state.mark_dirty("main"));

        let drained = state.take_dirty();
        assert_eq!(drained.len(), 2, "both windows are written: {drained:?}");
        assert!(drained.contains("main") && drained.contains("ws-2"));

        // Slot released: a later move owes a fresh thread. Taken apart from the
        // drain, this is the write that carries a window's last position.
        assert!(state.mark_dirty("ws-2"));
        assert_eq!(
            state.take_dirty(),
            HashSet::from(["ws-2".to_string()]),
            "only what was marked since the last drain"
        );
        // Draining nothing is not an error, and still leaves the slot free.
        assert!(state.take_dirty().is_empty());
        assert!(state.mark_dirty("main"));
    }

    /// The cached box is refreshed from a scale the caller has already read.
    /// The signature is the rule: nothing can ask the platform anything while
    /// the `rects` lock is held (`GeometryState`).
    #[test]
    fn refreshing_a_cached_rect_takes_the_scale_rather_than_the_window() {
        let state = super::GeometryState::default();
        guard(&state.rects).insert(
            "ws-2".to_string(),
            super::CachedRect {
                origin: (100, 40),
                size: (800, 600),
                scale: 1.0,
            },
        );
        // A window dragged onto a display with a different scale factor.
        let rect = state.refresh_rect("ws-2", Some(2.0)).expect("cached");
        assert_eq!(rect.scale, 2.0);
        assert_eq!(rect.to_logical().width, 400.0);
        // A platform that would not answer leaves the last known scale.
        assert_eq!(state.refresh_rect("ws-2", None).unwrap().scale, 2.0);
        // A window whose `Destroyed` beat the flush has no box to write.
        assert!(state.refresh_rect("gone", Some(2.0)).is_none());
        state.forget("ws-2");
        assert!(state.refresh_rect("ws-2", Some(2.0)).is_none());
    }

    /// A deliberate close removes the snapshot, so every later save under that
    /// label is refused — including one already in flight from the webview that
    /// is going away (docs/specs/standalone.md -> "Per-window close"). Both close
    /// paths set it: the webview's own `remove_window_session`, and
    /// `finish_window_close` for the ack-timeout path where it never ran.
    #[test]
    fn a_closing_window_refuses_every_later_save_until_it_is_destroyed() {
        let state = super::WindowState::default();
        assert!(!state.refuses_save("ws-2"));
        state.begin_closing("ws-2");
        assert!(state.refuses_save("ws-2"));
        // Never a sibling's.
        assert!(!state.refuses_save("main"));
        // `Destroyed` drops the refusal: no save can arrive under a dead label.
        guard(&state.closing).remove("ws-2");
        assert!(!state.refuses_save("ws-2"));
    }

    /// A spawn reusing a transferring id must not inherit its suppression: no
    /// replay is coming for the new PTY, so it would paint nothing until the
    /// fail-open sweep (`routing::AWAITING_REPLAY_MAX`).
    #[test]
    fn minting_a_pty_clears_a_stale_transfer_suppression() {
        let state = super::WindowState::default();
        state.reassign(&["pane-a".to_string()], "ws-2", true);
        assert_eq!(state.suppressed.load(Ordering::Relaxed), 1);

        super::routing::hold_event(
            &mut guard(&state.routing).held,
            "pane-a",
            "terminal:protocolEvents",
            serde_json::json!({"n": 1}),
        );

        state.mint("pane-a", "main");
        assert!(guard(&state.routing).awaiting_replay.is_empty());
        // Nothing held for the PTY that never arrived survives under its id.
        assert!(guard(&state.routing).held.is_empty());
        assert_eq!(state.suppressed.load(Ordering::Relaxed), 0);
        assert_eq!(state.owned_by("main"), vec!["pane-a".to_string()]);
    }

    /// Every way out of a suppression takes the held queue with it: a queue
    /// left behind would be flushed ahead of the *next* transfer's own gap.
    #[test]
    fn every_lift_of_a_suppression_takes_its_held_queue() {
        let state = super::WindowState::default();
        let ids = ["pane-a".to_string()];
        let queue_up = || {
            state.reassign(&ids, "ws-2", true);
            super::routing::hold_event(
                &mut guard(&state.routing).held,
                "pane-a",
                "terminal:protocolEvents",
                serde_json::json!({"n": 1}),
            );
            assert_eq!(state.suppressed.load(Ordering::Relaxed), 1);
        };
        let lifted = || {
            let routing = guard(&state.routing);
            routing.awaiting_replay.is_empty() && routing.held.is_empty()
        };

        queue_up();
        state.clear_suppression(&ids);
        assert!(lifted());
        assert_eq!(state.suppressed.load(Ordering::Relaxed), 0);

        queue_up();
        state.reassign(&ids, "main", false);
        assert!(lifted());

        queue_up();
        state.forget_pty("pane-a");
        assert!(lifted());
    }

    #[test]
    fn sweep_orphan_session_temps_removes_only_temps() {
        let dir = TempDir::new("sessions-sweep");
        write_session_to(dir.path(), "main", r#"{"v":1,"who":"main"}"#).unwrap();
        write_session_to(dir.path(), "win-2", r#"{"v":1,"who":"win-2"}"#).unwrap();
        // What a crash between the temp write and the rename leaves behind. A
        // pre-persistence one carries a transcript, and the point of the sweep is
        // that those bytes leave the disk.
        fs::write(dir.path().join("main.json.tmp"), b"legacy transcript").unwrap();
        fs::write(dir.path().join("win-2.json.tmp"), b"legacy transcript").unwrap();
        // Not ours: a sibling store's file must survive untouched.
        fs::write(dir.path().join("notes.txt"), b"keep me").unwrap();

        sweep_orphan_session_temps(dir.path()).unwrap();

        assert!(!dir.path().join("main.json.tmp").exists());
        assert!(!dir.path().join("win-2.json.tmp").exists());
        // Every live snapshot is left exactly as it was — the window that owns
        // one rewrites it itself.
        assert_eq!(
            read_session_from(dir.path(), "main").unwrap().as_deref(),
            Some(r#"{"v":1,"who":"main"}"#),
        );
        assert_eq!(
            read_session_from(dir.path(), "win-2").unwrap().as_deref(),
            Some(r#"{"v":1,"who":"win-2"}"#),
        );
        assert!(dir.path().join("notes.txt").exists());
    }

    #[test]
    fn sweeping_an_absent_sessions_directory_succeeds() {
        // A first launch has no sessions directory yet; that is the desired end
        // state, not an error.
        let dir = TempDir::new("sessions-sweep-missing");
        assert!(sweep_orphan_session_temps(&dir.path().join("nope")).is_ok());
    }

    /// The sweep's constant against the name the writer actually leaves, so the
    /// two can never drift.
    #[test]
    fn session_temp_suffix_matches_what_the_writer_leaves() {
        assert_eq!(
            temp_write_path(Path::new(&session_file_name("main")))
                .file_name()
                .unwrap()
                .to_str()
                .unwrap(),
            format!("main{SESSION_TEMP_SUFFIX}"),
        );
    }

    /// A dev build and the installed app share one `app_data_dir()`, so this
    /// split is what keeps a `pnpm dev:standalone` run from restoring the
    /// installed app's Workspaces and clobbering its snapshot.
    #[test]
    fn dev_and_installed_state_roots_are_separate() {
        let app_data = PathBuf::from("/app-data");
        let root = state_root_from(app_data.clone());
        if cfg!(debug_assertions) {
            assert_eq!(root, app_data.join("dev"));
        } else {
            assert_eq!(root, app_data);
        }
        // The notepad archive is a sibling of app_data, never under the root, so
        // dev and the installed app keep sharing it.
        assert_ne!(root.join("sessions"), app_data.join(NOTEPAD_ARCHIVE_FILE));
    }

    #[test]
    fn session_label_cannot_escape_directory() {
        // A hostile label is flattened to a plain filename inside the dir.
        assert_eq!(session_file_name("../../evil"), "______evil.json");
        assert_eq!(session_file_name("main"), "main.json");
        assert_eq!(session_file_name("a/b"), "a_b.json");
    }

    // ── Notepad archive (docs/specs/notepad.md) ─────────────────────────────
    //
    // A compare-and-swap store, so what is worth pinning is the pair the webview
    // leans on: a save lands only on the revision it read, and no failure path —
    // a stale save, a crash mid-write, a recovery from an unreadable file — may
    // cost the user notes.

    struct Archive {
        dir: PathBuf,
        // `None` for a second process over a directory the first one owns: only
        // the owner's drop may remove it.
        _owned: Option<TempDir>,
        // The process-local gate — so two of these over one directory are two
        // Dormouse processes, sharing only what is on disk.
        gate: Mutex<()>,
    }

    impl Archive {
        fn new(name: &str) -> Self {
            let dir = TempDir::new(name);
            Archive {
                dir: dir.path().to_path_buf(),
                _owned: Some(dir),
                gate: Mutex::new(()),
            }
        }
        /// A second Dormouse over the same `app_data_dir()` — two launches of the
        /// installed app, or two `pnpm dev:standalone` runs in one worktree.
        fn second_process(&self) -> Self {
            Archive {
                dir: self.dir.clone(),
                _owned: None,
                gate: Mutex::new(()),
            }
        }
        fn dir(&self) -> &Path {
            &self.dir
        }
        fn path(&self) -> PathBuf {
            self.dir.join(NOTEPAD_ARCHIVE_FILE)
        }
        fn load(&self) -> Option<(String, String)> {
            read_notepad_archive_from(&self.path(), &self.gate).unwrap()
        }
        /// The bytes alone, for a test asserting only what is stored.
        fn bytes(&self) -> Option<String> {
            self.load().map(|(bytes, _)| bytes)
        }
        /// The token a save must quote. Opaque: the tests assert only that it
        /// moves with the bytes, never its shape.
        fn revision(&self) -> Option<String> {
            self.load().map(|(_, revision)| revision)
        }
        fn save(&self, state: &str, base: Option<&str>) -> String {
            write_notepad_archive_to(&self.path(), &self.gate, state, base).unwrap()
        }
        fn reset(&self) {
            reset_notepad_archive_at(&self.path(), &self.gate).unwrap()
        }
        /// Every file in the archive directory bar the lock, sorted — so a test
        /// can assert what was left behind as well as what was written. The lock
        /// exists from the first operation onward and is nothing these
        /// assertions are about; `notepad_archive_is_owner_only_on_disk` is what
        /// pins it.
        fn entries(&self) -> Vec<String> {
            let lock = notepad_archive_lock_path(&self.path());
            let lock = lock.file_name().unwrap().to_string_lossy().into_owned();
            let mut names: Vec<String> = fs::read_dir(self.dir())
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|name| *name != lock)
                .collect();
            names.sort();
            names
        }
    }

    #[test]
    fn notepad_archive_round_trips_and_moves_its_revision() {
        let archive = Archive::new("notepad-roundtrip");

        // Nothing archived yet: the load reports absence, and the first save
        // names a null base revision.
        assert_eq!(archive.load(), None);
        assert_eq!(archive.save(r#"{"version":1,"batches":[]}"#, None), "ok");

        let (bytes, first) = archive.load().expect("archived");
        assert_eq!(bytes, r#"{"version":1,"batches":[]}"#);
        // Re-reading unchanged bytes reproduces the token — the property a
        // retry-after-conflict leans on.
        assert_eq!(archive.revision().as_deref(), Some(first.as_str()));

        // Each accepted save moves it, so the next one must quote what it read.
        assert_eq!(
            archive.save(r#"{"version":1,"batches":["b1"]}"#, Some(&first)),
            "ok",
        );
        let (bytes, second) = archive.load().expect("archived");
        assert_eq!(bytes, r#"{"version":1,"batches":["b1"]}"#);
        assert_ne!(second, first);

        // Atomic replace, not append — and the temp file it went through is gone.
        assert_eq!(archive.entries(), vec![NOTEPAD_ARCHIVE_FILE.to_string()]);
    }

    #[test]
    fn notepad_archive_refuses_a_save_against_a_stale_revision() {
        let archive = Archive::new("notepad-conflict");
        assert_eq!(archive.save(r#"{"version":1,"batches":["a"]}"#, None), "ok");
        let stale = archive.revision().expect("archived");
        assert_eq!(
            archive.save(r#"{"version":1,"batches":["b"]}"#, Some(&stale)),
            "ok",
        );

        // A second writer still holding the earlier token is refused rather than
        // silently overwriting the batches it never saw.
        assert_eq!(
            archive.save(r#"{"version":1,"batches":["c"]}"#, Some(&stale)),
            "conflict",
        );
        // So does a token nothing ever minted, and so does a first-save null
        // base once something is stored.
        assert_eq!(archive.save("{}", Some("not-a-revision")), "conflict");
        assert_eq!(archive.save("{}", None), "conflict");
        // …and no refusal touched the file.
        assert_eq!(
            archive.bytes().as_deref(),
            Some(r#"{"version":1,"batches":["b"]}"#),
        );
        assert_eq!(archive.entries(), vec![NOTEPAD_ARCHIVE_FILE.to_string()]);
    }

    /// The revision is a hash of the stored bytes, not a count of this process's
    /// own writes, so a write it never made is still seen.
    #[test]
    fn notepad_archive_conflicts_with_a_write_it_did_not_make() {
        let archive = Archive::new("notepad-foreign");
        assert_eq!(archive.save(r#"{"version":1,"batches":["a"]}"#, None), "ok");
        let base = archive.revision().expect("archived");

        // Straight at the file, as another process's rename leaves it.
        fs::write(archive.path(), r#"{"version":1,"batches":["a","yours"]}"#).unwrap();

        assert_eq!(
            archive.save(r#"{"version":1,"batches":["a","mine"]}"#, Some(&base)),
            "conflict",
        );
        // The refusal kept the bytes it found instead of overwriting them.
        assert_eq!(
            archive.bytes().as_deref(),
            Some(r#"{"version":1,"batches":["a","yours"]}"#),
        );
    }

    /// Two Dormouse processes share `app_data_dir()` — two launches of the
    /// installed app, or two dev runs in one worktree — so the loser of an
    /// overlapping load→save must retry rather than drop the winner's batches.
    #[test]
    fn notepad_archive_conflicts_across_two_processes() {
        let first = Archive::new("notepad-two-processes");
        let second = first.second_process();

        assert_eq!(first.save(r#"{"version":1,"batches":["a"]}"#, None), "ok");
        // Both load; the token is the file's, so both read the same one.
        let base_first = first.revision().expect("archived");
        let base_second = second.revision().expect("archived");
        assert_eq!(base_first, base_second);

        assert_eq!(
            first.save(
                r#"{"version":1,"batches":["a","first"]}"#,
                Some(&base_first)
            ),
            "ok",
        );
        // A process-local counter never observed that save; the hash does.
        assert_eq!(
            second.save(
                r#"{"version":1,"batches":["a","second"]}"#,
                Some(&base_second)
            ),
            "conflict",
        );

        // And the retry the conflict asks for lands, carrying both batches.
        let fresh = second.revision().expect("archived");
        assert_eq!(
            second.save(
                r#"{"version":1,"batches":["a","first","second"]}"#,
                Some(&fresh)
            ),
            "ok",
        );
        assert_eq!(
            first.bytes().as_deref(),
            Some(r#"{"version":1,"batches":["a","first","second"]}"#),
        );
    }

    #[test]
    fn notepad_archive_reset_renames_the_unreadable_file_rather_than_deleting_it() {
        let archive = Archive::new("notepad-reset");
        assert_eq!(archive.save("{ not json", None), "ok");
        // A crash before a rename could have left this; it was never a readable
        // archive, so it is the one thing reset may drop.
        let tmp = archive.dir().join("notepad-archive-v1.json.tmp");
        fs::write(&tmp, b"partial").unwrap();

        archive.reset();

        // The partial write is gone and the archive is not where it was — what
        // is left is one quarantined copy.
        assert!(!tmp.exists());
        let entries = archive.entries();
        assert_eq!(entries.len(), 1, "expected one quarantined copy: {entries:?}");
        let quarantined = &entries[0];
        assert!(
            quarantined.starts_with("notepad-archive-v1.unreadable-")
                && quarantined.ends_with(".json"),
            "unexpected quarantine name: {quarantined}",
        );
        // The user's bytes survive the recovery — that is the whole point.
        assert_eq!(
            fs::read_to_string(archive.dir().join(quarantined)).unwrap(),
            "{ not json",
        );

        // And the archive starts empty again: the next save is a first save,
        // naming a null base.
        assert_eq!(archive.load(), None);
        assert_eq!(archive.save(r#"{"version":1,"batches":[]}"#, None), "ok");
        assert_eq!(
            archive.bytes().as_deref(),
            Some(r#"{"version":1,"batches":[]}"#)
        );
    }

    #[test]
    fn notepad_archive_reset_without_a_file_succeeds() {
        // Nothing to move aside is the desired end state, not a failure.
        let archive = Archive::new("notepad-reset-missing");
        archive.reset();
        assert_eq!(archive.load(), None);
        assert!(archive.entries().is_empty());
    }

    /// The unix half of the guarantee `restrict_to_owner_leaves_one_owner_only_ace`
    /// pins on Windows: the archive carries captured terminal excerpts, so it and
    /// its directory are the owner's alone
    /// (docs/specs/security-local.md -> "Persisted state").
    #[test]
    #[cfg(unix)]
    fn notepad_archive_is_owner_only_on_disk() {
        use std::os::unix::fs::PermissionsExt;

        let archive = Archive::new("notepad-modes");
        assert_eq!(archive.save(r#"{"version":1,"batches":[]}"#, None), "ok");

        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(archive.dir()), 0o700);
        // 0600 survives because the temp file was tightened *before* the rename.
        assert_eq!(mode(&archive.path()), 0o600);
        // The lock carries no bytes, but it names the archive and sits beside it
        // in the same directory, so it is owner-only on the same terms.
        assert_eq!(mode(&notepad_archive_lock_path(&archive.path())), 0o600);
    }

    // Enforces the INVARIANT documented above `request_from_sidecar_timeout`:
    // every `#[tauri::command]` whose body reaches the blocking sidecar helpers
    // must be `#[tauri::command(async)]` (or an `async fn`). A plain-sync command
    // runs on the main thread, where `recv_timeout` freezes the webview for the
    // whole round trip — up to 10s on a clipboard image paste. Three clipboard
    // commands once slipped through the async port; this scans the source so the
    // omission can't silently recur.
    #[test]
    fn sidecar_commands_are_async() {
        let src = include_str!("lib.rs");
        let lines: Vec<&str> = src.lines().collect();
        let mut offenders: Vec<String> = Vec::new();

        for (i, line) in lines.iter().enumerate() {
            let trimmed = line.trim_start();
            if !trimmed.starts_with("#[tauri::command") {
                continue;
            }
            let is_async_attr = trimmed.contains("(async)");

            // Skip any further attribute lines / blanks down to the fn signature.
            let mut j = i + 1;
            while j < lines.len() {
                let t = lines[j].trim_start();
                if t.starts_with("#[") || t.is_empty() {
                    j += 1;
                } else {
                    break;
                }
            }
            if j >= lines.len() {
                continue;
            }
            let sig = lines[j].trim_start();
            let is_async_fn = sig.starts_with("async fn") || sig.starts_with("pub async fn");
            let name = sig
                .trim_start_matches("pub ")
                .trim_start_matches("async ")
                .trim_start_matches("fn ")
                .split('(')
                .next()
                .unwrap_or("<unknown>")
                .trim();

            // Extract the fn body by brace-counting from the signature onward.
            // This is a naive char count, not a lexer: a lone `{`/`}` inside a
            // string or char literal (e.g. `'{'`, or `"missing }"`) would throw
            // off the depth. It holds across the command bodies scanned here
            // because none of them contain such a literal; a future command that
            // did would need a real tokenizer. Good enough to enforce the
            // async-attribute invariant, not a general Rust brace matcher.
            let mut depth = 0i32;
            let mut started = false;
            let mut body = String::new();
            for l in &lines[j..] {
                for ch in l.chars() {
                    if ch == '{' {
                        depth += 1;
                        started = true;
                    } else if ch == '}' {
                        depth -= 1;
                    }
                }
                body.push_str(l);
                if started && depth == 0 {
                    break;
                }
            }

            // Match direct callers of the blocking helper *and* the
            // agent-browser commands, which reach it transitively through the
            // `agent_browser_forward` wrapper (their bodies never name
            // `request_from_sidecar` directly). That family carries the longest
            // timeout (AGENT_BROWSER_TIMEOUT = 30s), so it's the worst case to
            // let slip plain-sync.
            let reaches_sidecar =
                body.contains("request_from_sidecar") || body.contains("agent_browser_forward");
            if reaches_sidecar && !(is_async_attr || is_async_fn) {
                offenders.push(name.to_string());
            }
        }

        assert!(
            offenders.is_empty(),
            "these #[tauri::command] fns reach the blocking sidecar helpers but are \
             not declared #[tauri::command(async)] (see the INVARIANT above \
             request_from_sidecar_timeout): {offenders:?}",
        );
    }
}
