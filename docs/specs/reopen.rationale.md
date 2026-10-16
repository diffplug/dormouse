# Reopen — Rationale

> Informative companion to [reopen.md](reopen.md): the evidence and decisions behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Reopenable kinds

`iframe` browsers are reopenable at their URL, reloaded: a closed browser tab is universally understood to lose its live page, so the table, not losslessness of page state, decides (design session, 2026-10-02). Before this, every browser close confirmed, since a browser has no `untouched` notion.

A touched idle shell is never reopenable, even at lower fidelity: replaying scrollback into a fresh shell looks like the old one while its exports, history, and jobs are gone.

`builtin:code` is the same editor as `builtin:file` but the design's table names only the latter, so it confirms until the table says otherwise. A built-in whose command has ended has left a shell the user may have typed into, which the record would not bring back.

## Workspaces and windows

The ids are remapped when a window reopens, not when it closes: reserving a whole window's ids at close put a host round trip and a flushed write in front of every close, and burned numbers for a Reopen that rarely comes. The fresh ids are saved at once because a reload that read the closed window's ids again would remap over the Sessions the first boot started.

## Labs: No-confirm delayed kill

The countdown is 10 s (`PENDING_KILL_MS`), holding on hover, and the stack collapses past 3 entries (`SHOWN`): long enough to notice a wrong kill, short enough that a pending process does not linger (design session, 2026-10-02).
