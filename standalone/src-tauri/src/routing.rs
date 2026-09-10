//! Which window a sidecar event belongs to, and the label bookkeeping around it.
//!
//! The sidecar has no window concept: it emits one stream of events for every
//! PTY in the process. Rust owns the map from PTY to window
//! (docs/specs/standalone.md -> "Windows"), and everything here is pure so the
//! whole table can be exercised without a Tauri app.

use serde::Serialize;
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// The first window's label, fixed in `tauri.conf.json` so a snapshot written
/// before this build still restores into the same file.
pub const MAIN_LABEL: &str = "main";
/// Every torn-out window is `ws-<n>`.
pub const WS_LABEL_PREFIX: &str = "ws-";
/// How many saved windows a boot reopens. The excess stays on disk.
pub const MAX_RESTORED_WINDOWS: usize = 8;
/// How long a transfer may suppress a PTY's output before the suppression is
/// assumed lost and released (fail open: duplicated bytes beat a dead pane).
pub const AWAITING_REPLAY_MAX: Duration = Duration::from_secs(5);

/// How long an arrival may sit unadopted before Rust hands it back. The
/// target's own collection times out at 3 s and a torn-out window boots in
/// well under this; past it the target webview is wedged, and its shells
/// would otherwise stay silent in the source forever.
pub const ARRIVAL_MAX: Duration = Duration::from_secs(20);

/// Where one sidecar event goes. Every label is borrowed from the state it was
/// read out of: this runs once per PTY chunk, so it allocates nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route<'a> {
    /// To exactly this window label.
    EmitTo(&'a str),
    /// To every window. Correlation is per-adapter random, so a broadcast
    /// reaches the one adapter waiting on it and no other can mistake it
    /// (the argument `docs/specs/vscode.md` -> "Peer surfaces across windows"
    /// makes for its own fan-out).
    Broadcast,
    /// Nothing is delivered: the id is mid-transfer and its bytes are already in
    /// the replay the new owner is about to receive, or no window owns it at all
    /// and every window would otherwise ring for a pane none of them shows.
    Drop,
    /// A `dor` request naming no Surface belongs to whichever window the user
    /// is looking at. Resolved by the caller, which alone holds the focus order.
    Focused,
    /// A `dor` control request naming a Surface no window owns. Answered with
    /// an error rather than handed to a sibling, which would act on the wrong
    /// terminal (docs/specs/dor-cli.md -> "Standalone").
    UnownedSurface {
        request_id: &'a str,
        surface_id: &'a str,
    },
}

/// The routing table's read-only view of `WindowState`. Borrowed, never
/// copied: this runs once per PTY chunk.
pub struct RouteView<'a> {
    pub owners: &'a HashMap<String, String>,
    /// Ids mid-transfer, each with the instant its suppression began.
    pub awaiting_replay: &'a HashMap<String, Instant>,
    /// Which window took each outstanding `dor` request, so its cancel follows
    /// the request instead of waking every window.
    pub dor_targets: &'a HashMap<String, String>,
}

fn str_field<'a>(data: &'a JsonValue, key: &str) -> Option<&'a str> {
    data.get(key).and_then(JsonValue::as_str)
}

fn lookup<'a>(map: &'a HashMap<String, String>, key: &str) -> Route<'a> {
    match map.get(key) {
        Some(label) => Route::EmitTo(label.as_str()),
        // Nobody is holding this request, so nothing follows it.
        None => Route::Broadcast,
    }
}

/// Route by PTY ownership. **An id no window owns is dropped, never broadcast**:
/// ownership is minted for every PTY this app spawns, so an unowned id is one
/// whose window went away — and a broadcast would ring every other window's
/// AlertManager for a pane none of them shows. The caller reaps the process
/// (`Destroyed` in `standalone/src-tauri/src/lib.rs`).
fn owner<'a>(map: &'a HashMap<String, String>, id: &str) -> Route<'a> {
    match map.get(id) {
        Some(label) => Route::EmitTo(label.as_str()),
        None => Route::Drop,
    }
}

