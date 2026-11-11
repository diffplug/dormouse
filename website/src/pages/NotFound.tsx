/**
 * Every path no other route matches. Prerendered at `/404` and written to
 * `dist/404.html` (scripts/flatten-react-router-build.js), which Cloudflare
 * Pages serves with status 404 for any path it has no file or rule for; the
 * same route renders when that page hydrates at the unknown path, so the
 * client draws what the HTML already shows.
 *
 * **Never** claim a canonical: the page stands in for every unknown path.
 */
import SiteErrorPage from "../components/SiteErrorPage";
import { siteMeta } from "../lib/site-meta";

export function meta() {
  return siteMeta("/404", { title: "Page not found — Dormouse", indexable: false });
}

export default function NotFound() {
  return <SiteErrorPage heading="There is no page here." />;
}
