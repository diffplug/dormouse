use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::{
    collections::HashMap,
    env,
    fs::{create_dir_all, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    sync::mpsc,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, PredefinedMenuItem, Submenu},
    AppHandle, DragDropEvent, Emitter, Manager, RunEvent, WindowEvent,
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

// ── Quit interception ─────────────────────────────────────────────────────────
//
// Every quit trigger funnels through `request_quit`, which asks the webview's
// orchestrator (standalone/src/quit.ts) to tear down and call back
// `quit_proceed`. Protocol + watchdog phases: docs/specs/standalone.md §Quit flow.
#[derive(Default)]
struct QuitState {
    // The webview acknowledged quit-requested — its listener is alive.
    acked: AtomicBool,
    // Teardown has actually begun (user confirmed, or there was nothing to
    // confirm). Until this is set the webview may be parked on the confirmation
    // dialog waiting for a human, so the teardown deadline below must stay
    // suspended — a slow user must not be force-quit out from under the dialog.
    tearing_down: AtomicBool,
    // Bumped by `quit_progress` at each teardown phase boundary (teardown start,
    // install start). The phase-3 watchdog treats a bump as "still making
    // progress" and refreshes its deadline, so a long-but-live install isn't cut
    // off by a long teardown — each phase gets its own budget rather than sharing
    // one total.
    progress: AtomicU64,
    // Teardown finished (or a watchdog gave up): cleared to exit. Gates the
    // CloseRequested/ExitRequested arms so the final app.exit(0) isn't re-caught.
    approved: AtomicBool,
    // Bumped on every request_quit and on quit_cancel. A watchdog captures the
    // seq it was spawned for; if it no longer matches, a repeated trigger or a
    // cancel has superseded it and the watchdog exits without acting.
    seq: AtomicU64,
}

// Phase 1: no ack within this window ⇒ webview listener is dead — exit.
const QUIT_ACK_TIMEOUT_MS: u64 = 2_000;
// Phase 3: per-phase budget once teardown is running. Each reported phase
// (teardown, install) refreshes it, so it bounds a single stalled phase, not the
// sum of all teardown work. Comfortably exceeds the webview's own 8 s teardown
// ceiling (docs/specs/standalone.md §Quit flow).
const QUIT_PHASE_TIMEOUT_MS: u64 = 12_000;
const QUIT_POLL_STEP_MS: u64 = 500;

fn quit_approved(app: &AppHandle) -> bool {
    app.try_state::<QuitState>()
        .is_some_and(|q| q.approved.load(Ordering::SeqCst))
}

fn request_quit(app: &AppHandle) {
    let Some(quit) = app.try_state::<QuitState>() else {
        return;
    };
    quit.acked.store(false, Ordering::SeqCst);
    // Deliberately do NOT reset `tearing_down` here. A cancel happens before
    // teardown, so it's already false for a genuinely fresh quit; and once
    // teardown begins it only ever ends in `quit_proceed` (app exit), so a repeat
    // trigger fired mid-teardown must keep the flag set — otherwise the fresh
    // watchdog would drop into the unbounded phase-2 wait and stop bounding the
    // in-flight teardown.
    // fetch_add returns the prior value; our watchdog's seq is that + 1.
    let my_seq = quit.seq.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit("dormouse://quit-requested", ());

    // Watchdog: a cloned handle polls QuitState so a dead or wedged webview can't
    // make quit hang. A repeated trigger bumps seq, so this (now-stale) watchdog
    // returns and the fresh request_quit spawns a replacement.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(QUIT_ACK_TIMEOUT_MS));
        let Some(quit) = app.try_state::<QuitState>() else {
            return;
        };
        // Superseded (seq bumped by a repeated trigger or a cancel) or already
        // exiting (approved) ⇒ this watchdog has nothing to do.
        let stale = |quit: &QuitState| {
            quit.seq.load(Ordering::SeqCst) != my_seq || quit.approved.load(Ordering::SeqCst)
        };
        if stale(&quit) {
            return;
        }
        if !quit.acked.load(Ordering::SeqCst) {
            append_log("[quit] no ack from webview; exiting");
            quit.approved.store(true, Ordering::SeqCst);
            app.exit(0);
            return;
        }
        // Phase 2: acked but teardown hasn't begun. The webview may be parked on
        // the confirmation dialog waiting for a human, so hold with no deadline —
        // only proceed (approved) or cancel (seq bump) ends the wait.
        while !quit.tearing_down.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(QUIT_POLL_STEP_MS));
            if stale(&quit) {
                return;
            }
        }
        // Phase 3: teardown running. Bound it, but a `quit_progress` bump (a phase
        // boundary: teardown start, install start) refreshes the deadline so one
        // long phase can't starve the next — each phase gets its own budget.
        let mut last_progress = quit.progress.load(Ordering::SeqCst);
        let mut elapsed = 0u64;
        loop {
            std::thread::sleep(Duration::from_millis(QUIT_POLL_STEP_MS));
            if stale(&quit) {
                return;
            }
            let progress = quit.progress.load(Ordering::SeqCst);
            if progress != last_progress {
                last_progress = progress;
                elapsed = 0;
                continue;
            }
            elapsed += QUIT_POLL_STEP_MS;
            if elapsed >= QUIT_PHASE_TIMEOUT_MS {
                append_log("[quit] teardown phase stalled; exiting");
                quit.approved.store(true, Ordering::SeqCst);
                app.exit(0);
                return;
            }
        }
    });
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
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    if contents.len() <= max_bytes {
        return Ok(contents);
    }
    // Slice on a char boundary so we never split a multi-byte sequence.
    let start = contents.len() - max_bytes;
    let start = (start..contents.len())
        .find(|&i| contents.is_char_boundary(i))
        .unwrap_or(contents.len());
    Ok(contents[start..].to_string())
}

