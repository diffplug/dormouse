//! Which window a sidecar event belongs to, and the label bookkeeping around it.
//!
//! The sidecar has no window concept: it emits one stream of events for every
//! PTY in the process. Rust owns the map from PTY to window
//! (docs/specs/standalone.md -> "Windows"), and everything here is pure so the
//! whole table can be exercised without a Tauri app.

use serde::Serialize;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
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

/// Workspaces on their way into a window, oldest first.
///
/// **Held rather than emitted**: a window that has not installed its arrival
/// listener yet — one still booting, or one torn out moments ago — is a legal
/// drop target, and an `emit_to` it would simply be lost. The target drains the
/// queue when it is ready (docs/specs/standalone.md -> "Arrival queue").
pub type ArrivalQueues = HashMap<String, Vec<JsonValue>>;

pub fn queue_arrival(queues: &mut ArrivalQueues, label: &str, payload: JsonValue) {
    queues.entry(label.to_string()).or_default().push(payload);
}

/// Everything queued for `label`, removing it: an arrival is delivered once.
pub fn take_arrivals(queues: &mut ArrivalQueues, label: &str) -> Vec<JsonValue> {
    queues.remove(label).unwrap_or_default()
}

/// Release every suppression older than `max`, returning what was released.
///
/// Fail open: a transfer whose `adopt_ready` never arrived would otherwise
/// silence its panes for the rest of the session.
pub fn sweep_awaiting(
    map: &mut HashMap<String, Instant>,
    now: Instant,
    max: Duration,
) -> Vec<String> {
    // The steady state: nothing is transferring, so this costs one branch.
    if map.is_empty() {
        return Vec::new();
    }
    let stale: Vec<String> = map
        .iter()
        .filter(|(_, at)| now.duration_since(**at) >= max)
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

/// Teardown order for a quit: **`main` last if it is still open, else the most
/// recently focused window** — the last window standing is the one that installs
/// a pending update, and a session whose `main` was closed must still be able to
/// (docs/specs/auto-update.md).
pub fn quit_order(
    labels: impl IntoIterator<Item = impl AsRef<str>>,
    focused: Option<&str>,
) -> Vec<String> {
    let (has_main, mut order) = partition_main(labels);
    if has_main {
        order.push(MAIN_LABEL.to_string());
        return order;
    }
    if let Some(position) = focused.and_then(|label| order.iter().position(|entry| entry == label)) {
        let last = order.remove(position);
        order.push(last);
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
    fn a_stale_suppression_fails_open() {
        let mut map = HashMap::new();
        let now = Instant::now();
        map.insert("old".to_string(), now - Duration::from_secs(9));
        map.insert("fresh".to_string(), now);
        let swept = sweep_awaiting(&mut map, now, AWAITING_REPLAY_MAX);
        assert_eq!(swept, vec!["old".to_string()]);
        assert!(map.contains_key("fresh"));
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
            quit_order(["main", "ws-2", "ws-5"], Some("ws-5")),
            vec!["ws-2", "ws-5", "main"]
        );
        assert_eq!(quit_order(["ws-2"], None), vec!["ws-2"]);
        assert_eq!(quit_order(["main"], None), vec!["main"]);
    }

    /// A session whose `main` was closed still has a last window, and that one
    /// installs a pending update (docs/specs/auto-update.md).
    #[test]
    fn quit_without_main_walks_the_focused_window_last() {
        assert_eq!(
            quit_order(["ws-2", "ws-5", "ws-7"], Some("ws-5")),
            vec!["ws-2", "ws-7", "ws-5"]
        );
        // Nothing focused, or a stale label: the order given stands.
        assert_eq!(
            quit_order(["ws-2", "ws-5"], Some("ws-9")),
            vec!["ws-2", "ws-5"]
        );
        assert_eq!(quit_order(["ws-2", "ws-5"], None), vec!["ws-2", "ws-5"]);
    }

    /// A window that has not installed its arrival listener yet is a legal drop
    /// target, so the payload waits for it instead of being emitted into the void.
    #[test]
    fn an_arrival_queued_before_the_listener_exists_is_delivered_once() {
        let mut queues = ArrivalQueues::new();
        queue_arrival(&mut queues, "ws-2", json!({"workspaceId":"w1"}));
        queue_arrival(&mut queues, "ws-2", json!({"workspaceId":"w2"}));
        queue_arrival(&mut queues, "ws-3", json!({"workspaceId":"w3"}));

        let taken = take_arrivals(&mut queues, "ws-2");
        assert_eq!(
            taken.iter().map(|p| p["workspaceId"].as_str().unwrap()).collect::<Vec<_>>(),
            vec!["w1", "w2"],
            "queued oldest first"
        );
        // Delivered once: a reload boots from the snapshot it has since written.
        assert!(take_arrivals(&mut queues, "ws-2").is_empty());
        // A sibling's queue is untouched, and an unknown window has none.
        assert_eq!(take_arrivals(&mut queues, "ws-3").len(), 1);
        assert!(take_arrivals(&mut queues, "nobody").is_empty());
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
