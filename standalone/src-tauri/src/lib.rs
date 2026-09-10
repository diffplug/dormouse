use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
mod log_tail;
mod quit_state;
mod routing;
use quit_state::{CloseMachine, QuitAction, QuitMachine};
use routing::{Route, RouteView};
use std::{
    collections::HashMap,
    env,
    fs::{create_dir_all, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    sync::mpsc,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, PredefinedMenuItem, Submenu},
    AppHandle, DragDropEvent, Emitter, Manager, RunEvent, WebviewWindowBuilder, WindowEvent,
};
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
#[derive(Default)]
struct WindowState {
    /// ptyId -> window label. Minted only in `pty_spawn`, dropped by
    /// `pty_kill`, an exit, or a window going away; reassigned by a transfer.
    owners: Mutex<HashMap<String, String>>,
    /// Ids whose output is suppressed until the replay their new owner is about
    /// to be sent has been emitted, each with the instant it began.
    awaiting_replay: Mutex<HashMap<String, Instant>>,
    /// Window labels, most recently focused first.
    focus_order: Mutex<Vec<String>>,
    /// A torn-out window's boot payload, pulled by `take_boot_payload`. Pulled,
    /// never pushed: an `emit_to` a window that does not exist yet is lost.
    pending_boot: Mutex<HashMap<String, JsonValue>>,
    /// The window currently showing a cross-window drop caret, so the previous
    /// one can be told to clear it.
    hover_target: Mutex<Option<String>>,
    /// Labels whose snapshot has been deliberately removed. A save arriving
    /// from a webview that is going away must not put the file back.
    closing: Mutex<std::collections::HashSet<String>>,
    /// The next `ws-<n>`, seeded above every live and saved label at setup.
    next_ws: AtomicU64,
}

impl WindowState {
    fn owned_by(&self, label: &str) -> Vec<String> {
        guard(&self.owners)
            .iter()
            .filter(|(_, owner)| owner.as_str() == label)
            .map(|(id, _)| id.clone())
            .collect()
    }

    fn mint(&self, id: &str, label: &str) {
        guard(&self.owners).insert(id.to_string(), label.to_string());
    }

    /// Hand `ids` to `label` and suppress their output until each one's replay
    /// has been emitted to it (docs/specs/standalone.md §Transfer).
    fn reassign(&self, ids: &[String], label: &str) {
        let mut owners = guard(&self.owners);
        let mut awaiting = guard(&self.awaiting_replay);
        let now = Instant::now();
        for id in ids {
            owners.insert(id.clone(), label.to_string());
            awaiting.insert(id.clone(), now);
        }
    }

    /// Forget a window: its ownership, its focus entry, and any boot payload it
    /// never pulled. Returns the ids it owned.
    fn drop_window(&self, label: &str) -> Vec<String> {
        let owned = self.owned_by(label);
        let mut owners = guard(&self.owners);
        for id in &owned {
            owners.remove(id);
        }
        drop(owners);
        guard(&self.focus_order).retain(|entry| entry != label);
        guard(&self.pending_boot).remove(label);
        owned
    }

    fn touch_focus(&self, label: &str) {
        let mut order = guard(&self.focus_order);
        order.retain(|entry| entry != label);
        order.insert(0, label.to_string());
    }
}

