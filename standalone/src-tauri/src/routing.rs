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

/// Where one sidecar event goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// To exactly this window label.
    EmitTo(String),
    /// To every window. Correlation is per-adapter random, so a broadcast
    /// reaches the one adapter waiting on it and no other can mistake it
    /// (the argument `docs/specs/vscode.md` -> "Peer surfaces across windows"
    /// makes for its own fan-out).
    Broadcast,
    /// Suppressed: the id is mid-transfer and its bytes are already in the
    /// replay the new owner is about to receive.
    Drop,
    /// A `dor` control request naming a Surface no window owns. Answered with
    /// an error rather than handed to a sibling, which would act on the wrong
    /// terminal (docs/specs/dor-cli.md -> "Control socket").
    UnownedSurface {
        request_id: String,
        surface_id: String,
    },
}

/// The routing table's read-only view of `WindowState`. Borrowed, never
/// copied: this runs once per PTY chunk.
pub struct RouteView<'a> {
    pub owners: &'a HashMap<String, String>,
    /// Ids mid-transfer, each with the instant its suppression began.
    pub awaiting_replay: &'a HashMap<String, Instant>,
    /// Most recently focused window, or none while nothing has been focused.
    pub focused: Option<&'a str>,
}

fn str_field<'a>(data: &'a JsonValue, key: &str) -> Option<&'a str> {
    data.get(key).and_then(JsonValue::as_str)
}

fn owner_route(view: &RouteView, id: &str) -> Route {
    match view.owners.get(id) {
        Some(label) => Route::EmitTo(label.clone()),
        // An id nobody minted is not a routing decision anyone can make; a
        // broadcast is what the single-window build always did.
        None => Route::Broadcast,
    }
}