#[derive(Serialize, Deserialize, Clone)]
struct PtySpawnOptions {
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

#[tauri::command]
fn pty_spawn(state: tauri::State<'_, SidecarState>, id: String, options: Option<PtySpawnOptions>) {
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
fn pty_kill(state: tauri::State<'_, SidecarState>, id: String) {
    let msg = serde_json::json!({
        "event": "pty:kill",
        "data": { "id": id }
    });
    send_to_sidecar(&state, msg.to_string());
}

#[tauri::command]
fn pty_request_init(state: tauri::State<'_, SidecarState>) {
    let msg = serde_json::json!({ "event": "pty:requestInit" });
    send_to_sidecar(&state, msg.to_string());
}

// One passthrough for the whole remote-host bridge: the webview and the sidecar
// service share a contract (lib/src/host/remote/service-protocol.ts) that Rust
// has no reason to know, so the payload rides through opaquely. Replies come
// back on the sidecar's own stdout events, not from this invoke.
#[tauri::command]
fn remote_host_command(state: tauri::State<'_, SidecarState>, payload: JsonValue) {
    let msg = serde_json::json!({
        "event": "remoteHost:command",
        "data": payload,
    });
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
fn pty_get_cwd(
    state: tauri::State<'_, SidecarState>,
    id: String,
) -> Result<Option<String>, String> {
    let response = request_from_sidecar(&state, "pty:getCwd", serde_json::json!({ "id": id }))?;
    Ok(response
        .get("cwd")
        .and_then(|cwd| cwd.as_str().map(String::from)))
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

#[tauri::command(async)]
fn pty_get_scrollback(
    state: tauri::State<'_, SidecarState>,
    id: String,
) -> Result<Option<String>, String> {
    let response =
        request_from_sidecar(&state, "pty:getScrollback", serde_json::json!({ "id": id }))?;
    Ok(response
        .get("data")
        .and_then(|data| data.as_str().map(String::from)))
}

// Unlike pty_kill / kill_sidecar_now this preserves scrollback so the caller can
// capture final output afterward. Async: waits up to `timeout + 1500ms` (margin
// for the round trip beyond the sidecar's own kill timer) and must not block the
// main thread for that long.
#[tauri::command]
async fn pty_graceful_kill_all(
    state: tauri::State<'_, SidecarState>,
    timeout: u64,
) -> Result<(), String> {
    request_from_sidecar_timeout(
        &state,
        "pty:gracefulKillAll",
        serde_json::json!({ "timeout": timeout }),
        Duration::from_millis(timeout + 1500),
    )?;
    Ok(())
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

#[tauri::command]
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

fn sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("sessions"))
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

/// Tighten a path to owner-only, best-effort.
///
/// Session snapshots are `PersistedWindow` blobs carrying terminal
/// *transcripts* — scrollback, so whatever the user's shells printed:
/// tokens echoed by a failing curl, a pasted connection string, the contents
/// of a `.env` someone `cat`ed. Written under the umask they land `0644` in a
/// `0755` directory, readable by every other account on the machine. The
/// Host's own state file is already `0600` in a `0700` directory for a
/// strictly *smaller* secret (`lib/src/host/remote/host-state-store.ts`), so
/// this is closing an inconsistency, not inventing a rule.
///
/// Failures are reported rather than swallowed, and whether one is tolerable
/// is the caller's decision: `write_file_atomically` (the session snapshot and
/// the notepad archive) ignores it — a filesystem without the permission model
/// it wants must not fail the save — while `remote_host_state_dir` logs it.
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
/// Reports rather than swallowing. Whether a failure is tolerable depends on
/// the caller, not on this function: `write_file_atomically` runs on the quit
/// path and would rather keep its file under the ACL Windows gave it than lose it,
/// while `remote_host_state_dir` runs at sidecar start and is — per
/// `docs/specs/security-remote.md` -> "Credentials at rest" — the *only* thing restricting
/// `hostToken` on Windows, so a failure there is a silent downgrade of the one
/// control and must reach the log.
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

/// The directory `path` is written into, created and tightened to owner-only.
///
/// The `restrict_to_owner` failure is deliberately ignored: a filesystem without
/// the permission model it wants must not fail the write itself — losing the
/// data is worse than keeping it under the ACL the OS gave it.
fn ensure_owner_only_parent(path: &Path) -> Result<&Path, String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("no parent directory for {}", path.display()))?;
    create_dir_all(dir).map_err(|e| format!("create dir {}: {e}", dir.display()))?;
    let _ = restrict_to_owner(dir, 0o700);
    Ok(dir)
}

/// Write `contents` to `path` atomically and owner-only.
///
/// The one implementation behind both machine-local stores this app owns — the
/// per-window session snapshot and the notepad archive — because both carry user
/// text and both must survive a crash mid-write
/// (docs/specs/security-local.md -> "Persisted state").
fn write_file_atomically(path: &Path, contents: &str) -> Result<(), String> {
    let dir = ensure_owner_only_parent(path)?;
    let tmp = temp_write_path(path);
    // Atomic replace: write a sibling temp file, fsync it, then rename over the
    // target so a crash mid-write can never truncate the previous good copy.
    {
        let mut f = File::create(&tmp).map_err(|e| format!("open temp: {e}"))?;
        // Before any bytes land: the rename below preserves the temp file's
        // mode, so tightening here is what makes the final file 0600.
        let _ = restrict_to_owner(&tmp, 0o600);
        f.write_all(contents.as_bytes())
            .map_err(|e| format!("write temp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync temp: {e}"))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))?;
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

// Owner-only before any bytes are written, and atomic-replace: both live in
// `write_file_atomically` above (docs/specs/security-local.md -> "Persisted
// state", docs/specs/standalone.md -> "Persistence").
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
    write_session_to(&sessions_dir(window.app_handle())?, window.label(), &state)
}

fn remove_session_from(dir: &Path, label: &str) -> Result<(), String> {
    let snapshot = dir.join(session_file_name(label));
    // The temp name comes from the writer, so changing the convention can never
    // leave this sweep looking for a file `write_file_atomically` stopped making.
    let tmp = temp_write_path(&snapshot);
    let paths = [snapshot, tmp];
    let mut first_error = None;
    for path in paths {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            // Already gone is the desired end state, not a failure.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) if first_error.is_none() => {
                first_error = Some(format!("remove session artifact {}: {e}", path.display()));
            }
            Err(_) => {}
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Delete this window's snapshot and any orphaned temp write outright.
///
/// Deleting rather than blanking matters: a pre-upgrade snapshot carries a
/// transcript, and the point of clearing it is that those bytes stop being on
/// disk (docs/specs/transport.md -> "Retiring the transcripts already on disk").
/// Overwriting with an empty string would also leave every reader of the store
/// obliged to treat `""` as a distinct third state alongside present and absent.
#[tauri::command]
async fn clear_session(window: tauri::Window) -> Result<(), String> {
    remove_session_from(&sessions_dir(window.app_handle())?, window.label())
}

// --- Notepad archive (docs/specs/notepad.md) ---------------------------------
//
// One machine-local archive per host, kept as `<app_data_dir>/notepad-archive-v1.json`
// — a *sibling* of `sessions/`, never inside it. A Surface's notes outlive the
// window whose closure archived them, so they must not ride the per-window
// session blob or be swept by `clear_session`.
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
/// Reported rather than swallowed, unlike the `restrict_to_owner` call beside
/// it: this lock is what makes the compare-and-swap correct across processes, so
/// carrying on without it would silently reinstate the overwrite it exists to
/// close. Blocking is safe because every caller is a `#[tauri::command(async)]`
/// off the event loop, and each holder does one small read or write.
fn lock_notepad_archive(path: &Path) -> Result<File, String> {
    ensure_owner_only_parent(path)?;
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

#[tauri::command]
fn kill_sidecar_now(state: tauri::State<'_, SidecarState>) {
    kill_sidecar_and_wait(&state.child);
}

// ── Quit protocol commands (docs/specs/standalone.md §Quit flow) ─────────────

// The webview's quit orchestrator received quit-requested and its listener is
// alive; stand the phase-1 ack watchdog down.
#[tauri::command]
fn quit_ack(state: tauri::State<'_, QuitState>) {
    state.acked.store(true, Ordering::SeqCst);
}

// The orchestrator has started (or advanced) teardown: the confirmation wait is
// over, and this phase boundary refreshes the watchdog's per-phase deadline. The
// webview calls this at teardown start and again before installing an update, so
// a long install gets its own budget instead of sharing the teardown clock.
#[tauri::command]
fn quit_progress(state: tauri::State<'_, QuitState>) {
    state.tearing_down.store(true, Ordering::SeqCst);
    state.progress.fetch_add(1, Ordering::SeqCst);
}

// The user declined the quit (confirmation cancel). Bumping seq invalidates any
// live watchdog for this quit so nothing exits; the next request_quit starts
// fresh (it re-clears `acked` itself).
#[tauri::command]
fn quit_cancel(state: tauri::State<'_, QuitState>) {
    state.seq.fetch_add(1, Ordering::SeqCst);
}

// Teardown is done (or the orchestrator bailed under its own timeout); approve so
// the app.exit(0) below re-enters ExitRequested with approved=true and proceeds.
#[tauri::command]
fn quit_proceed(app: AppHandle, state: tauri::State<'_, QuitState>) {
    state.approved.store(true, Ordering::SeqCst);
    app.exit(0);
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

// Where the sidecar's remote Host persists its enrollment (a bearer credential)
// and its ACL, as one 0600 file it writes itself
// (lib/src/host/remote/host-state-store.ts). Created here so a first launch
// hands the sidecar a directory that exists; if it can't be made, the sidecar is
// told nothing and runs without persistence rather than not at all.
fn remote_host_state_dir(app: &AppHandle) -> Option<String> {
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
    // The Node sidecar writes the Host enrollment here, and that record carries
    // `hostToken` — a bearer credential for `/ws/host`. `FileHostStateStore`
    // asks for `0700`/`0600`, which Windows ignores entirely, so on Windows this
    // is the only thing that restricts it: lock the directory here, before the
    // sidecar is spawned, and everything it writes inside inherits the single
    // owner-only entry — while an enrollment file a prior version already left
    // there is tightened by propagation instead, which is the leg
    // `restrict_to_owner_leaves_one_owner_only_ace` covers with `before.json`.
    // On unix the store's own modes already do the job and this is a harmless
    // re-assert of the same intent.
    if let Err(e) = restrict_to_owner(&dir, 0o700) {
        // Not fatal — a Host that cannot start is worse than one whose state
        // directory kept the OS default — but never silent: on Windows this
        // call is the only thing restricting `hostToken`, so its failure is a
        // downgrade of the sole control and has to be visible.
        append_log(format!(
            "[sidecar] WARNING could not restrict state dir {}: {e}",
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
    let state_dir = remote_host_state_dir(app);
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
        "[remote-host] state dir: {}",
        state_dir.as_deref().unwrap_or("(none)")
    ));

    let mut wrap = CommandWrap::with_new(&node_path, |c| {
        c.arg(&sidecar_path)
            .env("DORMOUSE_HOST", "standalone")
            .env("DORMOUSE_NODE", &dor_node_path)
            .env("DORMOUSE_CLI_BIN", &dor_cli_paths.bin_dir)
            .env("DORMOUSE_CLI_JS", &dor_cli_paths.entrypoint)
            .env("DORMOUSE_CONTROL_TOKEN", &dor_control_token)
            .env("DORMOUSE_STATE_DIR", state_dir.as_deref().unwrap_or(""))
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

            let _ = handle.emit(&event, data);
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
        // Inert while tauri.conf.json sets dragDropEnabled=false (needed for HTML5 pane drag). See diffplug/dormouse#38 and tauri-apps/tauri#14373.
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                let payload: Vec<String> = paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                let _ = window.emit("dormouse://files-dropped", serde_json::json!({ "paths": payload }));
            }
            // Window close funnels into the app-wide quit flow (§Quit flow).
            // Multi-window seam: one window ships today, so a per-window close is
            // the whole-app quit; a multi-window build would give each close a
            // per-window teardown and only quit on the last one.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if !quit_approved(app) {
                    api.prevent_close();
                    request_quit(app);
                }
            }
        })
        .setup(|app| {
            init_log();
            append_log("[app] setup started");

            let sidecar_state = start_sidecar(app.handle()).map_err(|err| {
                append_log(format!("[sidecar] {err}"));
                std::io::Error::new(std::io::ErrorKind::Other, err)
            })?;
            app.manage(sidecar_state);
            append_log("[app] sidecar state registered");

            // Quit-interception state (docs/specs/standalone.md §Quit flow).
            app.manage(QuitState::default());

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
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_theme_colors,
            pty_kill,
            pty_get_cwd,
            pty_get_open_ports,
            pty_get_scrollback,
            pty_graceful_kill_all,
            iframe_create_proxy_url,
            pty_request_init,
            dor_control_response,
            remote_host_command,
            kill_sidecar_now,
            quit_ack,
            quit_progress,
            quit_cancel,
            quit_proceed,
            get_available_shells,
            read_clipboard_file_paths,
            read_clipboard_image_as_file_path,
            read_clipboard_text,
            read_update_log,
            load_session,
            save_session,
            clear_session,
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
        remove_session_from, reset_notepad_archive_at, resolve_dor_cli_paths, resolve_sidecar_path,
        session_file_name, strip_windows_verbatim_prefix, write_notepad_archive_to,
        write_session_to, NOTEPAD_ARCHIVE_FILE,
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
            // on an upgrade remote-host.json already exists under the inherited
            // ACL holding a live hostToken, so propagation to existing children
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
    fn clearing_a_session_removes_the_file_and_leaves_other_windows_alone() {
        let dir = TempDir::new("sessions-clear");
        write_session_to(dir.path(), "main", r#"{"v":1,"who":"main"}"#).unwrap();
        write_session_to(dir.path(), "win-2", r#"{"v":1,"who":"win-2"}"#).unwrap();
        fs::write(dir.path().join("main.json.tmp"), b"main transcript").unwrap();
        fs::write(dir.path().join("win-2.json.tmp"), b"win-2 transcript").unwrap();

        remove_session_from(dir.path(), "main").unwrap();

        // Absent, not blank: a pre-upgrade snapshot carries a transcript, and the
        // point of clearing is that those bytes leave the disk.
        assert_eq!(read_session_from(dir.path(), "main").unwrap(), None);
        assert!(!dir.path().join("main.json").exists());
        assert!(!dir.path().join("main.json.tmp").exists());
        assert_eq!(
            read_session_from(dir.path(), "win-2").unwrap().as_deref(),
            Some(r#"{"v":1,"who":"win-2"}"#),
        );
        assert!(dir.path().join("win-2.json.tmp").exists());
    }

    #[test]
    fn clearing_an_orphaned_temp_session_removes_it() {
        let dir = TempDir::new("sessions-clear-orphaned-temp");
        let tmp = dir.path().join("main.json.tmp");
        fs::write(&tmp, b"legacy transcript").unwrap();

        remove_session_from(dir.path(), "main").unwrap();

        assert!(!tmp.exists());
    }

    #[test]
    fn clearing_an_absent_session_succeeds() {
        // Already gone is the desired end state; a first launch must not error.
        let dir = TempDir::new("sessions-clear-missing");
        assert!(remove_session_from(dir.path(), "main").is_ok());
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
