/**
 * `/changelog/after/:version` — the changelog filtered to releases newer than
 * the one a reader already has. `standalone/src/updater.ts` opens it after an
 * update, so it is the changelog URL most readers actually arrive on.
 *
 * **Must** carry its own `meta`. Re-exporting only the component left the route
 * with none, so it showed the SPA fallback's homepage title.
 *
 * **Never** claim a canonical here. This route is served by rewriting to
 * `__spa-fallback.html`, whose static head already carries the homepage's
 * `canonical` and `og:url`; React Router appends rather than replaces, so a
 * second canonical would leave two conflicting ones. A per-installed-version
 * view of one page does not belong in a search index anyway, so it asks not to
 * be indexed and makes no index claim — `/changelog` is the page to find.
 */
import { siteMeta } from "../lib/site-meta";
import { CHANGELOG_META } from "./Changelog";

export { default } from "./Changelog";

export function meta() {
  return siteMeta("/changelog", { ...CHANGELOG_META, indexable: false });
}
