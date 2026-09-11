//! The application-wide Workspace registry: which window holds which Workspace,
//! under what stable ref (`docs/specs/standalone.md` → "Workspace registry").
//!
//! Each webview owns its own Workspace list (`lib/src/lib/workspace-store.ts`)
//! and reports it here on every change; this is the one place that sees every
//! window's, which is what a `dor` request naming a sibling window's Workspace
//! routes through. Ids are minted only here — `workspace-<n>` from one counter
//! seeded above every id on disk — so a ref never renumbers and never collides
//! across windows.
//!
//! Pure over its own state, like `routing`; `lib.rs` holds the lock and emits.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::collections::HashMap;

/// One Workspace as its window reported it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub active: bool,
}

#[derive(Debug, Default)]
pub struct Registry {
    /// Bumped on every change a window reports; the snapshot carries it so a
    /// webview drops one that arrives behind a newer one.
    pub revision: u64,
    /// Window label → its Workspaces in strip order.
    pub windows: HashMap<String, Vec<Entry>>,
}

/// The counter's suffix of a `workspace-<n>` id, if it has one. Ids minted
/// elsewhere (a bare Wall's `workspace-1`, a pre-registry random id) carry no
/// stable ref and are addressed by name or position instead.
pub fn ref_number(id: &str) -> Option<u64> {
    id.strip_prefix("workspace-")?.parse().ok()
}

/// The stable `dor` ref of an id, when it has one.
pub fn ref_for(id: &str) -> Option<String> {
    ref_number(id).map(|n| format!("workspace:{n}"))
}

/// The next counter value, above every id given. Never below 2: `workspace-1`
/// is what a bare Wall calls its only Workspace, and a fresh window minting it
/// would collide with a snapshot restored under that id.
pub fn seed_next(ids: impl IntoIterator<Item = impl AsRef<str>>) -> u64 {
    ids.into_iter()
        .filter_map(|id| ref_number(id.as_ref()))
        .max()
        .map_or(2, |n| n.max(1) + 1)
}

