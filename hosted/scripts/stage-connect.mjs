import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPocketShell, ONE_TIME_SHELL } from "../../lib/scripts/assert-pocket-worker.mjs";

/**
 * Stage the connect Worker's assets: the one-time phone page from `lib`'s
 * `build:one-time` at its page path (`docs/specs/one-time.md` -> "Phone page"),
 * and nothing else. The directory is emptied first, and the copy's shell is
 * checked against its policy — what the Worker serves, not only what `lib`
 * built. Returns how many scripts the shell loads.
 */
export function stageConnect(built, assets) {
  if (!existsSync(join(built, "index.html")))
    throw new Error(`${built} holds no build; run \`pnpm --filter dormouse-lib build:one-time\` first.`);
  rmSync(assets, { recursive: true, force: true });
  const pagePath = join(assets, ONE_TIME_SHELL.base);
  mkdirSync(pagePath, { recursive: true });
  cpSync(built, pagePath, { recursive: true });
  const scripts = assertPocketShell(pagePath, ONE_TIME_SHELL);
  if (scripts === 0) throw new Error("the staged one-time shell has no script");
  return scripts;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const scripts = stageConnect(
      fileURLToPath(new URL("../../lib/dist-one-time", import.meta.url)),
      fileURLToPath(new URL("../dist/connect", import.meta.url)),
    );
    console.log(
      `connect assets staged at dist/connect: the one-time page at ${ONE_TIME_SHELL.base} (${scripts} script(s) under ${ONE_TIME_SHELL.scriptBase})`,
    );
  } catch (error) {
    console.error(`connect staging failed: ${error.message}`);
    process.exitCode = 1;
  }
}
