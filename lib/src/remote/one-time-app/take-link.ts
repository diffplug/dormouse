/**
 * What the one-time page does with the fragment it arrived with, before
 * anything renders (`docs/specs/one-time.md` -> "Phone page").
 */

/**
 * The whole URL the page arrived at, and the fragment erased from the address
 * bar; `null` where there was no fragment.
 *
 * **Taken once, then erased unconditionally.** The fragment is the link — its
 * room and the computer's one-use key — so an address bar, a history entry, and
 * a screenshot are no place for it whether or not it parses. The page parses
 * the returned text itself, and holds it in memory only.
 */
export function takeOneTimeLinkUrl(): string | null {
  const { hash, href, pathname, search } = window.location;
  if (hash === '') return null;
  window.history.replaceState(null, '', `${pathname}${search}`);
  return href;
}

/**
 * Reload when the fragment changes under a running page. A link opened in the
 * tab already showing this page differs from it only after `#`, which the
 * browser treats as a same-page jump: no load, so nothing would take it — the
 * page would stay on its last screen with the new link sitting in the address
 * bar. A reload takes and erases it as the first load did. `replaceState`
 * fires no `hashchange`, so the page's own erase never triggers this.
 */
export function reloadOnNewLink(reload: () => void = () => window.location.reload()): void {
  window.addEventListener('hashchange', () => reload());
}
