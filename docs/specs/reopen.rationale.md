# Reopen — Rationale

> Informative companion to [reopen.md](reopen.md): the evidence and decisions behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Reopenable kinds

`iframe` browsers are reopenable at their URL, reloaded: a closed browser tab is universally understood to lose its live page, so the table, not losslessness of page state, decides (design session, 2026-10-02). Before this, every browser close confirmed, since a browser has no `untouched` notion.

A touched idle shell is never reopenable, even at lower fidelity: replaying scrollback into a fresh shell looks like the old one while its exports, history, and jobs are gone.

`builtin:code` is the same editor as `builtin:file` but the design's table names only the latter, so it confirms until the table says otherwise. A built-in whose command has ended has left a shell the user may have typed into, which the record would not bring back.

## Labs: No-confirm delayed kill

The countdown is 10 s, pausing on hover and collapsing past 3 entries: long enough to notice a wrong kill, short enough that a pending process does not linger.
