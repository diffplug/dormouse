import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Shared build inputs can change Hosted without editing its directory: the
// theme the account frontend imports, and the whole Pocket bundle and one-time
// phone page the relay stages. Whole packages and directories, never a
// hand-picked subset of Pocket's import graph, so a new import cannot slip past.
export function touchesHosted(paths) {
  return paths.some(
    (path) =>
      /^(?:hosted\/|remote-lib-common\/|dor-lib-common\/|lib\/(?:src|pocket|one-time)\/|lib\/vite[^/]*\.config\.ts$|lib\/tsconfig[^/]*\.json$|\.github\/workflows\/hosted-[^/]+\.yml$)/.test(
        path,
      ) ||
      [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "lib/package.json",
        "lib/scripts/assert-pocket-worker.mjs",
      ].includes(path),
  );
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(
    `hosted=${touchesHosted(readFileSync(process.argv[2], "utf8").split("\n"))}`,
  );
