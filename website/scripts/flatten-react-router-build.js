import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
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

console.log("Flattened React Router client build into dist/");