/// The one decision every sidecar stdout line passes through.
pub fn route(event: &str, data: &JsonValue, view: &RouteView) -> Route {
    match event {
        // Terminal traffic, keyed by the PTY it came from.
        "pty:data" | "terminal:semanticEvents" | "terminal:protocolEvents" => {
            let Some(id) = str_field(data, "id") else {
                return Route::Broadcast;
            };
            if view.awaiting_replay.contains_key(id) {
                return Route::Drop;
            }
            owner_route(view, id)
        }
        // Never suppressed: a replay is exactly what the suppression is waiting
        // for, and the caller lifts the suppression after this emit.
        "pty:exit" | "pty:replay" => {
            let Some(id) = str_field(data, "id") else {
                return Route::Broadcast;
            };
            owner_route(view, id)
        }
        // The list answers one window's `pty:requestInit`, which named itself.
        "pty:list" => match str_field(data, "forWindow") {
            Some(label) => Route::EmitTo(label.to_string()),
            None => Route::Broadcast,
        },
        "dor:controlRequest" => {
            let Some(surface_id) = str_field(data, "surfaceId") else {
                // A request with no Surface (e.g. `dor list`) belongs to
                // whichever window the user is looking at.
                return match view.focused {
                    Some(label) => Route::EmitTo(label.to_string()),
                    None => Route::Broadcast,
                };
            };
            match view.owners.get(surface_id) {
                Some(label) => Route::EmitTo(label.clone()),
                None => Route::UnownedSurface {
                    request_id: str_field(data, "requestId").unwrap_or_default().to_string(),
                    surface_id: surface_id.to_string(),
                },
            }
        }
        // `alert:*` carrying an id is about one Session; the two app-global
        // stores (settings, watched commands) carry none and reach everyone.
        _ if event.starts_with("alert:") => match str_field(data, "id") {
            Some(id) => owner_route(view, id),
            None => Route::Broadcast,
        },
        _ => Route::Broadcast,
    }
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

/// The windows a boot reopens, from the file names in the sessions directory:
/// `main` first, then `ws-<n>` in numeric order. Temps and foreign names are
/// dropped; the caller caps the list and logs what it left behind.
pub fn restorable_labels(file_names: impl IntoIterator<Item = impl AsRef<str>>) -> Vec<String> {
    let mut ws: Vec<(u64, String)> = Vec::new();
    let mut has_main = false;
    for name in file_names {
        let name = name.as_ref();
        // `.json.tmp` also ends with `.tmp`, so strip on the full suffix and a
        // temp never survives to become a label.
        let Some(label) = name.strip_suffix(".json") else {
            continue;
        };
        if label == MAIN_LABEL {
            has_main = true;
        } else if let Some(index) = ws_index(label) {
            ws.push((index, label.to_string()));
        }
    }
    ws.sort_by_key(|(index, _)| *index);
    let mut labels: Vec<String> = Vec::with_capacity(ws.len() + 1);
    if has_main {
        labels.push(MAIN_LABEL.to_string());
    }
    labels.extend(ws.into_iter().map(|(_, label)| label));
    labels
}

/// Teardown order for a quit: `main` last, because it is the only window
/// granted the updater permissions and so the only one that may install.
pub fn quit_order(labels: impl IntoIterator<Item = impl AsRef<str>>) -> Vec<String> {
    let mut order: Vec<String> = Vec::new();
    let mut has_main = false;
    for label in labels {
        if label.as_ref() == MAIN_LABEL {
            has_main = true;
        } else {
            order.push(label.as_ref().to_string());
        }
    }
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

    fn owners(pairs: &[(&str, &str)]) -> HashMap<String, String> {
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
        let owned = owners(&[("a", "main"), ("b", "ws-2")]);
        let none = awaiting(&[]);
        let view = RouteView {
            owners: &owned,
            awaiting_replay: &none,
            focused: Some("ws-2"),
        };
        let cases: &[(&str, JsonValue, Route)] = &[
            ("pty:data", json!({"id":"a"}), Route::EmitTo("main".into())),
            ("pty:data", json!({"id":"b"}), Route::EmitTo("ws-2".into())),
            // An id nobody minted falls back to the single-window behavior.
            ("pty:data", json!({"id":"zz"}), Route::Broadcast),
            (
                "terminal:semanticEvents",
                json!({"id":"b"}),
                Route::EmitTo("ws-2".into()),
            ),
            (
                "terminal:protocolEvents",
                json!({"id":"a"}),
                Route::EmitTo("main".into()),
            ),
            ("pty:exit", json!({"id":"b"}), Route::EmitTo("ws-2".into())),
            ("pty:replay", json!({"id":"a"}), Route::EmitTo("main".into())),
            (
                "pty:list",
                json!({"forWindow":"ws-2","ptys":[]}),
                Route::EmitTo("ws-2".into()),
            ),
            ("pty:list", json!({"ptys":[]}), Route::Broadcast),
            (
                "alert:state",
                json!({"id":"a"}),
                Route::EmitTo("main".into()),
            ),
            ("alert:settings", json!({"speech":true}), Route::Broadcast),
            (
                "dor:controlRequest",
                json!({"requestId":"dor-1","surfaceId":"b"}),
                Route::EmitTo("ws-2".into()),
            ),
            // No Surface named: the focused window answers.
            (
                "dor:controlRequest",
                json!({"requestId":"dor-2"}),
                Route::EmitTo("ws-2".into()),
            ),
            ("dor:controlCancel", json!({"requestId":"dor-2"}), Route::Broadcast),
            ("burrow:ask", json!({"burrowRequestId":"ask-1"}), Route::Broadcast),
            ("burrow:result", json!({}), Route::Broadcast),
            ("burrow:event", json!({}), Route::Broadcast),
        ];
        for (event, data, expected) in cases {
            assert_eq!(&route(event, data, &view), expected, "event {event} {data}");
        }
    }

    #[test]
    fn an_unowned_dor_surface_is_an_error_never_a_sibling() {
        let owned = owners(&[("a", "main")]);
        let none = awaiting(&[]);
        let view = RouteView {
            owners: &owned,
            awaiting_replay: &none,
            focused: Some("main"),
        };
        assert_eq!(
            route(
                "dor:controlRequest",
                &json!({"requestId":"dor-9","surfaceId":"gone"}),
                &view
            ),
            Route::UnownedSurface {
                request_id: "dor-9".into(),
                surface_id: "gone".into()
            }
        );
    }

    #[test]
    fn a_transferring_pty_is_suppressed_until_its_replay() {
        let owned = owners(&[("a", "ws-2")]);
        let held = awaiting(&["a"]);
        let none = awaiting(&[]);
        let suppressed = RouteView {
            owners: &owned,
            awaiting_replay: &held,
            focused: None,
        };
        assert_eq!(route("pty:data", &json!({"id":"a"}), &suppressed), Route::Drop);
        // The replay itself is never suppressed — it is what is being waited for.
        assert_eq!(
            route("pty:replay", &json!({"id":"a"}), &suppressed),
            Route::EmitTo("ws-2".into())
        );
        // Once the replay has been emitted the suppression is lifted and live
        // data reaches the new owner, behind the replay it belongs after.
        let released = RouteView {
            owners: &owned,
            awaiting_replay: &none,
            focused: None,
        };
        assert_eq!(
            route("pty:data", &json!({"id":"a"}), &released),
            Route::EmitTo("ws-2".into())
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
            quit_order(["main", "ws-2", "ws-5"]),
            vec!["ws-2", "ws-5", "main"]
        );
        assert_eq!(quit_order(["ws-2"]), vec!["ws-2"]);
        assert_eq!(quit_order(["main"]), vec!["main"]);
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
