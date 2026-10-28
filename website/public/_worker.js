/**
 * The site's one server-side route: `/ingest/*`, the first-party path visit
 * analytics send to, forwarded to PostHog's US Cloud. `_routes.json` beside it
 * limits this Worker to that path, so every other request is the static site
 * with `_redirects` as before (docs/specs/website-docs.md -> "Visit
 * analytics").
 *
 * Cloudflare Pages runs this file from the build output in advanced mode, so
 * it works whatever directory the Pages project builds from; it is plain
 * JavaScript because Pages reads no `_worker.ts`. The shape follows PostHog's
 * Cloudflare reverse-proxy guide: assets (`/static/`, `/array/`) from the
 * assets host, everything else to the ingestion host, cookies and
 * authorization dropped, and the visitor's address passed on as
 * `X-Forwarded-For`, without which every visitor would hash to Cloudflare's.
 */

export const INGEST_PREFIX = "/ingest";
const API_HOST = "us.i.posthog.com";
const ASSET_HOST = "us-assets.i.posthog.com";

/** Where a request under `/ingest` goes upstream, or null for any other path. */
export function upstreamUrl(requestUrl) {
  const url = new URL(requestUrl);
  if (url.pathname !== INGEST_PREFIX && !url.pathname.startsWith(`${INGEST_PREFIX}/`)) return null;
  const path = url.pathname.slice(INGEST_PREFIX.length) || "/";
  const host = path.startsWith("/static/") || path.startsWith("/array/") ? ASSET_HOST : API_HOST;
  return `https://${host}${path}${url.search}`;
}

export default {
  async fetch(request, env) {
    const target = upstreamUrl(request.url);
    if (target === null) return env.ASSETS.fetch(request);
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    headers.delete("authorization");
    headers.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") ?? "");
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      redirect: "manual",
    });
  },
};
