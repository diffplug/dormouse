import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPocketShell, ONE_TIME_SHELL } from "../../lib/scripts/assert-pocket-worker.mjs";

/**
 * Stage the try Worker's assets: the one-time phone page from `lib`'s
 * `build:one-time` at its page path (`docs/specs/one-time.md` -> "Phone page"),
 * and nothing else. The directory is emptied first, and the copy's shell is
 * checked against its policy — what the Worker serves, not only what `lib`
 * built. Returns how many scripts the shell loads.
 */
export function stageTry(built, assets) {
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
    const scripts = stageTry(
      fileURLToPath(new URL("../../lib/dist-one-time", import.meta.url)),
      fileURLToPath(new URL("../dist/try", import.meta.url)),
    );
    console.log(
      `try assets staged at dist/try: the one-time page at ${ONE_TIME_SHELL.base} (${scripts} script(s) under ${ONE_TIME_SHELL.scriptBase})`,
    );
  } catch (error) {
    console.error(`try staging failed: ${error.message}`);
    process.exitCode = 1;
  }
}
