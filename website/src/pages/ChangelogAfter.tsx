/**
 * `/changelog/after/:version` — the changelog filtered to releases newer than
 * the one a reader already has. `standalone/src/updater.ts` opens it after an
 * update, so it is the changelog URL most readers actually arrive on.
 *
 * **Must** carry its own `meta`. Re-exporting only the component left the route
 * with none, so the SPA fallback's head shipped unchanged: every such URL
 * advertised the homepage's title and `canonical`, which is the duplicate-page
 * signal the rest of the site was fixed to stop sending.
 *
 * Canonical is `/changelog`, not this path: these are filtered views of one
 * page, and self-canonicalizing them would offer search engines a distinct
 * document per released version.
 */
import { siteMeta } from "../lib/site-meta";
import { CHANGELOG_META } from "./Changelog";

export { default } from "./Changelog";

export function meta() {
  return siteMeta("/changelog", CHANGELOG_META);
}
