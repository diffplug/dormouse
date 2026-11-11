import { cpSync, existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const websiteDir = resolve(scriptDir, "..");
const distDir = join(websiteDir, "dist");
const clientDir = join(distDir, "client");
const serverDir = join(distDir, "server");

if (!existsSync(clientDir)) {
  throw new Error(`React Router client build not found at ${clientDir}`);
}

for (const entry of readdirSync(clientDir)) {
  cpSync(join(clientDir, entry), join(distDir, entry), {
    recursive: true,
    force: true,
  });
}

rmSync(clientDir, { recursive: true, force: true });
rmSync(serverDir, { recursive: true, force: true });

// Cloudflare Pages serves a top-level 404.html, with status 404, for a path it
// has no file or `_redirects` rule for. Without one it treats the site as a
// single-page app and answers every unknown path 200 with the homepage.
const notFoundPage = join(distDir, "404", "index.html");
if (!existsSync(notFoundPage)) {
  throw new Error(`Prerendered not-found page missing at ${notFoundPage}`);
}
renameSync(notFoundPage, join(distDir, "404.html"));
rmSync(join(distDir, "404"), { recursive: true });

console.log("Flattened React Router client build into dist/");
