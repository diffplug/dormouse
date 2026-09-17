import type { Hono } from "hono";

// Applied to the HTML shell as well as APIs: auth's own middleware only covers its routes.
export function secureHeaders(app: Hono<any>) {
  app.use("*", async (c, next) => {
    await next();
    // Vite emits content-hashed files under /assets/, so they are safe to cache forever,
    // but the SPA fallback answers an unknown /assets/ path with the HTML shell: cache
    // only a 200 whose type is not HTML, and leave everything else uncached.
    const asset =
      c.res.status === 200 &&
      new URL(c.req.url).pathname.startsWith("/assets/") &&
      !(c.res.headers.get("content-type") ?? "").includes("text/html");
    c.header(
      "Cache-Control",
      asset ? "public, max-age=31536000, immutable" : "no-store",
    );
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Strict-Transport-Security", "max-age=31536000");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
    );
  });
}
