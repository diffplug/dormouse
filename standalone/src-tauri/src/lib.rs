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
            .join("Dormouse")
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
fn pty_get_cwd(
    state: tauri::State<'_, SidecarState>,
    id: String,
) -> Result<Option<String>, String> {
    let response = request_from_sidecar(&state, "pty:getCwd", serde_json::json!({ "id": id }))?;
    Ok(response
        .get("cwd")
        .and_then(|cwd| cwd.as_str().map(String::from)))
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

fn normalize_external_url(raw_url: &str) -> Result<String, String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err("No URL was provided.".to_string());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("The URL contains control characters.".to_string());
    }

    let parsed = url::Url::parse(trimmed).map_err(|_| "The URL is not valid.".to_string())?;
    match parsed.scheme().to_ascii_lowercase().as_str() {
        "javascript" | "data" | "blob" | "about" => Err(format!(
            "{}: URLs cannot be opened from terminal output.",
            parsed.scheme()
        )),
        _ => Ok(parsed.into()),
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let normalized = normalize_external_url(&url)?;
    open::that_detached(&normalized).map_err(|err| format!("failed to open external URL: {err}"))
}

#[tauri::command]
fn kill_sidecar_now(state: tauri::State<'_, SidecarState>) {
    kill_sidecar(&state.child);
}

// Job Object on Windows / process group on Unix — kill propagates to the
// sidecar's grandchildren (the spawned shells). On Unix this is SIGKILL to
// the whole process group, which is more thorough than the previous
// SIGTERM-to-just-node path that left node-pty grandchildren orphaned.
fn kill_sidecar(child: &SharedChild) {
    if let Ok(mut guard) = child.lock() {
        append_log(format!("[sidecar] killing (pid={})", guard.id()));
        let _ = guard.start_kill();
    }
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

fn start_sidecar(app: &AppHandle) -> Result<SidecarState, String> {
    let sidecar_path = resolve_sidecar_path(
        app.path().resource_dir().ok(),
        Path::new(env!("CARGO_MANIFEST_DIR")),
    );
    let sidecar_arg_path = sidecar_script_arg_path(&sidecar_path);
    let node_path = resolve_node_binary_path()?;
    append_log(format!(
        "[sidecar] resolved script: {}",
        sidecar_path.display()
    ));
    append_log(format!(
        "[sidecar] script argument: {}",
        sidecar_arg_path.display()
    ));
    append_log(format!("[sidecar] node binary: {}", node_path.display()));

    let mut wrap = CommandWrap::with_new(&node_path, |c| {
        c.arg(&sidecar_arg_path)
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
            pty_get_scrollback,
            pty_request_init,
            kill_sidecar_now,
            get_available_shells,
            read_clipboard_file_paths,
            read_clipboard_image_as_file_path,
            read_clipboard_text,
            read_update_log,
            open_external_url,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Dormouse")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SidecarState>() {
                    append_log("[app] exit — killing sidecar");
                    kill_sidecar(&state.child);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        find_node_binary, normalize_external_url, resolve_sidecar_path,
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
    fn external_url_validation_allows_absolute_safe_schemes() {
        assert_eq!(
            normalize_external_url(" https://example.com/docs?q=mouse ").unwrap(),
            "https://example.com/docs?q=mouse"
        );
        assert_eq!(
            normalize_external_url("mailto:support@example.com").unwrap(),
            "mailto:support@example.com"
        );
        assert_eq!(
            normalize_external_url("file:///Users/dev/report.html").unwrap(),
            "file:///Users/dev/report.html"
        );
        assert_eq!(
            normalize_external_url("vscode://file/Users/dev/project/src/App.tsx:4:2").unwrap(),
            "vscode://file/Users/dev/project/src/App.tsx:4:2"
        );
    }

    #[test]
    fn external_url_validation_rejects_blocked_or_malformed_urls() {
        assert!(normalize_external_url("javascript:alert(1)").is_err());
        assert!(normalize_external_url("data:text/html,hello").is_err());
        assert!(normalize_external_url("blob:https://example.com/id").is_err());
        assert!(normalize_external_url("about:blank").is_err());
        assert!(normalize_external_url("not a url").is_err());
        assert!(normalize_external_url("https://example.com/\nnext").is_err());
        assert!(normalize_external_url("").is_err());
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
}
