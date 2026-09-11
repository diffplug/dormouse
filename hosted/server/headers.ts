import type { Hono } from "hono";

// Applied to the HTML shell as well as APIs: auth's own middleware only covers its routes.
export function secureHeaders(app: Hono<any>, development = false) {
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    c.header("X-Robots-Tag", "noindex, nofollow");
    if (!development) {
      c.header("Strict-Transport-Security", "max-age=31536000");
      c.header(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
      );
    }
  });
}