/// The one decision every sidecar stdout line passes through.
pub fn route<'a>(event: &str, data: &'a JsonValue, view: &RouteView<'a>) -> Route<'a> {
    match event {
        // Terminal traffic, keyed by the PTY it came from.
        "pty:data" | "terminal:semanticEvents" | "terminal:protocolEvents" => {
            let Some(id) = str_field(data, "id") else {
                return Route::Broadcast;
            };
            if view.awaiting_replay.contains_key(id) {
                return Route::Drop;
            }
            owner(view.owners, id)
        }
        // Never suppressed: a replay is exactly what the suppression is waiting
        // for, and the caller lifts the suppression after this emit.
        "pty:exit" | "pty:replay" => match str_field(data, "id") {
            Some(id) => owner(view.owners, id),
            None => Route::Broadcast,
        },
        // The list answers one window's `pty:requestInit`, which named itself.
        "pty:list" => match str_field(data, "forWindow") {
            Some(label) => Route::EmitTo(label),
            None => Route::Broadcast,
        },
        "dor:controlRequest" => {
            let Some(surface_id) = str_field(data, "surfaceId") else {
                return Route::Focused;
            };
            match view.owners.get(surface_id) {
                Some(label) => Route::EmitTo(label.as_str()),
                None => Route::UnownedSurface {
                    request_id: str_field(data, "requestId").unwrap_or_default(),
                    surface_id,
                },
            }
        }
        // The cancel follows the request: only the window handling it holds the
        // subscription, watch or completion claim the cancel releases.
        "dor:controlCancel" => match str_field(data, "requestId") {
            Some(request_id) => lookup(view.dor_targets, request_id),
            None => Route::Broadcast,
        },
        // A Burrow ask naming a Surface is a question exactly one window can
        // answer, and `attach` / `resize` MUTATE that Surface — fanned out, every
        // other window is asked to resize a pane it does not hold. The directory
        // ask names none and stays a broadcast, because it is the union of every
        // window's panes (docs/specs/standalone.md -> "Burrow service").
        "burrow:ask" => match data
            .get("params")
            .and_then(|params| params.get("surfaceId"))
            .and_then(JsonValue::as_str)
        {
            // A Surface with no PTY (a browser pane) is owned by no id here, so
            // it keeps the fan-out: only its own window answers non-empty.
            Some(surface_id) => lookup(view.owners, surface_id),
            None => Route::Broadcast,
        },
        // `alert:*` carrying an id is about one Session; the two app-global
        // stores (settings, watched commands) carry none and reach everyone.
        _ if event.starts_with("alert:") => match str_field(data, "id") {
            Some(id) => owner(view.owners, id),
            None => Route::Broadcast,
        },
        _ => Route::Broadcast,
    }
}

/// One Workspace in flight between two windows, keyed by `workspace_id`.
///
/// **The record is the whole transaction.** It is created when the source
/// invokes and lives until the target adopts the Workspace or dies, and it is
/// what scopes the target's `pty:requestInit`, what keeps the sweep off a real
/// arrival's suppression, what a boot list excludes, and what the hand-back on
/// failure reads (docs/specs/standalone.md -> "Arrival queue").
///
/// **Held rather than emitted**: a window that has not installed its arrival
/// listener yet — one still booting, or one torn out moments ago — is a legal
/// drop target, and an `emit_to` it would simply be lost.
#[derive(Debug, Clone, PartialEq)]
pub struct Arrival {
    pub workspace_id: String,
    /// The window that still shows the Workspace until the target adopts it.
    pub from: String,
    pub to: String,
    /// Exactly the PTYs whose ownership moved, helpers included.
    pub terminal_ids: Vec<String>,
    /// What the target mounts the Workspace from.
    pub payload: JsonValue,
    /// When it was queued: the deadline's origin, and what makes the expiry
    /// watchdog's record *this* one rather than a later re-drop of the same
    /// Workspace into the same window.
    pub queued_at: Instant,
}

/// Every arrival in flight, oldest first. A Vec, not a map: there are a handful
/// at most, and both the per-window drain and the by-Workspace lookup want the
/// order the drops happened in.
pub type Arrivals = Vec<Arrival>;

