//! Standalone-host support for the agent-browser surface
//! (docs/specs/dor-agent-browser.md → "Host capabilities").
//!
//! Mirrors the VS Code extension host (`vscode-ext/src/agent-browser-host.ts`),
//! but the standalone runs the user's `agent-browser` binary directly from Rust
//! rather than through webview messages. Narrow capabilities, all on behalf of
//! the webview:
//!
//! 1. `agent_browser_command` — runs the binary against a session for tab
//!    actions, navigation, and teardown. Subcommands are allowlisted (mirroring
//!    `AGENT_BROWSER_ALLOWED_SUBCOMMANDS` in `lib/src/lib/platform/types.ts`);
//!    this is not a general exec channel.
//! 2. `agent_browser_screenshot` — captures one device-resolution frame and
//!    returns the raw bytes.
//! 3. `agent_browser_edit` — host-owned `eval` for the macOS editing chords
//!    (select-all/copy/cut) the stream input path can't dispatch; copy/cut land
//!    on the OS clipboard.
//! 4. `agent_browser_open` — spawns a managed namespaced session and opens a url,
//!    backing a render swap (docs/specs/dor-iframe.md → "Path 1").
//! 5. `agent_browser_pop_out` / `agent_browser_pop_in` — relaunch a session
//!    headed/headless at its live active url (Chrome's mode is fixed at launch,
//!    so this is a close + relaunch).
//! 6. `agent_browser_stream_status` — reads the current stream port so restored
//!    panels recover from a stale persisted `wsPort`.
//!
//! Unlike VS Code (whose `vscode-webview://` origin the stream server rejects),
//! the standalone webview's `tauri://localhost` origin is accepted, so there is
//! no stream relay here — the panel connects directly to `ws://127.0.0.1:<port>`
//! and `getAgentBrowserStreamUrl` stays absent on the adapter.

use std::{
    env,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::Duration,
};

use serde::Serialize;
use serde_json::Value as JsonValue;
use tauri::ipc::Response;
use tauri_plugin_clipboard_manager::ClipboardExt;

// Subcommands the host will run on the webview's behalf — kept in sync with
// `AGENT_BROWSER_ALLOWED_SUBCOMMANDS` in `lib/src/lib/platform/types.ts` (the
// source of truth). This is a narrow channel for tab actions, screen-mode
// resizing, frame capture, navigation, and teardown — not a general exec path.
const ALLOWED_SUBCOMMANDS: &[&str] = &[
    "tab", "set", "screenshot", "open", "reload", "back", "forward", "close",
];

// Right after a fresh spawn / pop-out / pop-in the daemon may not have published
// the stream port yet; a single read would leave the panel pinned to a stale
// port. Retry briefly to close that window (mirrors agent-browser-host.ts).
const STREAM_PORT_READ_ATTEMPTS: u32 = 4;
const STREAM_PORT_READ_DELAY: Duration = Duration::from_millis(150);

// The host owns the exact JS for each editing op — the webview only selects a
// name, so this never becomes an arbitrary-eval channel. Mirrors `EDIT_SCRIPTS`
// in `vscode-ext/src/agent-browser-host.ts`. copy/cut return the selected text;
// selectAll returns ''.
fn edit_script(op: &str) -> Option<&'static str> {
    match op {
        "selectAll" => Some(
            "(()=>{const el=document.activeElement;if(el&&'select'in el&&'value'in el){el.select();}else{document.execCommand('selectAll');}return'';})()",
        ),
        "copy" => Some(
            "(()=>{const el=document.activeElement;if(el&&'selectionStart'in el&&el.selectionStart!=null){return el.value.slice(el.selectionStart,el.selectionEnd);}return String(window.getSelection()||'');})()",
        ),
        "cut" => Some(
            "(()=>{const el=document.activeElement;if(el&&'selectionStart'in el&&el.selectionStart!=null){const s=el.selectionStart,e=el.selectionEnd,t=el.value.slice(s,e);el.setRangeText('',s,e,'end');el.dispatchEvent(new Event('input',{bubbles:true}));return t;}const sel=String(window.getSelection()||'');if(sel)document.execCommand('delete');return sel;})()",
        ),
        _ => None,
    }
}

