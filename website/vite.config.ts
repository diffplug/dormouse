import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Mirrors functions/api/notify-signup.ts so the form works under `vite dev`.
// Cloudflare Pages runs the real Function in production. Lives at the repo
// root (not website/) because the Pages project's root directory is the repo
// root.
function notifySignupDevPlugin(): Plugin {
  return {
    name: "notify-signup-dev",
    configureServer(server) {
      server.middlewares.use("/api/notify-signup", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const parsed = (() => {
          try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { return null; }
        })();
        const email = parsed?.email;
        const valid = typeof email === "string"
          && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        if (!valid) {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "Please enter a valid email" }));
          return;
        }
        const body = new URLSearchParams({
          email,
          first_url: "https://mouseterm.com/",
          first_referrer: "",
          current_url: "https://mouseterm.com/",
          current_referrer: "",
          referral_code: "",
          source: "subscribe_modal",
        });
        const fallback = `https://nedshed.dev/subscribe?email=${encodeURIComponent(email)}`;
        let upstream;
        try {
          upstream = await fetch("https://nedshed.dev/api/v1/free?nojs=true", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Origin: "https://nedshed.dev",
              Referer: "https://nedshed.dev/",
            },
            body,
          });
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: false, fallback: true, fallbackUrl: fallback }));
          return;
        }
        res.setHeader("content-type", "application/json");
        if (upstream.ok) {
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        const text = await upstream.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
        if (parsed && Array.isArray(parsed.errors)) {
          const msg = parsed.errors[0]?.msg ?? "Please enter a valid email";
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: msg }));
          return;
        }
        res.statusCode = upstream.status >= 500 ? 502 : 409;
        res.end(JSON.stringify({ ok: false, fallback: true, fallbackUrl: fallback }));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), notifySignupDevPlugin()],
  resolve: {
    alias: {
      "mouseterm-lib": path.resolve(__dirname, "../lib/src"),
      "ascii-splash-internal": path.resolve(
        __dirname,
        "node_modules/ascii-splash/dist",
      ),
      "@standalone-latest": path.resolve(
        __dirname,
        "public/standalone-latest.json",
      ),
    },
  },
  server: {
    host: true,
  },
});
