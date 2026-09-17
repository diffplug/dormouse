import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Shared build inputs can change Hosted without editing its directory.
export function touchesHosted(paths) {
  return paths.some(
    (path) =>
      /^(hosted\/|vendor\/|lib\/src\/(theme|lib\/(themes\/|(?:local-json-store|is-record|css-color)\.ts$))|scripts\/sync-pgstencil\.mjs$|\.github\/workflows\/hosted-[^/]+\.yml$)/.test(
        path,
      ) ||
      ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(path),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(
    `hosted=${touchesHosted(readFileSync(process.argv[2], "utf8").split("\n"))}`,
  );