struct CommandOutput {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

// The GUI-launched host's PATH is often the login PATH (no nvm/volta shims), so
// prefer the absolute path `dor ab` resolved in the user's terminal; fall
// through on ENOENT in case it has gone stale. Mirrors `runWithBinaryFallback`.
fn run_with_binary_fallback(args: &[String], binary_path: Option<&str>) -> CommandOutput {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(path) = binary_path {
        if !path.is_empty() {
            candidates.push(path.to_string());
        }
    }
    if let Some(env_bin) = env::var_os("DORMOUSE_AGENT_BROWSER_BIN") {
        let env_bin = env_bin.to_string_lossy().into_owned();
        if !env_bin.is_empty() && !candidates.contains(&env_bin) {
            candidates.push(env_bin);
        }
    }
    let default = "agent-browser".to_string();
    if !candidates.contains(&default) {
        candidates.push(default);
    }

    let mut last_error = String::new();
    for binary in &candidates {
        match spawn_agent_browser(binary, args) {
            Ok(output) => return output,
            Err(SpawnError::NotFound) => {
                last_error = format!("'{binary}' was not found");
            }
            Err(SpawnError::Other(message)) => {
                return CommandOutput {
                    exit_code: 1,
                    stdout: String::new(),
                    stderr: message,
                }
            }
        }
    }
    CommandOutput {
        exit_code: 1,
        stdout: String::new(),
        stderr: format!("agent-browser binary not found ({last_error})"),
    }
}

enum SpawnError {
    NotFound,
    Other(String),
}

fn spawn_agent_browser(binary: &str, args: &[String]) -> Result<CommandOutput, SpawnError> {
    let output = Command::new(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    match output {
        Ok(output) => Ok(CommandOutput {
            exit_code: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(SpawnError::NotFound),
        Err(err) => Err(SpawnError::Other(err.to_string())),
    }
}

// Read a session's stream WebSocket port via `stream status --json`. Mirrors the
// parse in dor/src/commands/agent-browser.ts: { port } or { data: { port } }.
fn read_stream_port(session: &str, binary_path: Option<&str>) -> Option<u32> {
    let args = vec![
        "--session".to_string(),
        session.to_string(),
        "stream".to_string(),
        "status".to_string(),
        "--json".to_string(),
    ];
    for attempt in 0..STREAM_PORT_READ_ATTEMPTS {
        let result = run_with_binary_fallback(&args, binary_path);
        if result.exit_code == 0 {
            if let Ok(parsed) = serde_json::from_str::<JsonValue>(&result.stdout) {
                let port = parsed
                    .get("data")
                    .and_then(|data| data.get("port"))
                    .or_else(|| parsed.get("port"))
                    .and_then(JsonValue::as_u64);
                if let Some(port) = port {
                    return Some(port as u32);
                }
            }
        }
        if attempt < STREAM_PORT_READ_ATTEMPTS - 1 {
            thread::sleep(STREAM_PORT_READ_DELAY);
        }
    }
    None
}

fn usable_relaunch_url(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() || trimmed == "about:blank" {
        return None;
    }
    Some(trimmed.to_string())
}

fn read_current_url(session: &str, binary_path: Option<&str>) -> Option<String> {
    let args = vec![
        "--session".to_string(),
        session.to_string(),
        "get".to_string(),
        "url".to_string(),
    ];
    let result = run_with_binary_fallback(&args, binary_path);
    if result.exit_code != 0 {
        return None;
    }
    let first_line = result
        .stdout
        .lines()
        .find(|line| !line.trim().is_empty());
    usable_relaunch_url(first_line)
}

// The webview's tab snapshot can lag behind the daemon, especially while swapping
// headed/headless modes. Query the live session immediately before closing it so
// pop-out/pop-in preserves the page the user is actually on.
fn resolve_relaunch_url(
    session: &str,
    requested_url: Option<&str>,
    binary_path: Option<&str>,
) -> String {
    read_current_url(session, binary_path)
        .or_else(|| usable_relaunch_url(requested_url))
        .unwrap_or_else(|| "about:blank".to_string())
}

// A fresh managed session for a GUI-spawned surface (no `--key`), mirroring
// `dor ab`'s `dormouse.<workspaceId>.<key>` namespacing so it can't collide with
// a user's own agent-browser sessions.
fn generate_gui_session() -> String {
    // 6 random bytes of hex, matching the VS Code host's `randomBytes(6)`.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let pid = std::process::id() as u128;
    let mixed = nanos ^ (pid << 64);
    format!("dormouse.1.gui-{:012x}", mixed & 0xffff_ffff_ffff)
}

// ── Result shapes (camelCase to match lib/src/lib/platform/types.ts) ─────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserCommandResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserEditResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserStreamStatusResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    ws_port: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserOpenResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ws_port: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    binary_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserPopResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    ws_port: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn agent_browser_command(
    session: String,
    args: Vec<String>,
    binary_path: Option<String>,
) -> AgentBrowserCommandResult {
    if session.is_empty() {
        return AgentBrowserCommandResult {
            exit_code: 1,
            stdout: String::new(),
            stderr: "session is required".to_string(),
        };
    }
    let subcommand = args.first().map(String::as_str).unwrap_or("");
    if subcommand.is_empty() || !ALLOWED_SUBCOMMANDS.contains(&subcommand) {
        return AgentBrowserCommandResult {
            exit_code: 1,
            stdout: String::new(),
            stderr: format!("agent-browser subcommand '{subcommand}' is not allowed from the webview"),
        };
    }
    let mut full_args = vec!["--session".to_string(), session];
    full_args.extend(args);
    let output = run_with_binary_fallback(&full_args, binary_path.as_deref());
    AgentBrowserCommandResult {
        exit_code: output.exit_code,
        stdout: output.stdout,
        stderr: output.stderr,
    }
}

#[tauri::command]
pub fn agent_browser_edit(
    app: tauri::AppHandle,
    session: String,
    op: String,
    binary_path: Option<String>,
) -> AgentBrowserEditResult {
    if session.is_empty() {
        return AgentBrowserEditResult { ok: false, text: None, error: Some("session is required".to_string()) };
    }
    let Some(script) = edit_script(&op) else {
        return AgentBrowserEditResult { ok: false, text: None, error: Some(format!("unknown edit op '{op}'")) };
    };

    let args = vec![
        "--session".to_string(),
        session,
        "eval".to_string(),
        script.to_string(),
        "--json".to_string(),
    ];
    let result = run_with_binary_fallback(&args, binary_path.as_deref());
    if result.exit_code != 0 {
        let error = result.stderr.trim();
        let error = if error.is_empty() { format!("eval exited {}", result.exit_code) } else { error.to_string() };
        return AgentBrowserEditResult { ok: false, text: None, error: Some(error) };
    }

    // eval --json envelope: { success, data: { result }, error }.
    let mut text = String::new();
    match serde_json::from_str::<JsonValue>(&result.stdout) {
        Ok(envelope) => {
            if envelope.get("success").and_then(JsonValue::as_bool) == Some(false) {
                let error = envelope
                    .get("error")
                    .and_then(JsonValue::as_str)
                    .map(String::from)
                    .unwrap_or_else(|| format!("{op} failed"));
                return AgentBrowserEditResult { ok: false, text: None, error: Some(error) };
            }
            if let Some(value) = envelope.get("data").and_then(|data| data.get("result")).and_then(JsonValue::as_str) {
                text = value.to_string();
            }
        }
        Err(_) => {
            return AgentBrowserEditResult { ok: false, text: None, error: Some(format!("could not parse eval output for {op}")) };
        }
    }

    if op == "selectAll" {
        return AgentBrowserEditResult { ok: true, text: None, error: None };
    }
    // Land the grabbed text on the user's real OS clipboard. Skip empty so an
    // empty selection doesn't clobber what's already there.
    if !text.is_empty() {
        if let Err(err) = app.clipboard().write_text(text.clone()) {
            return AgentBrowserEditResult { ok: false, text: None, error: Some(format!("clipboard write failed: {err}")) };
        }
    }
    AgentBrowserEditResult { ok: true, text: Some(text), error: None }
}

// Capture one device-resolution frame via the user's agent-browser `screenshot`
// command (which honors the session's viewport/DPR, unlike the CSS-resolution
// screencast). agent-browser writes a file and reports the path; we read it back
// and return the raw bytes as an ArrayBuffer (tauri::ipc::Response) so the panel
// can decode them with createImageBitmap — no base64 round-trip.
#[tauri::command]
pub fn agent_browser_screenshot(
    session: String,
    format: Option<String>,
    quality: Option<u32>,
    binary_path: Option<String>,
) -> Result<Response, String> {
    if session.is_empty() {
        return Err("session is required".to_string());
    }
    let format = if format.as_deref() == Some("png") { "png" } else { "jpeg" };
    let ext = if format == "png" { "png" } else { "jpg" };

    // Reused per session so we don't litter tmp with one file per frame; the
    // panel guarantees one screenshot in flight per surface, so overwriting is
    // safe. Mirrors `screenshotPath` in agent-browser-host.ts.
    let safe: String = session
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    let out: PathBuf = env::temp_dir().join(format!("dormouse-ab-shot-{safe}.{ext}"));
    let out_str = out.to_string_lossy().into_owned();

    let mut args = vec![
        "--session".to_string(),
        session,
        "screenshot".to_string(),
        out_str,
        "--screenshot-format".to_string(),
        format.to_string(),
    ];
    if format == "jpeg" {
        let q = quality.map(|q| q.clamp(1, 100)).unwrap_or(85);
        args.push("--screenshot-quality".to_string());
        args.push(q.to_string());
    }

    let result = run_with_binary_fallback(&args, binary_path.as_deref());
    if result.exit_code != 0 {
        let error = result.stderr.trim();
        let detail = if error.is_empty() { result.stdout.trim() } else { error };
        return Err(if detail.is_empty() { format!("screenshot exited {}", result.exit_code) } else { detail.to_string() });
    }
    std::fs::read(&out).map(Response::new).map_err(|err| format!("could not read screenshot file: {err}"))
}

#[tauri::command]
pub fn agent_browser_stream_status(
    session: String,
    binary_path: Option<String>,
) -> AgentBrowserStreamStatusResult {
    if session.is_empty() {
        return AgentBrowserStreamStatusResult { ok: false, ws_port: None, error: Some("session is required".to_string()) };
    }
    match read_stream_port(&session, binary_path.as_deref()) {
        Some(ws_port) => AgentBrowserStreamStatusResult { ok: true, ws_port: Some(ws_port), error: None },
        None => AgentBrowserStreamStatusResult { ok: false, ws_port: None, error: Some("stream port unavailable".to_string()) },
    }
}

// Spawn a managed session and open <url> — backs swapping an iframe embed up to a
// live screencast (docs/specs/dor-iframe.md → "Path 1"). With `headed`, the
// process launches headed in one shot so embed→popout doesn't open a headless
// browser only to tear it down. Mirrors `runAgentBrowserOpen`.
#[tauri::command]
pub fn agent_browser_open(
    url: String,
    headed: Option<bool>,
    binary_path: Option<String>,
) -> AgentBrowserOpenResult {
    if url.is_empty() {
        return AgentBrowserOpenResult { ok: false, session: None, ws_port: None, binary_path: None, error: Some("url is required".to_string()) };
    }
    let session = generate_gui_session();
    let mut args = vec!["--session".to_string(), session.clone()];
    if headed == Some(true) {
        args.push("--headed".to_string());
    }
    args.push("open".to_string());
    args.push(url);

    let open = run_with_binary_fallback(&args, binary_path.as_deref());
    if open.exit_code != 0 {
        let error = open.stderr.trim();
        let error = if error.is_empty() { format!("open exited {}", open.exit_code) } else { error.to_string() };
        return AgentBrowserOpenResult { ok: false, session: None, ws_port: None, binary_path: None, error: Some(error) };
    }
    let ws_port = read_stream_port(&session, binary_path.as_deref());
    AgentBrowserOpenResult {
        ok: true,
        session: Some(session),
        ws_port,
        binary_path,
        error: None,
    }
}

// Pop-out is a relaunch, not a live toggle: Chrome's headed/headless choice is
// fixed at launch (spec → "Headed Pop-Out"). Close the headless session, then
// reopen it headed at the active URL. (v1 preserves the active tab URL only;
// `rect` is accepted but unused — no window positioning today.)
#[tauri::command]
pub fn agent_browser_pop_out(
    session: String,
    url: Option<String>,
    binary_path: Option<String>,
) -> AgentBrowserPopResult {
    if session.is_empty() {
        return AgentBrowserPopResult { ok: false, ws_port: None, error: Some("session is required".to_string()) };
    }
    let resolved = resolve_relaunch_url(&session, url.as_deref(), binary_path.as_deref());
    run_with_binary_fallback(&["--session".to_string(), session.clone(), "close".to_string()], binary_path.as_deref());
    let open = run_with_binary_fallback(
        &["--session".to_string(), session.clone(), "--headed".to_string(), "open".to_string(), resolved],
        binary_path.as_deref(),
    );
    if open.exit_code != 0 {
        let error = open.stderr.trim();
        let error = if error.is_empty() { format!("headed open exited {}", open.exit_code) } else { error.to_string() };
        return AgentBrowserPopResult { ok: false, ws_port: None, error: Some(error) };
    }
    let ws_port = read_stream_port(&session, binary_path.as_deref());
    AgentBrowserPopResult { ok: true, ws_port, error: None }
}

// The reverse: close the headed session and relaunch it headless at the active
// URL, resuming the screencast. Pairs with `agent_browser_pop_out`.
#[tauri::command]
pub fn agent_browser_pop_in(
    session: String,
    url: Option<String>,
    binary_path: Option<String>,
) -> AgentBrowserPopResult {
    if session.is_empty() {
        return AgentBrowserPopResult { ok: false, ws_port: None, error: Some("session is required".to_string()) };
    }
    let resolved = resolve_relaunch_url(&session, url.as_deref(), binary_path.as_deref());
    run_with_binary_fallback(&["--session".to_string(), session.clone(), "close".to_string()], binary_path.as_deref());
    let open = run_with_binary_fallback(
        &["--session".to_string(), session.clone(), "open".to_string(), resolved],
        binary_path.as_deref(),
    );
    if open.exit_code != 0 {
        let error = open.stderr.trim();
        let error = if error.is_empty() { format!("open exited {}", open.exit_code) } else { error.to_string() };
        return AgentBrowserPopResult { ok: false, ws_port: None, error: Some(error) };
    }
    let ws_port = read_stream_port(&session, binary_path.as_deref());
    AgentBrowserPopResult { ok: true, ws_port, error: None }
}
