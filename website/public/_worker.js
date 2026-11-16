/**
 * The site's server-side routes, each a forward to a first-party path:
 *
 * - `/ingest/*`, where visit analytics send, to PostHog's US Cloud
 *   (docs/specs/website-docs.md -> "Visit analytics").
 * - `/api/hosted/*`, the Hosted page's founders row and seat counter, to the
 *   account Worker (docs/specs/hosted.md -> "Billing"), so a reader's browser
 *   only ever asks this origin.
 * - `/standalone-latest.json`, the update manifest, served as is and counted
 *   in PostHog by the version label the check names (docs/specs/deploy.md ->
 *   "Update manifest").
 *
 * `_routes.json` beside it limits this Worker to those paths, so every other
 * request is the static site with `_redirects` as before.
 *
 * Cloudflare Pages runs this file from the build output in advanced mode, so
 * it works whatever directory the Pages project builds from; it is plain
 * JavaScript because Pages reads no `_worker.ts`. The `/ingest` shape follows
 * PostHog's Cloudflare reverse-proxy guide: assets (`/static/`, `/array/`)
 * from the assets host, everything else to the ingestion host, cookies and
 * authorization dropped, and the visitor's address passed on as
 * `X-Forwarded-For`, without which every visitor would hash to Cloudflare's.
 */

export const INGEST_PREFIX = "/ingest";
const API_HOST = "us.i.posthog.com";
const ASSET_HOST = "us-assets.i.posthog.com";

export const HOSTED_PREFIX = "/api/hosted/";
/** The account Worker. Its own origin, so its 421 gate admits the request as any other. */
export const HOSTED_ACCOUNT_ORIGIN = "https://hosted.dormouse.sh";
/** All a Hosted answer keeps; a cookie or anything else the account sets stays there. */
const HOSTED_RESPONSE_HEADERS = ["content-type", "content-length", "cache-control"];

/** Where a request under `/ingest` goes upstream, or null for any other path. */
export function upstreamUrl(requestUrl) {
  const url = new URL(requestUrl);
  if (url.pathname !== INGEST_PREFIX && !url.pathname.startsWith(`${INGEST_PREFIX}/`)) return null;
  const path = url.pathname.slice(INGEST_PREFIX.length) || "/";
  const host = path.startsWith("/static/") || path.startsWith("/array/") ? ASSET_HOST : API_HOST;
  return `https://${host}${path}${url.search}`;
}

/**
 * A read under `/api/hosted/`, forwarded with nothing of the reader's: no
 * cookie, credential, address, or query reaches the account Worker, and only
 * the body and its type come back.
 */
export async function forwardHosted(request) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const { pathname } = new URL(request.url);
  const upstream = await fetch(HOSTED_ACCOUNT_ORIGIN + pathname, {
    method: request.method,
    headers: { accept: request.headers.get("accept") ?? "*/*" },
    redirect: "manual",
  });
  const headers = new Headers({ "x-content-type-options": "nosniff" });
  for (const name of HOSTED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

const UPDATE_MANIFEST_PATH = "/standalone-latest.json";
/** `POSTHOG_PROJECT_KEY` in `website/src/lib/site-analytics.ts`, which this file cannot import. */
const POSTHOG_PROJECT_KEY = "phc_AxHDxNuQ9uGy5AmejhxcZz3vNUPwZY2WgmCgW6WgNkTU";
/** One distinct id for every check, so PostHog keeps no person and counts no visitor. */
const UPDATE_CHECK_DISTINCT_ID = "dormouse.sh update check";
const BUILD_LABEL = /^(modified-)?\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/**
 * The label a check is counted under: its `Dormouse-Build` header when that is
 * a version label, `unreported` when absent (a build older than the header),
 * and `other` for anything else, so nothing a request sends is stored but a
 * label of that shape.
 */
function buildLabelOf(request) {
  const label = request.headers.get("dormouse-build");
  if (label === null) return "unreported";
  return BUILD_LABEL.test(label) ? label : "other";
}

/**
 * Tells PostHog of one check: the label and nothing else of the request's —
 * no address, agent, or header — under one shared id, with no person profile
 * and no location lookup of the Worker's own address.
 */
function countUpdateCheck(request) {
  return fetch(`https://${API_HOST}/i/v0/e/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: POSTHOG_PROJECT_KEY,
      event: "update check",
      distinct_id: UPDATE_CHECK_DISTINCT_ID,
      properties: { build: buildLabelOf(request), $process_person_profile: false, $geoip_disable: true },
    }),
  }).catch((e) => console.error("update-check count failed", e));
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === UPDATE_MANIFEST_PATH) {
      // Never waited on: a slow or failing count never delays the check.
      ctx.waitUntil(countUpdateCheck(request));
      return env.ASSETS.fetch(request);
    }
    if (pathname.startsWith(HOSTED_PREFIX)) return forwardHosted(request);
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