/// Every Workspace id a persisted window snapshot names.
pub fn snapshot_ids(snapshot: &JsonValue) -> Vec<String> {
    snapshot
        .get("workspaces")
        .and_then(JsonValue::as_array)
        .map(|workspaces| {
            workspaces
                .iter()
                .filter_map(|workspace| workspace.get("id").and_then(JsonValue::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Record what `label` holds now. Returns whether anything changed, which is
/// when the caller broadcasts.
pub fn report(registry: &mut Registry, label: &str, entries: Vec<Entry>) -> bool {
    if registry.windows.get(label) == Some(&entries) {
        return false;
    }
    registry.windows.insert(label.to_string(), entries);
    registry.revision += 1;
    true
}

/// A window is gone, and with it everything it held.
pub fn forget_window(registry: &mut Registry, label: &str) -> bool {
    if registry.windows.remove(label).is_none() {
        return false;
    }
    registry.revision += 1;
    true
}

/// What a `dor` target names: `workspace:<n>` or bare `<n>` is a stable ref;
/// anything else is a name.
enum Target<'a> {
    Number(u64),
    Name(&'a str),
}

fn parse_target(target: &str) -> Target<'_> {
    let bare = target
        .trim()
        .strip_prefix("workspace:")
        .unwrap_or(target.trim())
        .trim();
    // Mirrors `POSITIONAL_WORKSPACE_REF` in `dor/src/protocol.ts`: a ref is a
    // digit run with no leading zero, so a Workspace named "007" stays a name
    // rather than routing as `workspace:7`.
    match bare.parse::<u64>() {
        Ok(n) if !bare.starts_with('0') && bare.bytes().all(|b| b.is_ascii_digit()) => Target::Number(n),
        _ => Target::Name(bare),
    }
}

/// The window holding the Workspace a `dor` target names, or `None` when no
/// window reports one — or when a name is ambiguous across windows, which
/// falls through to the caller's own window: it refuses a name duplicated
/// there, and otherwise resolves its own, so a local Workspace wins.
pub fn window_of<'a>(registry: &'a Registry, target: &str) -> Option<&'a str> {
    match parse_target(target) {
        Target::Number(n) => registry.windows.iter().find_map(|(label, entries)| {
            entries
                .iter()
                .any(|entry| ref_number(&entry.id) == Some(n))
                .then_some(label.as_str())
        }),
        Target::Name(name) => {
            let mut holders = registry.windows.iter().filter_map(|(label, entries)| {
                entries
                    .iter()
                    .any(|entry| entry.name == name)
                    .then_some(label.as_str())
            });
            let first = holders.next()?;
            holders.next().is_none().then_some(first)
        }
    }
}

/// What every webview receives after a change, ordered by label so the strip
/// menus and `dor list` agree across windows.
pub fn snapshot(registry: &Registry) -> JsonValue {
    let mut labels: Vec<&String> = registry.windows.keys().collect();
    labels.sort();
    json!({
        "revision": registry.revision,
        "windows": labels.iter().map(|label| json!({
            "label": label,
            "workspaces": registry.windows[*label].iter().map(|entry| json!({
                "id": entry.id,
                "ref": ref_for(&entry.id),
                "name": entry.name,
                "active": entry.active,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, name: &str, active: bool) -> Entry {
        Entry {
            id: id.to_string(),
            name: name.to_string(),
            active,
        }
    }

    #[test]
    fn refs_come_from_the_id_and_never_from_position() {
        assert_eq!(ref_for("workspace-7"), Some("workspace:7".to_string()));
        assert_eq!(ref_for("workspace-abc12345-3"), None);
        assert_eq!(ref_for("workspace-"), None);
    }

    #[test]
    fn the_counter_seeds_above_every_id_on_disk_and_never_mints_one() {
        assert_eq!(seed_next(Vec::<String>::new()), 2);
        assert_eq!(seed_next(["workspace-1"]), 2);
        assert_eq!(seed_next(["workspace-3", "workspace-12", "workspace-x"]), 13);
        let ids = snapshot_ids(&json!({
            "workspaces": [{ "id": "workspace-4" }, { "id": "workspace-9", "name": "n" }, { "name": "no id" }]
        }));
        assert_eq!(ids, vec!["workspace-4", "workspace-9"]);
        assert_eq!(seed_next(ids), 10);
    }

    #[test]
    fn a_report_bumps_the_revision_only_when_something_changed() {
        let mut registry = Registry::default();
        assert!(report(&mut registry, "main", vec![entry("workspace-2", "A", true)]));
        assert_eq!(registry.revision, 1);
        assert!(!report(&mut registry, "main", vec![entry("workspace-2", "A", true)]));
        assert_eq!(registry.revision, 1);
        assert!(report(&mut registry, "main", vec![entry("workspace-2", "B", true)]));
        assert_eq!(registry.revision, 2);
        assert!(forget_window(&mut registry, "main"));
        assert!(!forget_window(&mut registry, "main"));
        assert_eq!(registry.revision, 3);
    }

    #[test]
    fn a_target_routes_to_the_window_holding_it() {
        let mut registry = Registry::default();
        report(
            &mut registry,
            "main",
            vec![entry("workspace-2", "Build", true), entry("workspace-5", "Docs", false)],
        );
        report(
            &mut registry,
            "ws-2",
            vec![entry("workspace-3", "Build", true)],
        );
        assert_eq!(window_of(&registry, "workspace:5"), Some("main"));
        assert_eq!(window_of(&registry, " 3 "), Some("ws-2"));
        assert_eq!(window_of(&registry, "Docs"), Some("main"));
        assert_eq!(window_of(&registry, "workspace:Docs"), Some("main"));
        // A name two windows use names nothing here: it falls through to the
        // caller's window, which refuses a duplicate of its own and otherwise
        // resolves its own, so a local Workspace wins.
        assert_eq!(window_of(&registry, "Build"), None);
        assert_eq!(window_of(&registry, "workspace:9"), None);
        assert_eq!(window_of(&registry, "nope"), None);
    }

    #[test]
    fn a_number_with_a_leading_zero_is_a_name() {
        let mut registry = Registry::default();
        report(
            &mut registry,
            "main",
            vec![entry("workspace-7", "Build", true), entry("workspace-8", "0", false)],
        );
        report(&mut registry, "ws-2", vec![entry("workspace-9", "007", true)]);
        // `POSITIONAL_WORKSPACE_REF` reads neither as a ref, so each routes to
        // the window holding the Workspace so named, never to `workspace-7`.
        assert_eq!(window_of(&registry, "007"), Some("ws-2"));
        assert_eq!(window_of(&registry, "workspace:007"), Some("ws-2"));
        assert_eq!(window_of(&registry, "0"), Some("main"));
        assert_eq!(window_of(&registry, "+7"), None);
        assert_eq!(window_of(&registry, "7"), Some("main"));
    }

    #[test]
    fn the_snapshot_orders_windows_by_label_and_carries_refs() {
        let mut registry = Registry::default();
        report(&mut registry, "ws-2", vec![entry("workspace-3", "B", true)]);
        report(&mut registry, "main", vec![entry("workspace-2", "A", true)]);
        let snapshot = snapshot(&registry);
        assert_eq!(snapshot["revision"], 2);
        assert_eq!(snapshot["windows"][0]["label"], "main");
        assert_eq!(snapshot["windows"][0]["workspaces"][0]["ref"], "workspace:2");
        assert_eq!(snapshot["windows"][1]["label"], "ws-2");
        assert_eq!(snapshot["windows"][1]["workspaces"][0]["active"], true);
    }
}
