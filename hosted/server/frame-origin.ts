import {
  FRAME_BOOTSTRAP_PATH,
  FRAME_BOOTSTRAP_SCRIPT_PATH,
  FRAME_WORKER_PATH,
} from "remote-lib-common";

/**
 * A frame origin as Hosted serves it (`docs/specs/pocket-app.md` -> "Frame
 * origin"): three fixed files and a 404. A page's own requests never reach here
 * while its worker runs, and carry nothing here if they do: this Worker holds no
 * binding but its assets, reads no header, and sets no cookie.
 */
const FILES: Readonly<Record<string, string>> = {
  [FRAME_WORKER_PATH]: "text/javascript; charset=utf-8",
  [FRAME_BOOTSTRAP_SCRIPT_PATH]: "text/javascript; charset=utf-8",
  [FRAME_BOOTSTRAP_PATH]: "text/html; charset=utf-8",
};

export interface FrameOriginEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** The origins that may frame this, space-separated: Pocket's and the one-time page's. */
  CLIENT_ORIGINS: string;
}

const headers = (clientOrigins: string, contentType: string) => ({
  "content-type": contentType,
  // Revalidated, so a worker fix reaches a phone at its next load.
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // `.com` is not HTTPS-only of itself, and a framed page's `http:` link to its
  // own origin would pass its worker and reach the network in the clear.
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  // Only the bootstrap page can be framed, and only by the Client: that is what
  // makes the parent its messages trust the Client (`bootstrap.ts`).
  "content-security-policy": `default-src 'none'; script-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${clientOrigins}`,
});

export async function frameOriginResponse(request: Request, env: FrameOriginEnv): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404, headers: headers(env.CLIENT_ORIGINS, "text/plain; charset=utf-8") });
  const url = new URL(request.url);
  const contentType = Object.hasOwn(FILES, url.pathname) ? FILES[url.pathname] : undefined;
  if (!contentType || (request.method !== "GET" && request.method !== "HEAD")) return notFound();
  // The assets' HTML handling redirects `….html`; a worker's registration and a
  // frame's `load` want the file.
  if (url.pathname === FRAME_BOOTSTRAP_PATH) url.pathname = url.pathname.slice(0, -".html".length);
  const file = await env.ASSETS.fetch(new Request(url, { method: request.method }));
  if (!file.ok) return notFound();
  return new Response(request.method === "HEAD" ? null : file.body, { status: 200, headers: headers(env.CLIENT_ORIGINS, contentType) });
}
