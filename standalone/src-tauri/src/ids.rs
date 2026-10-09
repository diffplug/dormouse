//! The app-wide id counters: Surface numbers (`surface:<n>`), Workspace
//! numbers (`workspace:<n>`), and window labels (`ws-<n>`)
//! (`docs/specs/standalone.md` → "Workspace registry").
//!
//! Each counter's next number persists in `ids.json`. Every reservation hands
//! the caller the file to write before any number in the block is used, so a
//! relaunch starting there never reuses a number whatever closed since, and
//! never skips one it did not hand out: a `dor` user types the number, so
//! numbers stay as dense as the creates behind them. No slack past the block, as a hi/lo
//! ceiling would add: every relaunch's numbering jumped by the slack. The
//! write per reservation is affordable because the webviews reserve a few ids
//! at a time, at the pace of user creates.
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
    pub fn prefix(self) -> &'static str {
        match self {
            Kind::Surface => "surface:",
            Kind::Workspace => "workspace:",
            Kind::Window => crate::routing::WS_LABEL_PREFIX,
        }
    }

    /// The lowest number ever handed out. `workspace:1` is what a bare Wall
    /// calls its only Workspace, and a fresh window minting it would collide
    /// with a snapshot restored under that id.
    fn first(self) -> u64 {
        match self {
            Kind::Workspace => 2,
            Kind::Surface | Kind::Window => 1,
        }
    }

    /// The counter's number in an id of this kind, if it has one.
    pub fn number(self, id: &str) -> Option<u64> {
        numbered(id, self.prefix())
    }

    /// The id of this kind numbered `n`.
    pub fn id(self, n: u64) -> String {
        format!("{}{n}", self.prefix())
    }
}

/// Each kind's lowest number not yet handed out or seen.
#[derive(Debug, Default)]
pub struct Counters {
    surface: u64,
    workspace: u64,
    window: u64,
}

/// The persisted form: each kind's next number, which no number handed out
/// reaches.
#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    version: u64,
    surface: u64,
    workspace: u64,
    window: u64,
}

impl Counters {
    fn next(&mut self, kind: Kind) -> &mut u64 {
        match kind {
            Kind::Surface => &mut self.surface,
            Kind::Workspace => &mut self.workspace,
            Kind::Window => &mut self.window,
        }
    }

    /// Never hand out a number below `next`: every number a previous run left
    /// on disk, or a window reported, sits below it.
    pub fn seed(&mut self, kind: Kind, next: u64) {
        let counter = self.next(kind);
        *counter = (*counter).max(next);
    }

    /// Adopt a persisted file's numbers as starting points: nothing at or
    /// above one was handed out, so starting there reuses nothing.
    pub fn load(&mut self, contents: &str) -> Result<(), String> {
        let file: File = serde_json::from_str(contents).map_err(|e| format!("unreadable {FILE}: {e}"))?;
        if file.version != VERSION {
            return Err(format!("{FILE} has version {}, expected {VERSION}", file.version));
        }
        self.seed(Kind::Surface, file.surface);
        self.seed(Kind::Workspace, file.workspace);
        self.seed(Kind::Window, file.window);
        Ok(())
    }

    /// Hand out `count` numbers of `kind`, all above `above`, with the file
    /// contents that must be written before any number in the block is used.
    pub fn reserve(&mut self, kind: Kind, count: u64, above: u64) -> (Range<u64>, String) {
        let counter = self.next(kind);
        let first = (*counter).max(kind.first()).max(above.saturating_add(1));
        let end = first.saturating_add(count);
        *counter = end;
        (first..end, self.file())
    }

    fn file(&self) -> String {
        serde_json::to_string(&File {
            version: VERSION,
            surface: self.surface,
            workspace: self.workspace,
            window: self.window,
        })
        .expect("plain numbers serialize")
    }
}

/// The digits after `prefix`, if that is all there is.
fn numbered(id: &str, prefix: &str) -> Option<u64> {
    let suffix = id.strip_prefix(prefix)?;
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    suffix.parse().ok()
}

