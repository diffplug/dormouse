//! The application-wide Workspace registry: which window holds which Workspace,
//! under what id (`docs/specs/standalone.md` → "Workspace registry").
//!
//! Each webview owns its own Workspace list (`lib/src/lib/workspace-store.ts`)
//! and reports it here on every change; this is the one place that sees every
//! window's, which is what a `dor` request naming a sibling window's Workspace
//! routes through. Ids are minted only here — `workspace:<n>` from one counter
//! seeded above every id on disk — so an id never renumbers and never collides
//! across windows.
//!
//! Pure over its own state, like `routing`; `lib.rs` holds the lock and emits.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;

/// One Workspace as its window reported it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Default)]
pub struct Registry {
    /// Window label → its Workspaces in strip order.
    pub windows: HashMap<String, Vec<Entry>>,
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

/// Record what `label` holds now.
pub fn report(registry: &mut Registry, label: &str, entries: Vec<Entry>) {
    registry.windows.insert(label.to_string(), entries);
}

/// A window is gone, and with it everything it held.
pub fn forget_window(registry: &mut Registry, label: &str) {
    registry.windows.remove(label);
}

/// What a `dor` target names: the Workspace id it spells, prefix restored,
/// and the name it reads as unless it reads as a number. Mirrors
/// `parseWorkspaceRef` in `dor/src/protocol.ts`, `NUMERIC_WORKSPACE_REF` included:
/// a number is a digit run with no leading zero, so a Workspace named "007"
/// stays a name rather than routing as `workspace:7`.
fn parse_target(target: &str) -> (String, Option<&str>) {
    let prefix = crate::ids::Kind::Workspace.prefix();
    let trimmed = target.trim();
    let bare = trimmed.strip_prefix(prefix).unwrap_or(trimmed).trim();
    let numeric = !bare.is_empty() && !bare.starts_with('0') && bare.bytes().all(|b| b.is_ascii_digit());
    (format!("{prefix}{bare}"), (!numeric).then_some(bare))
}

/// The window holding the Workspace a `dor` target names, or `None` when no
/// window reports one — or when a name is ambiguous across windows, which
/// falls through to the caller's own window: it refuses a name duplicated
/// there, and otherwise resolves its own, so a local Workspace wins.
pub fn window_of<'a>(registry: &'a Registry, target: &str) -> Option<&'a str> {
    let (id, name) = parse_target(target);
    // Exact ids win over mutable names in every window.
    if let Some((label, _)) = registry.windows.iter().find(|(_, entries)| entries.iter().any(|entry| entry.id == id)) {
        return Some(label.as_str());
    }
    let name = name?;
    let mut holders = registry.windows.iter().filter_map(|(label, entries)| {
        entries
            .iter()
            .any(|entry| entry.name == name)
            .then_some(label.as_str())
    });
    let first = holders.next()?;
    holders.next().is_none().then_some(first)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, name: &str) -> Entry {
        Entry {
            id: id.to_string(),
            name: name.to_string(),
        }
    }

    #[test]
    fn a_snapshot_names_its_workspace_ids() {
        let ids = snapshot_ids(&json!({
            "workspaces": [{ "id": "workspace:4" }, { "id": "workspace:9", "name": "n" }, { "name": "no id" }]
        }));
        assert_eq!(ids, vec!["workspace:4", "workspace:9"]);
    }

    #[test]
    fn a_closed_window_routes_nothing() {
        let mut registry = Registry::default();
        report(&mut registry, "ws-2", vec![entry("workspace:2", "A")]);
        assert_eq!(window_of(&registry, "workspace:2"), Some("ws-2"));
        forget_window(&mut registry, "ws-2");
        assert_eq!(window_of(&registry, "workspace:2"), None);
    }

    #[test]
    fn a_target_routes_to_the_window_holding_it() {
        let mut registry = Registry::default();
        report(
            &mut registry,
            "main",
            vec![entry("workspace:2", "Build"), entry("workspace:5", "Docs")],
        );
        report(
            &mut registry,
            "ws-2",
            vec![entry("workspace:3", "Build")],
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
    fn an_exact_id_routes_before_a_name_and_never_as_a_position() {
        let mut registry = Registry::default();
        report(&mut registry, "main", vec![entry("workspace:abc", "2"), entry("workspace:def", "2")]);
        report(&mut registry, "ws-2", vec![entry("workspace:2", "abc")]);
        assert_eq!(window_of(&registry, "workspace:abc"), Some("main"));
        assert_eq!(window_of(&registry, "def"), Some("main"));
        assert_eq!(window_of(&registry, "workspace:2"), Some("ws-2"));
        // The retired spelling names nothing.
        assert_eq!(window_of(&registry, "workspace-2"), None);
    }

    #[test]
    fn a_number_with_a_leading_zero_is_a_name() {
        let mut registry = Registry::default();
        report(
            &mut registry,
            "main",
            vec![entry("workspace:7", "Build"), entry("workspace:8", "0")],
        );
        report(&mut registry, "ws-2", vec![entry("workspace:9", "007")]);
        // `NUMERIC_WORKSPACE_REF` reads neither as a number, so each routes to
        // the window holding the Workspace so named, never to `workspace:7`.
        assert_eq!(window_of(&registry, "007"), Some("ws-2"));
        assert_eq!(window_of(&registry, "workspace:007"), Some("ws-2"));
        assert_eq!(window_of(&registry, "0"), Some("main"));
        assert_eq!(window_of(&registry, "+7"), None);
        assert_eq!(window_of(&registry, "7"), Some("main"));
    }
}
