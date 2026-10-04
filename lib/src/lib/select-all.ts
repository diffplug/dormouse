import { IS_MAC } from './platform';

/** ⌘A on macOS (docs/specs/mouse-and-clipboard.md → "3.9 Select All"). */
export function isMacSelectAll(e: KeyboardEvent): boolean {
  return IS_MAC && e.type === 'keydown' && e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'a';
}
