import { IS_MAC } from '../../../lib/platform';

/** Copy/cut chord: `⌘` on macOS, `Ctrl` elsewhere. macOS keeps the clean
 *  separation where `Ctrl+C` stays the running program's interrupt
 *  (`docs/specs/mouse-and-clipboard.md` §4.2). */
export function hasCopyModifier(e: KeyboardEvent): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

/** Paste chord: either modifier on every platform, matching VS Code's terminal
 *  and the muscle memory of users coming from Linux/Windows (§8.2). */
export function hasPasteModifier(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey;
}