/// Whether a Workspace is already in flight. **One arrival per Workspace**: a
/// second would silence the same ids twice and leave one record to hand back.
pub fn has_arrival(arrivals: &Arrivals, workspace_id: &str) -> bool {
    arrivals
        .iter()
        .any(|arrival| arrival.workspace_id == workspace_id)
}

pub fn queue_arrival(arrivals: &mut Arrivals, arrival: Arrival) {
    arrivals.push(arrival);
}

pub fn find_arrival<'a>(arrivals: &'a Arrivals, workspace_id: &str) -> Option<&'a Arrival> {
    arrivals
        .iter()
        .find(|arrival| arrival.workspace_id == workspace_id)
}

/// Settle one arrival, but **only from the window it was queued for**: a stale
/// `adopt_done` from the source could otherwise retire a transfer the target is
/// still resuming.
pub fn take_arrival(arrivals: &mut Arrivals, workspace_id: &str, to: &str) -> Option<Arrival> {
    let position = arrivals
        .iter()
        .position(|arrival| arrival.workspace_id == workspace_id && arrival.to == to)?;
    Some(arrivals.remove(position))
}

/// Retire an arrival that outlived `ARRIVAL_MAX`, but **only the exact record
/// the watchdog was armed for**: one adopted and re-dropped since would carry a
/// later `queued_at`, and belongs to its own watchdog.
pub fn expire_arrival(
    arrivals: &mut Arrivals,
    workspace_id: &str,
    to: &str,
    queued_at: Instant,
) -> Option<Arrival> {
    let position = arrivals.iter().position(|arrival| {
        arrival.workspace_id == workspace_id && arrival.to == to && arrival.queued_at == queued_at
    })?;
    Some(arrivals.remove(position))
}

/// Every arrival `label` will never take, removed: its window is gone.
pub fn take_arrivals_to(arrivals: &mut Arrivals, label: &str) -> Vec<Arrival> {
    let mut lost = Vec::new();
    arrivals.retain(|arrival| {
        if arrival.to == label {
            lost.push(arrival.clone());
            false
        } else {
            true
        }
    });
    lost
}

/// What `label` mounts, oldest first. **Not consumed**: the record settles at
/// `adopt_done`, so a webview that drains twice — at boot and again when its
/// listener is installed — finds an arrival it has not settled yet rather than
/// losing the Workspace to a drain that happened too early.
pub fn arrival_payloads(arrivals: &Arrivals, label: &str) -> Vec<JsonValue> {
    arrivals
        .iter()
        .filter(|arrival| arrival.to == label)
        .map(|arrival| arrival.payload.clone())
        .collect()
}

/// Every id an in-flight arrival claims: the ids the sweep may not release and
/// a boot list may not place as panes.
pub fn arrival_ids(arrivals: &Arrivals) -> HashSet<String> {
    arrivals
        .iter()
        .flat_map(|arrival| arrival.terminal_ids.iter().cloned())
        .collect()
}

/// What a window's own `pty:requestInit` may name: the ids it owns, **minus
/// every id an arrival claims**. Ownership moves at the source's invoke, so a
/// window booting with a Workspace already queued for it owns those shells
/// before it has any idea what they belong to; listed here they would be placed
/// as top-level panes beside the Workspace about to mount them.
pub fn boot_list_ids(owned: Vec<String>, arrivals: &Arrivals) -> Vec<String> {
    if arrivals.is_empty() {
        return owned;
    }
    let arriving = arrival_ids(arrivals);
    owned.into_iter().filter(|id| !arriving.contains(id)).collect()
}

