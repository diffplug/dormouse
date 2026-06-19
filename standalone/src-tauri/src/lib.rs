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
    sync::atomic::{AtomicU64, Ordering},
    sync::mpsc,
    sync::{Arc, Mutex, OnceLock},
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

type SidecarSender = mpsc::Sender<String>;
type PendingRequests = Arc<Mutex<HashMap<String, mpsc::Sender<JsonValue>>>>;
type SharedChild = Arc<Mutex<Box<dyn ChildWrapper + Send + Sync>>>;

struct SidecarState {
    tx: SidecarSender,
    pending_requests: PendingRequests,
    next_request_id: AtomicU64,
    child: SharedChild,
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

#[tauri::command]
fn dor_control_response(state: tauri::State<'_, SidecarState>, response: DorControlResponse) {
    let msg = serde_json::json!({
        "event": "dor:controlResponse",
        "data": response,
    });
    send_to_sidecar(&state, msg.to_string());
}

#[tauri::command]
fn pty_get_cwd(
    state: tauri::State<'_, SidecarState>,
    id: String,
) -> Result<Option<String>, String> {
    let response = request_from_sidecar(&state, "pty:getCwd", serde_json::json!({ "id": id }))?;
    Ok(response
        .get("cwd")
        .and_then(|cwd| cwd.as_str().map(String::from)))
}

// Mirrors `OPEN_PORT_TIMEOUT_MS` in `lib/src/lib/platform/types.ts` — keep in sync.
const OPEN_PORT_TIMEOUT_MS: u64 = 3000;

#[tauri::command]
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

#[tauri::command]
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

// Stands up the loopback iframe proxy in the sidecar and returns the
// IframeProxyResult JSON the webview's IframePanel expects. The proxy server is
// the shared lib/src/host/iframe-proxy.ts; this only bridges the request.
#[tauri::command]
fn iframe_create_proxy_url(
    state: tauri::State<'_, SidecarState>,
    target: String,
) -> Result<JsonValue, String> {
    let response = request_from_sidecar_timeout(
        &state,
        "iframe:createProxyUrl",
        serde_json::json!({ "target": target }),
        Duration::from_secs(5),
    )?;
    Ok(response.get("result").cloned().unwrap_or(JsonValue::Null))
}

// ── agent-browser host (docs/specs/dor-agent-browser.md → "Host capabilities").
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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
#[tauri::command]
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

#[tauri::command]
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

// Screenshot returns raw image bytes. The sidecar base64s them over the
// JSON-lines stdio; decode back to a raw tauri::ipc::Response so the webview
// gets an ArrayBuffer (the path the panel decodes with createImageBitmap).
#[tauri::command]
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
    let b64 = result
        .get("bytesBase64")
        .and_then(JsonValue::as_str)
        .ok_or("screenshot returned no bytes")?;
    let bytes = BASE64
        .decode(b64)
        .map_err(|err| format!("bad screenshot base64: {err}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn read_clipboard_file_paths(
    state: tauri::State<'_, SidecarState>,
) -> Result<Vec<String>, String> {
    let response =
        request_from_sidecar_timeout(&state, "clipboard:readFiles", serde_json::json!({}), Duration::from_secs(5))?;
    Ok(response
        .get("paths")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default())
}

#[tauri::command]
fn read_clipboard_image_as_file_path(
    state: tauri::State<'_, SidecarState>,
) -> Result<Option<String>, String> {
    let response =
        request_from_sidecar_timeout(&state, "clipboard:readImage", serde_json::json!({}), Duration::from_secs(10))?;
    Ok(response
        .get("path")
        .and_then(|path| path.as_str().map(String::from)))
}

#[tauri::command]
fn read_clipboard_text(
    state: tauri::State<'_, SidecarState>,
) -> Result<String, String> {
    let response =
        request_from_sidecar_timeout(&state, "clipboard:readText", serde_json::json!({}), Duration::from_secs(5))?;
    Ok(response
        .get("text")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default())
}

#[tauri::command]
fn read_update_log() -> Result<String, String> {
    read_log_tail(10_000)
}

#[tauri::command]
fn kill_sidecar_now(state: tauri::State<'_, SidecarState>) {
    kill_sidecar_and_wait(&state.child);
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

#[tauri::command]
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
                return path;
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

fn sidecar_script_arg_path(path: &Path) -> PathBuf {
    if let Some(path) = strip_windows_verbatim_prefix(&path.to_string_lossy()) {
        return path;
    }

    path.to_path_buf()
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

fn dor_control_socket_path() -> String {
    let pid = std::process::id();
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\dormouse-{pid}-dor")
    }
    #[cfg(not(windows))]
    {
        env::temp_dir()
            .join(format!("dormouse-{pid}-dor.sock"))
            .to_string_lossy()
            .into_owned()
    }
}

fn dor_control_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{nanos}", std::process::id())
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

fn start_sidecar(app: &AppHandle) -> Result<SidecarState, String> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let sidecar_path = resolve_sidecar_path(app.path().resource_dir().ok(), manifest_dir);
    let sidecar_arg_path = sidecar_script_arg_path(&sidecar_path);
    let node_path = resolve_node_binary_path()?;
    let dor_cli_paths = resolve_dor_cli_paths(&sidecar_path, manifest_dir);
    let dor_control_socket = dor_control_socket_path();
    let dor_control_token = dor_control_token();
    append_log(format!(
        "[sidecar] resolved script: {}",
        sidecar_path.display()
    ));
    append_log(format!(
        "[sidecar] script argument: {}",
        sidecar_arg_path.display()
    ));
    append_log(format!("[sidecar] node binary: {}", node_path.display()));
    append_log(format!(
        "[dor] CLI bin dir: {}",
        dor_cli_paths.bin_dir.display()
    ));
    append_log(format!(
        "[dor] CLI entrypoint: {}",
        dor_cli_paths.entrypoint.display()
    ));
    append_log(format!("[dor] control socket: {dor_control_socket}"));

    let mut wrap = CommandWrap::with_new(&node_path, |c| {
        c.arg(&sidecar_arg_path)
            .env("DORMOUSE_NODE", &node_path)
            .env("DORMOUSE_CLI_BIN", &dor_cli_paths.bin_dir)
            .env("DORMOUSE_CLI_JS", &dor_cli_paths.entrypoint)
            .env("DORMOUSE_CONTROL_SOCKET", &dor_control_socket)
            .env("DORMOUSE_CONTROL_TOKEN", &dor_control_token)
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
            pty_kill,
            pty_get_cwd,
            pty_get_open_ports,
            pty_get_scrollback,
            iframe_create_proxy_url,
            pty_request_init,
            dor_control_response,
            kill_sidecar_now,
            get_available_shells,
            read_clipboard_file_paths,
            read_clipboard_image_as_file_path,
            read_clipboard_text,
            read_update_log,
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
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SidecarState>() {
                    append_log("[app] exit — shutting down sidecar");
                    shutdown_sidecar_and_wait(&state);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        find_node_binary, resolve_dor_cli_paths, resolve_sidecar_path,
        strip_windows_verbatim_prefix,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
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
}
