//! The app-wide id counters: Surface numbers (`surface-<n>`), Workspace
//! numbers (`workspace-<n>`), and window labels (`ws-<n>`)
//! (`docs/specs/standalone.md` → "Workspace registry").
//!
//! Each counter keeps a durable ceiling in `ids.json` that no handed-out
//! number has reached. A reservation that would reach it first raises it by a
//! slack and hands the caller the file to write, so the file is written once
//! per slack's worth of numbers, and a relaunch starting at the ceiling never
//! reuses a number whatever closed since the last write.
//!
//! Pure over its own state, like `workspaces`; `lib.rs` holds the lock and
//! writes the file.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::ops::Range;

/// The file under the state root, beside the sessions directory, never in it.
pub const FILE: &str = "ids.json";

const VERSION: u64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Surface,
    Workspace,
    Window,
}

impl Kind {
    /// How far past a reservation a ceiling raise reaches, sized to how often
    /// each kind is minted.
    fn slack(self) -> u64 {
        match self {
            Kind::Surface => 1024,
            Kind::Workspace => 64,
            Kind::Window => 16,
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Counter {
    /// The lowest number not yet handed out or seen.
    next: u64,
    /// No number handed out reaches this; persisted before one would.
    ceiling: u64,
}

#[derive(Debug, Default)]
pub struct Counters {
    surface: Counter,
    workspace: Counter,
    window: Counter,
}

/// The persisted form: each kind's ceiling.
#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    version: u64,
    surface: u64,
    workspace: u64,
    window: u64,
}

impl Counters {
    fn counter(&mut self, kind: Kind) -> &mut Counter {
        match kind {
            Kind::Surface => &mut self.surface,
            Kind::Workspace => &mut self.workspace,
            Kind::Window => &mut self.window,
        }
    }

    /// Never hand out a number below `next`: every number a previous run left
    /// on disk, or a window reported, sits below it.
    pub fn seed(&mut self, kind: Kind, next: u64) {
        let counter = self.counter(kind);
        counter.next = counter.next.max(next);
    }

    /// Adopt a persisted file's ceilings as starting points: nothing at or
    /// above one was handed out, so starting there reuses nothing.
    pub fn load(&mut self, contents: &str) -> Result<(), String> {
        let file: File = serde_json::from_str(contents).map_err(|e| format!("unreadable {FILE}: {e}"))?;
        if file.version != VERSION {
            return Err(format!("{FILE} has version {}, expected {VERSION}", file.version));
        }
        for (kind, ceiling) in [
            (Kind::Surface, file.surface),
            (Kind::Workspace, file.workspace),
            (Kind::Window, file.window),
        ] {
            let counter = self.counter(kind);
            counter.next = counter.next.max(ceiling);
            counter.ceiling = counter.ceiling.max(ceiling);
        }
        Ok(())
    }

    /// Hand out `count` numbers of `kind`, all above `above`. When the block
    /// reaches the ceiling, the ceiling rises and the returned file contents
    /// must be written before any number in the block is used.
    pub fn reserve(&mut self, kind: Kind, count: u64, above: u64) -> (Range<u64>, Option<String>) {
        let counter = self.counter(kind);
        let first = counter.next.max(above.saturating_add(1));
        let end = first.saturating_add(count);
        counter.next = end;
        if end <= counter.ceiling {
            return (first..end, None);
        }
        counter.ceiling = end.saturating_add(kind.slack());
        (first..end, Some(self.file()))
    }

    fn file(&self) -> String {
        serde_json::to_string(&File {
            version: VERSION,
            surface: self.surface.ceiling,
            workspace: self.workspace.ceiling,
            window: self.window.ceiling,
        })
        .expect("plain numbers serialize")
    }
}

/// The digits after `prefix`, if that is all there is.
pub fn numbered(id: &str, prefix: &str) -> Option<u64> {
    let suffix = id.strip_prefix(prefix)?;
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    suffix.parse().ok()
}

/// The counter's number in a `surface-<n>` id, if it has one.
pub fn surface_number(id: &str) -> Option<u64> {
    numbered(id, "surface-")
}

/// The next Surface number, above every id given.
pub fn seed_next_surface(ids: impl IntoIterator<Item = impl AsRef<str>>) -> u64 {
    ids.into_iter()
        .filter_map(|id| surface_number(id.as_ref()))
        .max()
        .map_or(1, |n| n + 1)
}

/// Every Surface id a persisted Session names: its panes and its doors.
pub fn session_surface_ids(session: &JsonValue) -> Vec<String> {
    ["panes", "doors"]
        .into_iter()
        .filter_map(|field| session.get(field).and_then(JsonValue::as_array))
        .flatten()
        .filter_map(|surface| surface.get("id").and_then(JsonValue::as_str))
        .map(str::to_string)
        .collect()
}

/// Every Surface id a persisted window snapshot names, across its Workspaces.
pub fn snapshot_surface_ids(snapshot: &JsonValue) -> Vec<String> {
    snapshot
        .get("workspaces")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(|workspace| workspace.get("session"))
        .flat_map(session_surface_ids)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ceilings(file: &str) -> JsonValue {
        serde_json::from_str(file).unwrap()
    }

    #[test]
    fn a_block_reaching_the_ceiling_raises_it_past_the_block_and_asks_for_a_write() {
        let mut counters = Counters::default();
        let (block, file) = counters.reserve(Kind::Workspace, 64, 1);
        assert_eq!(block, 2..66);
        let file = ceilings(&file.expect("the first block reaches the zero ceiling"));
        assert_eq!(file["version"], 1);
        assert_eq!(file["workspace"], 66 + 64);
        // Below the raised ceiling: no write.
        assert_eq!(counters.reserve(Kind::Workspace, 64, 1), (66..130, None));
        let (block, file) = counters.reserve(Kind::Workspace, 1, 1);
        assert_eq!(block, 130..131);
        assert_eq!(ceilings(&file.unwrap())["workspace"], 131 + 64);
    }

    #[test]
    fn a_relaunch_starts_at_the_persisted_ceiling() {
        let mut counters = Counters::default();
        counters.load(r#"{"version":1,"surface":2000,"workspace":10,"window":7}"#).unwrap();
        // The disk only names lower numbers: the highest ones closed.
        counters.seed(Kind::Workspace, 6);
        counters.seed(Kind::Window, 3);
        assert_eq!(counters.reserve(Kind::Workspace, 1, 1).0, 10..11);
        assert_eq!(counters.reserve(Kind::Window, 1, 0).0, 7..8);
        assert_eq!(counters.reserve(Kind::Surface, 1, 0).0, 2000..2001);
    }

    #[test]
    fn seeding_never_lowers_a_counter() {
        let mut counters = Counters::default();
        counters.reserve(Kind::Surface, 20, 0);
        counters.seed(Kind::Surface, 5);
        assert_eq!(counters.reserve(Kind::Surface, 1, 0).0, 21..22);
        counters.seed(Kind::Surface, 40);
        assert_eq!(counters.reserve(Kind::Surface, 1, 0).0, 40..41);
    }

    #[test]
    fn a_floor_lifts_the_block_above_it() {
        let mut counters = Counters::default();
        assert_eq!(counters.reserve(Kind::Surface, 2, 500).0, 501..503);
        // A lower floor later never moves the counter back.
        assert_eq!(counters.reserve(Kind::Surface, 1, 3).0, 503..504);
    }

    #[test]
    fn an_unreadable_or_foreign_file_loads_nothing() {
        let mut counters = Counters::default();
        assert!(counters.load("{not json").is_err());
        assert!(counters.load(r#"{"version":2,"surface":9,"workspace":9,"window":9}"#).is_err());
        assert_eq!(counters.reserve(Kind::Window, 1, 0).0, 1..2);
    }

    #[test]
    fn surface_ids_come_from_panes_and_doors() {
        let snapshot = json!({ "workspaces": [
            { "id": "workspace-2", "session": {
                "panes": [{ "id": "surface-3" }, { "id": "custom-id" }],
                "doors": [{ "id": "surface-9" }]
            } },
            { "id": "workspace-3", "session": { "panes": [{ "id": "surface-4" }] } },
            { "id": "workspace-4" }
        ] });
        let ids = snapshot_surface_ids(&snapshot);
        assert_eq!(ids, vec!["surface-3", "custom-id", "surface-9", "surface-4"]);
        assert_eq!(seed_next_surface(ids), 10);
        assert_eq!(seed_next_surface(Vec::<String>::new()), 1);
        assert_eq!(surface_number("surface-"), None);
        assert_eq!(surface_number("surface-1a"), None);
    }
}