/// Release every suppression older than `max` that **no arrival claims**,
/// returning what was released.
///
/// Fail open, but only defensively: a suppression whose arrival record is gone
/// is bookkeeping nothing will ever lift, while a real arrival's is lifted by
/// its own replay — and a cold boot slow enough to outrun `max` would otherwise
/// have its shells unsilenced into a window that has not resumed them yet.
pub fn sweep_awaiting(
    map: &mut HashMap<String, Instant>,
    now: Instant,
    max: Duration,
    arriving: &HashSet<String>,
) -> Vec<String> {
    // The steady state: nothing is transferring, so this costs one branch.
    if map.is_empty() {
        return Vec::new();
    }
    let stale: Vec<String> = map
        .iter()
        .filter(|(id, at)| now.duration_since(**at) >= max && !arriving.contains(*id))
        .map(|(id, _)| id.clone())
        .collect();
    for id in &stale {
        map.remove(id);
    }
    stale
}

/// The next `ws-<n>`, above every label given — live windows and saved
/// snapshots alike, so a torn-out window can never claim a saved window's file.
pub fn seed_next_ws(labels: impl IntoIterator<Item = impl AsRef<str>>) -> u64 {
    let mut max = 0u64;
    for label in labels {
        if let Some(n) = ws_index(label.as_ref()) {
            max = max.max(n);
        }
    }
    max + 1
}

/// `ws-4` -> 4; anything else -> None.
pub fn ws_index(label: &str) -> Option<u64> {
    label.strip_prefix(WS_LABEL_PREFIX)?.parse::<u64>().ok()
}

/// Whether `main` was among `labels`, and everything else in the order given.
/// Both orderings below put `main` at one end and keep the rest as they came.
fn partition_main(labels: impl IntoIterator<Item = impl AsRef<str>>) -> (bool, Vec<String>) {
    let mut has_main = false;
    let mut rest: Vec<String> = Vec::new();
    for label in labels {
        let label = label.as_ref();
        if label == MAIN_LABEL {
            has_main = true;
        } else {
            rest.push(label.to_string());
        }
    }
    (has_main, rest)
}

/// The windows a boot reopens, from the file names in the sessions directory:
/// `main` first, then `ws-<n>` in numeric order. Temps and foreign names are
/// dropped; the caller caps the list and logs what it left behind.
pub fn restorable_labels(file_names: impl IntoIterator<Item = impl AsRef<str>>) -> Vec<String> {
    let saved = file_names.into_iter().filter_map(|name| {
        // `.json.tmp` also ends with `.tmp`, so strip on the full suffix and a
        // temp never survives to become a label.
        let label = name.as_ref().strip_suffix(".json")?;
        (label == MAIN_LABEL || ws_index(label).is_some()).then(|| label.to_string())
    });
    let (has_main, mut ws) = partition_main(saved.collect::<Vec<String>>());
    ws.sort_by_key(|label| ws_index(label).unwrap_or_default());
    let mut labels: Vec<String> = Vec::with_capacity(ws.len() + 1);
    if has_main {
        labels.push(MAIN_LABEL.to_string());
    }
    labels.extend(ws);
    labels
}

/// Teardown order for a quit: **`main` last**, which is the window that holds
/// `updater:*` and installs a pending update once every sibling has handed on
/// (docs/specs/auto-update.md). Every other label keeps the order it came in.
pub fn quit_order(labels: impl IntoIterator<Item = impl AsRef<str>>) -> Vec<String> {
    let (has_main, mut order) = partition_main(labels);
    if has_main {
        order.push(MAIN_LABEL.to_string());
    }
    order
}

/// Whether `point` (physical, screen space) is inside a window's outer rect.
pub fn rect_contains(origin: (i32, i32), size: (u32, u32), point: (f64, f64)) -> bool {
    let (x, y) = origin;
    let (w, h) = size;
    point.0 >= f64::from(x)
        && point.1 >= f64::from(y)
        && point.0 < f64::from(x) + f64::from(w)
        && point.1 < f64::from(y) + f64::from(h)
}

/// One window as the cursor hit test sees it.
pub struct WindowRect {
    pub label: String,
    pub origin: (i32, i32),
    pub size: (u32, u32),
    pub scale: f64,
    /// Minimized or hidden windows are not under anything.
    pub hittable: bool,
}

/// Where the cursor is, in the hit window's own logical client space.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CursorHit {
    pub label: String,
    pub x: f64,
    pub y: f64,
}

