import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPocketShell,
  ONE_TIME_SHELL,
} from "../../lib/scripts/assert-pocket-worker.mjs";

/**
 * Copy the one-time phone page `lib`'s `build:one-time` emitted into the relay
 * Worker's assets at the page path (`docs/specs/one-time.md` -> "Phone page"),
 * emptying that directory first so the page is all it holds, and check the
 * copy's shell against the page's policy — what the relay serves, not only
 * what `lib` built. Returns how many scripts the shell loads.
 */
export function stageOneTime(built, assets) {
  if (!existsSync(join(built, "index.html")))
    throw new Error(
      `${built} holds no one-time page; run \`pnpm --filter dormouse-lib build:one-time\` first.`,
    );
  rmSync(assets, { recursive: true, force: true });
  mkdirSync(assets, { recursive: true });
  const target = join(assets, ONE_TIME_SHELL.base);
  cpSync(built, target, { recursive: true });
  const scripts = assertPocketShell(target, ONE_TIME_SHELL);
  if (scripts === 0) throw new Error("the staged one-time shell has no script");
  return scripts;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const scripts = stageOneTime(
      fileURLToPath(new URL("../../lib/dist-one-time", import.meta.url)),
      fileURLToPath(new URL("../dist/relay", import.meta.url)),
    );
    console.log(
      `one-time page staged at dist/relay${ONE_TIME_SHELL.base}: ${scripts} script(s) under ${ONE_TIME_SHELL.scriptBase}`,
    );
  } catch (error) {
    console.error(`one-time staging failed: ${error.message}`);
    process.exitCode = 1;
  }
}