/// The next number of `kind`, above every id given.
pub fn seed_next(kind: Kind, ids: impl IntoIterator<Item = impl AsRef<str>>) -> u64 {
    ids.into_iter()
        .filter_map(|id| kind.number(id.as_ref()))
        .max()
        .map_or(kind.first(), |n| (n + 1).max(kind.first()))
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

    fn persisted(file: &str) -> JsonValue {
        serde_json::from_str(file).unwrap()
    }

    #[test]
    fn ids_are_spelled_with_a_colon_and_only_that_spelling_has_a_number() {
        assert_eq!(Kind::Surface.id(3), "surface:3");
        assert_eq!(Kind::Workspace.id(3), "workspace:3");
        assert_eq!(Kind::Window.id(3), "ws-3");
        assert_eq!(Kind::Surface.number("surface:3"), Some(3));
        assert_eq!(Kind::Surface.number("surface-3"), None);
        assert_eq!(Kind::Workspace.number("workspace-3"), None);
    }

    #[test]
    fn every_block_asks_to_persist_exactly_its_end() {
        let mut counters = Counters::default();
        let (block, file) = counters.reserve(Kind::Workspace, 4, 0);
        assert_eq!(block, 2..6);
        let file = persisted(&file);
        assert_eq!(file["version"], 1);
        assert_eq!(file["workspace"], 6);
        let (block, file) = counters.reserve(Kind::Workspace, 1, 0);
        assert_eq!(block, 6..7);
        assert_eq!(persisted(&file)["workspace"], 7);
    }

    #[test]
    fn a_loaded_file_resumes_where_it_left_off_and_every_write_carries_each_kind() {
        let mut counters = Counters::default();
        counters.load(r#"{"version":1,"surface":500,"workspace":40,"window":9}"#).unwrap();
        let (block, file) = counters.reserve(Kind::Surface, 8, 0);
        assert_eq!(block, 500..508);
        let file = persisted(&file);
        assert_eq!((file["surface"].as_u64(), file["workspace"].as_u64(), file["window"].as_u64()), (Some(508), Some(40), Some(9)));
        assert_eq!(counters.reserve(Kind::Workspace, 4, 0).0, 40..44);
        assert_eq!(counters.reserve(Kind::Window, 1, 0).0, 9..10);
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
            { "id": "workspace:2", "session": {
                "panes": [{ "id": "surface:3" }, { "id": "custom-id" }],
                "doors": [{ "id": "surface:9" }]
            } },
            { "id": "workspace:3", "session": { "panes": [{ "id": "surface:4" }] } },
            { "id": "workspace:4" }
        ] });
        let ids = snapshot_surface_ids(&snapshot);
        assert_eq!(ids, vec!["surface:3", "custom-id", "surface:9", "surface:4"]);
        assert_eq!(seed_next(Kind::Surface, ids), 10);
    }

    #[test]
    fn each_counter_seeds_above_every_id_given_and_never_below_its_first() {
        assert_eq!(seed_next(Kind::Surface, Vec::<String>::new()), 1);
        assert_eq!(seed_next(Kind::Surface, ["surface:", "surface:1a", "surface:+4", "surface-7"]), 1);
        assert_eq!(seed_next(Kind::Window, ["main", "ws-2", "ws-7", "ws-x"]), 8);
        assert_eq!(seed_next(Kind::Window, ["main"]), 1);
        assert_eq!(seed_next(Kind::Workspace, Vec::<String>::new()), 2);
        assert_eq!(seed_next(Kind::Workspace, ["workspace:0", "workspace:1"]), 2);
        assert_eq!(seed_next(Kind::Workspace, ["workspace:3", "workspace:12", "workspace:x", "workspace-40"]), 13);
        // `workspace:1` is a bare Wall's own, even on an empty counter.
        assert_eq!(Counters::default().reserve(Kind::Workspace, 1, 0).0, 2..3);
    }
}