/// The window under `point`, preferring the most recently focused of the
/// windows containing it — Tauri exposes no z-order, and focus order is the
/// closest stand-in (the hover caret makes a wrong guess visible before
/// release).
pub fn window_at(
    rects: &[WindowRect],
    focus_order: &[String],
    point: (f64, f64),
) -> Option<CursorHit> {
    let containing: Vec<&WindowRect> = rects
        .iter()
        .filter(|rect| rect.hittable && rect_contains(rect.origin, rect.size, point))
        .collect();
    let best = focus_order
        .iter()
        .find_map(|label| containing.iter().find(|rect| &rect.label == label).copied())
        .or_else(|| containing.first().copied())?;
    Some(CursorHit {
        label: best.label.clone(),
        x: (point.0 - f64::from(best.origin.0)) / best.scale,
        y: (point.1 - f64::from(best.origin.1)) / best.scale,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn labels(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(id, label)| ((*id).to_string(), (*label).to_string()))
            .collect()
    }

    fn awaiting(ids: &[&str]) -> HashMap<String, Instant> {
        let now = Instant::now();
        ids.iter().map(|id| ((*id).to_string(), now)).collect()
    }

    /// Every row of the routing table (docs/specs/standalone.md -> "Windows").
    #[test]
    fn routes_every_sidecar_event_to_its_window() {
        let owned = labels(&[("a", "main"), ("b", "ws-2")]);
        let none = awaiting(&[]);
        let dor = labels(&[("dor-7", "ws-2")]);
        let view = RouteView {
            owners: &owned,
            awaiting_replay: &none,
            dor_targets: &dor,
        };
        let cases: &[(&str, JsonValue, Route)] = &[
            ("pty:data", json!({"id":"a"}), Route::EmitTo("main")),
            ("pty:data", json!({"id":"b"}), Route::EmitTo("ws-2")),
            // Every PTY is minted with an owner, so an unowned id is one whose
            // window went away: dropped, never rung through every sibling.
            ("pty:data", json!({"id":"zz"}), Route::Drop),
            ("pty:exit", json!({"id":"zz"}), Route::Drop),
            ("alert:state", json!({"id":"zz"}), Route::Drop),
            (
                "terminal:semanticEvents",
                json!({"id":"b"}),
                Route::EmitTo("ws-2"),
            ),
            (
                "terminal:protocolEvents",
                json!({"id":"a"}),
                Route::EmitTo("main"),
            ),
            ("pty:exit", json!({"id":"b"}), Route::EmitTo("ws-2")),
            ("pty:replay", json!({"id":"a"}), Route::EmitTo("main")),
            (
                "pty:list",
                json!({"forWindow":"ws-2","ptys":[]}),
                Route::EmitTo("ws-2"),
            ),
            ("pty:list", json!({"ptys":[]}), Route::Broadcast),
            ("alert:state", json!({"id":"a"}), Route::EmitTo("main")),
            ("alert:settings", json!({"speech":true}), Route::Broadcast),
            (
                "dor:controlRequest",
                json!({"requestId":"dor-1","surfaceId":"b"}),
                Route::EmitTo("ws-2"),
            ),
            // No Surface named: the caller hands it to the focused window.
            (
                "dor:controlRequest",
                json!({"requestId":"dor-2"}),
                Route::Focused,
            ),
            // A cancel follows the window that took its request; one for a
            // request nobody is holding has nothing to follow.
            (
                "dor:controlCancel",
                json!({"requestId":"dor-7"}),
                Route::EmitTo("ws-2"),
            ),
            (
                "dor:controlCancel",
                json!({"requestId":"dor-2"}),
                Route::Broadcast,
            ),
            // The directory is the union of every window's panes.
            (
                "burrow:ask",
                json!({"burrowRequestId":"ask-1","op":"directory","params":{}}),
                Route::Broadcast,
            ),
            // A surface op names its Surface, and only its owner may answer:
            // `attach` and `resize` mutate the pane they reach.
            (
                "burrow:ask",
                json!({"burrowRequestId":"ask-2","op":"surfaceOp","params":{"surfaceId":"b","op":"attach"}}),
                Route::EmitTo("ws-2"),
            ),
            // A Surface with no PTY here (a browser pane) keeps the fan-out.
            (
                "burrow:ask",
                json!({"burrowRequestId":"ask-3","op":"surfaceOp","params":{"surfaceId":"browser-1"}}),
                Route::Broadcast,
            ),
            ("burrow:result", json!({}), Route::Broadcast),
            ("burrow:event", json!({}), Route::Broadcast),
        ];
        for (event, data, expected) in cases {
            assert_eq!(&route(event, data, &view), expected, "event {event} {data}");
        }
    }

    #[test]
    fn an_unowned_dor_surface_is_an_error_never_a_sibling() {
        let owned = labels(&[("a", "main")]);
        let none = awaiting(&[]);
        let no_dor = HashMap::new();
        let view = RouteView {
            owners: &owned,
            awaiting_replay: &none,
            dor_targets: &no_dor,
        };
        assert_eq!(
            route(
                "dor:controlRequest",
                &json!({"requestId":"dor-9","surfaceId":"gone"}),
                &view
            ),
            Route::UnownedSurface {
                request_id: "dor-9",
                surface_id: "gone"
            }
        );
    }

    #[test]
    fn a_transferring_pty_is_suppressed_until_its_replay() {
        let owned = labels(&[("a", "ws-2")]);
        let held = awaiting(&["a"]);
        let none = awaiting(&[]);
        let no_dor = HashMap::new();
        let suppressed = RouteView {
            owners: &owned,
            awaiting_replay: &held,
            dor_targets: &no_dor,
        };
        assert_eq!(route("pty:data", &json!({"id":"a"}), &suppressed), Route::Drop);
        // The replay itself is never suppressed — it is what is being waited for.
        assert_eq!(
            route("pty:replay", &json!({"id":"a"}), &suppressed),
            Route::EmitTo("ws-2")
        );
        // Once the replay has been emitted the suppression is lifted and live
        // data reaches the new owner, behind the replay it belongs after.
        let released = RouteView {
            owners: &owned,
            awaiting_replay: &none,
            dor_targets: &no_dor,
        };
        assert_eq!(
            route("pty:data", &json!({"id":"a"}), &released),
            Route::EmitTo("ws-2")
        );
    }

    #[test]
    fn a_stale_suppression_with_no_arrival_fails_open() {
        let mut map = HashMap::new();
        let now = Instant::now();
        map.insert("old".to_string(), now - Duration::from_secs(9));
        map.insert("fresh".to_string(), now);
        let swept = sweep_awaiting(&mut map, now, AWAITING_REPLAY_MAX, &HashSet::new());
        assert_eq!(swept, vec!["old".to_string()]);
        assert!(map.contains_key("fresh"));
    }

    /// A cold boot slower than `AWAITING_REPLAY_MAX` must not have its shells
    /// unsilenced into a window that has not resumed them yet: the fail-open is
    /// for suppressions no arrival claims.
    #[test]
    fn the_sweep_never_releases_a_live_arrivals_suppression() {
        let mut map = HashMap::new();
        let now = Instant::now();
        map.insert("arriving".to_string(), now - Duration::from_secs(9));
        map.insert("orphan".to_string(), now - Duration::from_secs(9));
        let mut arrivals = Arrivals::new();
        queue_arrival(&mut arrivals, arrival("w1", "main", "ws-2", &["arriving"]));

        let swept = sweep_awaiting(&mut map, now, AWAITING_REPLAY_MAX, &arrival_ids(&arrivals));
        assert_eq!(swept, vec!["orphan".to_string()]);
        assert!(map.contains_key("arriving"));

        // Its record settled: the suppression is ordinary bookkeeping again.
        take_arrival(&mut arrivals, "w1", "ws-2").unwrap();
        assert_eq!(
            sweep_awaiting(&mut map, now, AWAITING_REPLAY_MAX, &arrival_ids(&arrivals)),
            vec!["arriving".to_string()]
        );
    }

    #[test]
    fn the_next_ws_label_clears_every_live_and_saved_one() {
        assert_eq!(seed_next_ws(["main", "ws-2", "ws-7", "ws-x"]), 8);
        assert_eq!(seed_next_ws(Vec::<String>::new()), 1);
        assert_eq!(seed_next_ws(["main"]), 1);
    }

    #[test]
    fn restorable_labels_put_main_first_and_skip_temps() {
        let labels = restorable_labels([
            "ws-10.json",
            "main.json.tmp",
            "notepad-archive-v1.json",
            "ws-2.json",
            "main.json",
            "ws-2.json.tmp",
        ]);
        assert_eq!(labels, vec!["main", "ws-2", "ws-10"]);
    }

    #[test]
    fn restorable_labels_without_main_still_restore() {
        assert_eq!(restorable_labels(["ws-3.json"]), vec!["ws-3"]);
    }

    #[test]
    fn quit_walks_main_last() {
        assert_eq!(
            quit_order(["main", "ws-2", "ws-5"]),
            vec!["ws-2", "ws-5", "main"]
        );
        assert_eq!(quit_order(["ws-2", "ws-5"]), vec!["ws-2", "ws-5"]);
        assert_eq!(quit_order(["main"]), vec!["main"]);
    }

    fn arrival(workspace_id: &str, from: &str, to: &str, ids: &[&str]) -> Arrival {
        Arrival {
            workspace_id: workspace_id.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            terminal_ids: ids.iter().map(|id| (*id).to_string()).collect(),
            payload: json!({ "workspaceId": workspace_id }),
            queued_at: Instant::now(),
        }
    }

    #[test]
    fn an_expiry_retires_only_the_record_it_was_armed_for() {
        let mut arrivals = Arrivals::new();
        let first = arrival("ws-a", "main", "ws-2", &["t1"]);
        let armed_for = first.queued_at;
        queue_arrival(&mut arrivals, first);

        // Adopted and dropped on the same window again before the watchdog
        // fired: the record now in the queue is the second drop's.
        take_arrival(&mut arrivals, "ws-a", "ws-2");
        let second = arrival("ws-a", "main", "ws-2", &["t1"]);
        assert_ne!(second.queued_at, armed_for);
        queue_arrival(&mut arrivals, second.clone());

        assert_eq!(expire_arrival(&mut arrivals, "ws-a", "ws-2", armed_for), None);
        assert_eq!(arrivals, vec![second.clone()]);
        assert_eq!(
            expire_arrival(&mut arrivals, "ws-a", "ws-2", second.queued_at),
            Some(second)
        );
        assert!(arrivals.is_empty());
    }

    /// A window that has not installed its arrival listener yet is a legal drop
    /// target, so the payload waits for it instead of being emitted into the void
    /// — and it keeps waiting until that window has actually adopted it.
    #[test]
    fn an_arrival_waits_for_its_window_and_settles_only_on_adoption() {
        let mut arrivals = Arrivals::new();
        queue_arrival(&mut arrivals, arrival("w1", "main", "ws-2", &["a"]));
        queue_arrival(&mut arrivals, arrival("w2", "main", "ws-2", &["b"]));
        queue_arrival(&mut arrivals, arrival("w3", "main", "ws-3", &["c"]));

        let ids = |payloads: Vec<JsonValue>| {
            payloads
                .iter()
                .map(|payload| payload["workspaceId"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(arrival_payloads(&arrivals, "ws-2")), vec!["w1", "w2"], "oldest first");
        // Draining does not consume: a webview drains at boot and again when its
        // listener is installed, and neither may lose a Workspace.
        assert_eq!(ids(arrival_payloads(&arrivals, "ws-2")), vec!["w1", "w2"]);
        assert_eq!(arrival_payloads(&arrivals, "nobody").len(), 0);

        // Settling is keyed by Workspace and scoped to the window it arrived in.
        assert_eq!(take_arrival(&mut arrivals, "w1", "main"), None);
        assert_eq!(take_arrival(&mut arrivals, "w1", "ws-2").unwrap().from, "main");
        assert_eq!(ids(arrival_payloads(&arrivals, "ws-2")), vec!["w2"]);
        assert!(!has_arrival(&arrivals, "w1"));
        assert!(has_arrival(&arrivals, "w2"));

        // The target went away: every arrival it will never take comes back, and
        // a sibling's is untouched.
        let lost = take_arrivals_to(&mut arrivals, "ws-2");
        assert_eq!(lost.iter().map(|a| a.workspace_id.as_str()).collect::<Vec<_>>(), vec!["w2"]);
        assert_eq!(lost[0].terminal_ids, vec!["b".to_string()]);
        assert_eq!(ids(arrival_payloads(&arrivals, "ws-3")), vec!["w3"]);
    }

    /// Each arrival names its own shells: two in flight at once must not each
    /// resume over the other's (docs/specs/standalone.md -> "Arrival queue").
    #[test]
    fn arrival_ids_are_per_arrival_not_per_window() {
        let mut arrivals = Arrivals::new();
        queue_arrival(&mut arrivals, arrival("w1", "main", "ws-2", &["a", "a-helper"]));
        queue_arrival(&mut arrivals, arrival("w2", "ws-9", "ws-2", &["b"]));

        assert_eq!(
            find_arrival(&arrivals, "w1").unwrap().terminal_ids,
            vec!["a".to_string(), "a-helper".to_string()]
        );
        assert_eq!(find_arrival(&arrivals, "w2").unwrap().terminal_ids, vec!["b".to_string()]);
        assert_eq!(
            arrival_ids(&arrivals),
            ["a", "a-helper", "b"].iter().map(|id| (*id).to_string()).collect::<HashSet<_>>()
        );
    }

    /// A window booting with a Workspace already queued for it owns those shells
    /// from the source's invoke. Listing them here would place them as top-level
    /// panes beside the Workspace about to mount them.
    #[test]
    fn a_boot_list_never_names_an_arrivals_shells() {
        let owned = || vec!["own-1".to_string(), "a".to_string(), "own-2".to_string()];
        let mut arrivals = Arrivals::new();
        assert_eq!(boot_list_ids(owned(), &arrivals), owned(), "nothing in flight");

        queue_arrival(&mut arrivals, arrival("w1", "main", "ws-2", &["a"]));
        assert_eq!(
            boot_list_ids(owned(), &arrivals),
            vec!["own-1".to_string(), "own-2".to_string()]
        );

        // Adopted: the ids are ordinary panes of this window again.
        take_arrival(&mut arrivals, "w1", "ws-2").unwrap();
        assert_eq!(boot_list_ids(owned(), &arrivals), owned());
    }

    fn rect(label: &str, origin: (i32, i32), size: (u32, u32), hittable: bool) -> WindowRect {
        WindowRect {
            label: label.to_string(),
            origin,
            size,
            scale: 2.0,
            hittable,
        }
    }

    #[test]
    fn the_hit_test_prefers_focus_skips_minimized_and_reports_client_logical_coords() {
        let rects = vec![
            rect("main", (0, 0), (800, 600), true),
            rect("ws-2", (0, 0), (800, 600), true),
            rect("ws-3", (0, 0), (800, 600), false),
        ];
        let hit = window_at(&rects, &["ws-2".into(), "main".into()], (200.0, 100.0)).unwrap();
        assert_eq!(hit.label, "ws-2");
        // Physical screen point -> the hit window's own logical client space.
        assert_eq!((hit.x, hit.y), (100.0, 50.0));

        // Nothing focused that contains the point: the first containing window.
        let hit = window_at(&rects, &["ws-3".into()], (10.0, 10.0)).unwrap();
        assert_eq!(hit.label, "main");

        // Outside every window.
        assert_eq!(window_at(&rects, &[], (5000.0, 10.0)), None);

        // A minimized window alone under the cursor is not a target.
        let only_minimized = vec![rect("ws-3", (0, 0), (800, 600), false)];
        assert_eq!(window_at(&only_minimized, &[], (10.0, 10.0)), None);
    }
}
