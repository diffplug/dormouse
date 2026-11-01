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
  /** The one origin that may frame this: Pocket's, and the one-time page's. */
  CLIENT_ORIGIN: string;
}

const headers = (clientOrigin: string, contentType: string) => ({
  "content-type": contentType,
  // Revalidated, so a worker fix reaches a phone at its next load.
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // Only the bootstrap page can be framed, and only by the Client: that is what
  // makes the parent its messages trust the Client (`bootstrap.ts`).
  "content-security-policy": `default-src 'none'; script-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${clientOrigin}`,
});

export async function frameOriginResponse(request: Request, env: FrameOriginEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const contentType = Object.hasOwn(FILES, pathname) ? FILES[pathname] : undefined;
  if (!contentType || (request.method !== "GET" && request.method !== "HEAD")) {
    return new Response("Not found", {
      status: 404,
      headers: headers(env.CLIENT_ORIGIN, "text/plain; charset=utf-8"),
    });
  }
  // The assets' HTML handling redirects `….html`; a worker's registration and a
  // frame's `load` want the file.
  const url = new URL(request.url);
  if (pathname === FRAME_BOOTSTRAP_PATH) url.pathname = pathname.slice(0, -".html".length);
  const file = await env.ASSETS.fetch(new Request(url, { method: request.method }));
  if (!file.ok) return new Response("Not found", { status: 404, headers: headers(env.CLIENT_ORIGIN, "text/plain; charset=utf-8") });
  return new Response(request.method === "HEAD" ? null : file.body, { status: 200, headers: headers(env.CLIENT_ORIGIN, contentType) });
}