/// Route one sidecar stdout line to the window it belongs to.
fn dispatch_sidecar_event(app: &AppHandle, event: &str, data: JsonValue) {
    let Some(state) = app.try_state::<WindowState>() else {
        let _ = app.emit(event, data);
        return;
    };
    // Read once, ahead of the emit that moves `data`.
    let id = data
        .get("id")
        .and_then(JsonValue::as_str)
        .map(str::to_string);

    let decision = {
        let owners = guard(&state.owners);
        let mut awaiting = guard(&state.awaiting_replay);
        for stale in routing::sweep_awaiting(
            &mut awaiting,
            Instant::now(),
            routing::AWAITING_REPLAY_MAX,
        ) {
            append_log(format!(
                "[window] transfer suppression for {stale} expired; releasing"
            ));
        }
        let focus = guard(&state.focus_order);
        routing::route(
            event,
            &data,
            &RouteView {
                owners: &owners,
                awaiting_replay: &awaiting,
                focused: focus.first().map(String::as_str),
            },
        )
    };

    match decision {
        Route::Drop => {}
        Route::Broadcast => {
            let _ = app.emit(event, data);
        }
        Route::EmitTo(label) => {
            let _ = app.emit_to(label.as_str(), event, data);
        }
        Route::UnownedSurface {
            request_id,
            surface_id,
        } => {
            // Never a sibling window: acting on the wrong terminal is worse
            // than failing (docs/specs/dor-cli.md → "Control socket").
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

    // Bookkeeping strictly after the emit, so a replay lifts its own
    // suppression only once the new owner has actually been sent it.
    if let Some(id) = id {
        match event {
            "pty:exit" => {
                guard(&state.owners).remove(&id);
                guard(&state.awaiting_replay).remove(&id);
            }
            "pty:replay" => {
                guard(&state.awaiting_replay).remove(&id);
            }
            _ => {}
        }
    }
}

/// Tell the sidecar's Burrow how many webviews will answer an ask
/// (docs/specs/standalone.md §Burrow service).
fn send_window_count(app: &AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };
    let count = app.webview_windows().len();
    send_to_sidecar(
        &state,
        serde_json::json!({ "event": "burrow:windows", "data": { "count": count } }).to_string(),
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
// Phase 3: per-phase budget once a window's teardown is running. Each reported
// phase (teardown, install) refreshes it, so it bounds a single stalled phase,
// not the sum of all teardown work. Comfortably exceeds the webview's own 10 s
// teardown ceiling (docs/specs/standalone.md §Quit flow).
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
                if let Some(window) = app.get_webview_window(&label) {
                    // The snapshot stays on disk — that is what separates a
                    // quit from a per-window close.
                    if let Some(state) = app.try_state::<WindowState>() {
                        state.drop_window(&label);
                    }
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

/// The last step of a per-window close: forget the window's PTYs and its
/// snapshot, then destroy it. Called from `window_close_proceed`, and from the
/// ack watchdog when the webview never answered.
fn finish_window_close(app: &AppHandle, label: &str) {
    if let Some(state) = app.try_state::<QuitState>() {
        guard(&state.close).clear(label);
        // Bound before the call: the guard would otherwise live for the whole
        // statement, and `apply_quit_actions` takes the same lock.
        let actions = guard(&state.machine).forget_window(label);
        apply_quit_actions(app, actions);
    }
    if let Some(state) = app.try_state::<WindowState>() {
        state.drop_window(label);
    }
    if let Ok(dir) = sessions_dir(app) {
        if let Err(err) = remove_session_from(&dir, label) {
            append_log(format!("[session] {err}"));
        }
    }
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.destroy();
    }
    send_window_count(app);
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
    guard(&windows.owners).remove(&id);
    let msg = serde_json::json!({
        "event": "pty:kill",
        "data": { "id": id }
    });
    send_to_sidecar(&state, msg.to_string());
}

/// List and replay only what this window owns. The answer names the window, so
/// the `pty:list` and every `pty:replay` behind it route back to the asker
/// alone (docs/specs/standalone.md §Windows).
#[tauri::command]
fn pty_request_init(
    window: tauri::Window,
    state: tauri::State<'_, SidecarState>,
    windows: tauri::State<'_, WindowState>,
) {
    let msg = serde_json::json!({
        "event": "pty:requestInit",
        "data": { "forWindow": window.label(), "ids": windows.owned_by(window.label()) },
    });
    send_to_sidecar(&state, msg.to_string());
}

// One passthrough for the whole burrow bridge: the webview and the sidecar
// service share a contract (lib/src/host/remote/service-protocol.ts) that Rust
// has no reason to know, so the payload rides through opaquely. Replies come
// back on the sidecar's own stdout events, not from this invoke.
#[tauri::command]
fn burrow_command(state: tauri::State<'_, SidecarState>, payload: JsonValue) {
    let msg = serde_json::json!({
        "event": "burrow:command",
        "data": payload,
    });
    send_to_sidecar(&state, msg.to_string());
}

// The two app-global alert stores live in the sidecar so N windows share one
// answer (docs/specs/alert.md -> "Alarm settings"). Opaque passthroughs, like
// `burrow_command`: the shape belongs to `lib/src/host/alert-store-host.ts` at
// the other end, and the canonical snapshot comes back as a broadcast
// `alert:settings` / `alert:watchedCommands`.
#[tauri::command]
fn alert_set_watched(state: tauri::State<'_, SidecarState>, payload: JsonValue) {
    let msg = serde_json::json!({ "event": "alert:command", "data": payload });
    send_to_sidecar(&state, msg.to_string());
}

#[tauri::command]
fn alert_publish_settings(state: tauri::State<'_, SidecarState>, payload: JsonValue) {
    let msg = serde_json::json!({ "event": "alert:command", "data": payload });
    send_to_sidecar(&state, msg.to_string());
}

#[tauri::command]
fn dor_control_response(state: tauri::State<'_, SidecarState>, response: DorControlResponse) {
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

#[tauri::command(async)]
fn pty_get_open_ports(
    state: tauri::State<'_, SidecarState>,
    id: String,
) -> Result<JsonValue, String> {
    let response = request_from_sidecar_timeout(
        &state,
        "pty:getOpenPorts",
        serde_json::json!({ "id": id }),
        Duration::from_millis(OPEN_PORT_TIMEOUT_MS),
    )?;
    Ok(response
        .get("ports")
        .cloned()
        .unwrap_or_else(|| JsonValue::Array(Vec::new())))
}

// Wait for PTY exits and their final output before this window goes away.
// Async: waits up to `timeout + 1500ms` (margin for the round trip beyond the
// sidecar's own kill timer) and must not block the main thread for that long.
//
// **Scoped to the caller's own PTYs**, whether it names ids or not: a window
// tearing down must never kill a sibling's terminals.
#[tauri::command]
async fn pty_graceful_kill(
    window: tauri::Window,
    state: tauri::State<'_, SidecarState>,
    windows: tauri::State<'_, WindowState>,
    ids: Option<Vec<String>>,
    timeout: u64,
) -> Result<(), String> {
    let owned = windows.owned_by(window.label());
    let targets: Vec<String> = match ids {
        Some(ids) => ids.into_iter().filter(|id| owned.contains(id)).collect(),
        None => owned,
    };
    request_from_sidecar_timeout(
        &state,
        "pty:gracefulKill",
        serde_json::json!({ "ids": targets, "timeout": timeout }),
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
    ids: Option<Vec<String>>,
    timeout: u64,
) -> Result<(), String> {
    // Defaults to this window's own PTYs: a quit walks the windows one at a
    // time, and interrupting a sibling's agents would destroy the very hint the
    // sibling is about to capture.
    let ids = ids.unwrap_or_else(|| windows.owned_by(window.label()));
    request_from_sidecar_timeout(
        &state,
        "pty:captureRecovery",
        serde_json::json!({ "ids": ids, "timeout": timeout }),
        // Margin for the round trip beyond the sidecar's own ceiling.
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
    // A deliberate close removes the snapshot; a save still in flight from the
    // webview that is going away must not put it back
    // (docs/specs/standalone.md §Per-window close).
    if let Some(windows) = window.app_handle().try_state::<WindowState>() {
        if guard(&windows.closing).contains(window.label()) {
            return Ok(());
        }
    }
    write_session_to(&sessions_dir(window.app_handle())?, window.label(), &state)
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

#[derive(Default)]
struct GeometryState {
    pending: Mutex<HashMap<String, WindowGeometry>>,
    /// Whether a debounce thread is already going to drain `pending`.
    flushing: std::sync::atomic::AtomicBool,
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

/// Record this window's box and schedule the debounced write.
fn note_geometry(app: &AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    // A minimized window reports a nonsense box on some platforms; keep the
    // last real one instead.
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let position = position.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    let Some(state) = app.try_state::<GeometryState>() else {
        return;
    };
    guard(&state.pending).insert(
        label.to_string(),
        WindowGeometry {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
    );
    if state
        .flushing
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(GEOMETRY_DEBOUNCE_MS));
        let Some(state) = app.try_state::<GeometryState>() else {
            return;
        };
        let pending: HashMap<String, WindowGeometry> = std::mem::take(&mut guard(&state.pending));
        state.flushing.store(false, Ordering::SeqCst);
        let Ok(dir) = sessions_dir(&app) else { return };
        for (label, geometry) in pending {
            // A window that closed inside the debounce took its geometry file
            // with it; do not resurrect one for it.
            if app.get_webview_window(&label).is_none() {
                continue;
            }
            let Ok(json) = serde_json::to_string(&geometry) else {
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
// `app_data_dir()` is keyed by the Tauri identifier, which `pnpm dev:standalone`
// shares with the installed app — the same sharing the sessions comment above
// describes — so a second Dormouse process writing this file is an ordinary
// state, not an impossible one. A hash is the only revision two processes agree
// on without talking to each other: a counter only ever tracked this process's
// own writes, so the loser of an overlapping load→save silently overwrote the
// winner's batches. The lock is what makes the read-compare-rename one step, so
// the loser is told "conflict" and retries instead. `None` means nothing is
// stored — what a first save names as its base, and what a reset leaves behind.

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

/// A Workspace leaving a window: the source window's own view of the departure.
fn announce_departure(app: &AppHandle, from: &str, workspace_id: &JsonValue) {
    let _ = app.emit_to(
        from,
        "dormouse://workspace-departed",
        serde_json::json!({ "workspaceId": workspace_id }),
    );
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

/// Tear a Workspace out into a brand-new window under the cursor.
///
/// The payload is *stored*, never emitted: an `emit_to` a window that does not
/// exist yet is lost, so the new webview pulls it with `take_boot_payload`
/// during its own boot (docs/specs/standalone.md §Tear-out).
#[tauri::command]
fn open_workspace_window(
    app: AppHandle,
    window: tauri::Window,
    windows: tauri::State<'_, WindowState>,
    payload: JsonValue,
) -> Result<String, String> {
    let label = next_window_label(&windows);
    // Ownership moves before the window exists, so every byte from this instant
    // is suppressed rather than painted in the window losing the Workspace.
    windows.reassign(&payload_terminal_ids(&payload), &label);
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
    guard(&windows.pending_boot).insert(label.clone(), payload.clone());
    if let Err(err) = build_window(&app, &label, geometry) {
        // Nothing will ever pull the payload, and the PTYs would stay
        // suppressed and ownerless: hand them straight back.
        guard(&windows.pending_boot).remove(&label);
        windows.reassign(&payload_terminal_ids(&payload), window.label());
        for id in payload_terminal_ids(&payload) {
            guard(&windows.awaiting_replay).remove(&id);
        }
        return Err(err);
    }
    send_window_count(&app);
    announce_departure(
        &app,
        window.label(),
        payload.get("workspaceId").unwrap_or(&JsonValue::Null),
    );
    Ok(label)
}

/// Move a Workspace into a window that already exists.
///
/// Ownership and the output suppression move synchronously here, before either
/// window is told anything: the single Rust reader thread processes sidecar
/// lines in order, so every byte after this point is either dropped (and
/// present in the replay the target is about to get) or delivered to the target
/// (docs/specs/standalone.md §Transfer).
#[tauri::command]
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
    windows.reassign(&payload_terminal_ids(&payload), &to);
    // Forward before the content lands: the user dropped here, so this is the
    // window they are now looking at, and a background webview may be throttled
    // out of answering `adopt_ready` promptly.
    if let Some(target) = app.get_webview_window(&to) {
        let _ = target.set_focus();
    }
    let _ = app.emit_to(to.as_str(), "dormouse://workspace-arriving", payload.clone());
    announce_departure(
        &app,
        window.label(),
        payload.get("workspaceId").unwrap_or(&JsonValue::Null),
    );
    Ok(())
}

/// The target has armed its collector; ask the sidecar to list and replay every
/// PTY still suppressed for it. This hop is what removes the whole
/// "arrived before armed" bug class.
#[tauri::command]
fn adopt_ready(
    window: tauri::Window,
    state: tauri::State<'_, SidecarState>,
    windows: tauri::State<'_, WindowState>,
) {
    let label = window.label();
    // Exactly the arriving set: owned by this window and still suppressed.
    let ids: Vec<String> = {
        let owners = guard(&windows.owners);
        guard(&windows.awaiting_replay)
            .keys()
            .filter(|id| owners.get(*id).map(String::as_str) == Some(label))
            .cloned()
            .collect()
    };
    if ids.is_empty() {
        return;
    }
    let msg = serde_json::json!({
        "event": "pty:requestInit",
        "data": { "forWindow": label, "ids": ids },
    });
    send_to_sidecar(&state, msg.to_string());
}

/// A torn-out window's boot payload, or null for an ordinary window. Taking it
/// consumes it: a reload must boot from the snapshot it has since written.
#[tauri::command]
fn take_boot_payload(window: tauri::Window, windows: tauri::State<'_, WindowState>) -> JsonValue {
    guard(&windows.pending_boot)
        .remove(window.label())
        .unwrap_or(JsonValue::Null)
}

/// Remove this window's persisted snapshot and stop it being written again.
#[tauri::command]
async fn remove_window_session(window: tauri::Window) -> Result<(), String> {
    let app = window.app_handle();
    if let Some(windows) = app.try_state::<WindowState>() {
        guard(&windows.closing).insert(window.label().to_string());
    }
    remove_session_from(&sessions_dir(app)?, window.label())
}

/// Which window is under the cursor, in that window's own logical client space.
///
/// Tauri exposes no z-order, so among the windows containing the point the most
/// recently focused wins — right for a drag, and the hover caret makes a wrong
/// guess visible before release.
#[tauri::command]
fn window_at_cursor(
    app: AppHandle,
    windows: tauri::State<'_, WindowState>,
) -> Option<routing::CursorHit> {
    let point = app.cursor_position().ok()?;
    let rects: Vec<routing::WindowRect> = app
        .webview_windows()
        .into_iter()
        .filter_map(|(label, window)| {
            Some(routing::WindowRect {
                label,
                origin: {
                    let position = window.outer_position().ok()?;
                    (position.x, position.y)
                },
                size: {
                    let size = window.outer_size().ok()?;
                    (size.width, size.height)
                },
                scale: window.scale_factor().unwrap_or(1.0),
                hittable: window.is_visible().unwrap_or(true)
                    && !window.is_minimized().unwrap_or(false),
            })
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

// The window archived its notes, removed its snapshot and killed its PTYs.
#[tauri::command]
fn window_close_proceed(app: AppHandle, window: tauri::Window) {
    finish_window_close(&app, window.label());
}

// A window whose last Workspace moved away closes with no confirmation, no
// archive and no kill: its Surfaces are alive in another window
// (docs/specs/standalone.md §Transfer).
#[tauri::command]
fn close_window_self(app: AppHandle, window: tauri::Window) {
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
                    &PredefinedMenuItem::quit(handle, None)?,
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
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    note_geometry(app, window.label());
                }
                // The close button: this window alone unless it is the last one,
                // which is the whole-app quit (§Per-window close). Gated on the
                // quit walk so a teardown's own destroy cannot re-enter it.
                WindowEvent::CloseRequested { api, .. } => {
                    if quit_approved(app) || quit_walking(app) {
                        return;
                    }
                    api.prevent_close();
                    if app.webview_windows().len() > 1 {
                        request_window_close(app, window.label());
                    } else {
                        request_quit(app);
                    }
                }
                // Backstop for a window that went away by any other route.
                WindowEvent::Destroyed => {
                    if let Some(state) = app.try_state::<WindowState>() {
                        state.drop_window(window.label());
                    }
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
                    let labels = routing::restorable_labels(session_file_names(&dir));
                    // Above every SAVED label too, not just the live ones: a
                    // torn-out window must never claim a snapshot still on disk.
                    app.state::<WindowState>()
                        .next_ws
                        .store(routing::seed_next_ws(&labels), Ordering::SeqCst);
                    restore_windows(app.handle(), &dir, &labels);
                }
                Err(e) => append_log(format!("[window] {e}")),
            }
            if let Some(state) = app.try_state::<WindowState>() {
                state.touch_focus(routing::MAIN_LABEL);
            }
            // The Burrow fans an ask out to every window and collects N answers.
            send_window_count(app.handle());

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
            pty_graceful_kill,
            capture_agent_recovery,
            take_recovery_commands,
            iframe_create_proxy_url,
            pty_request_init,
            dor_control_response,
            burrow_command,
            alert_set_watched,
            alert_publish_settings,
            kill_sidecar_now,
            quit_ack,
            quit_vote,
            quit_progress,
            quit_cancel,
            quit_window_done,
            quit_proceed,
            window_close_ack,
            window_close_cancel,
            window_close_proceed,
            close_window_self,
            open_workspace_window,
            transfer_workspace,
            adopt_ready,
            take_boot_payload,
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
            RunEvent::Ready => set_macos_dock_icon(),
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
        find_node_binary, notepad_archive_lock_path, read_notepad_archive_from, read_session_from,
        reset_notepad_archive_at, resolve_dor_cli_paths, resolve_sidecar_path, session_file_name,
        state_root_from, strip_windows_verbatim_prefix, sweep_orphan_session_temps,
        temp_write_path, write_notepad_archive_to, write_session_to, SESSION_TEMP_SUFFIX,
        NOTEPAD_ARCHIVE_FILE,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

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
        /// A second Dormouse over the same `app_data_dir()` — a dev build beside
        /// the installed app, which share a Tauri identifier and so a data
        /// directory.
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

    /// Two Dormouse processes share `app_data_dir()` — a dev build beside the
    /// installed app — so the loser of an overlapping load→save must be told to
    /// retry rather than drop the winner's batches.
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
