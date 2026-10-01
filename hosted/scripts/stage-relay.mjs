import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPocketShell,
  assertPocketWorker,
  ONE_TIME_SHELL,
} from "../../lib/scripts/assert-pocket-worker.mjs";
import {
  HOSTED_POCKET_DEPLOYMENT,
  POCKET_DEPLOYMENT_FILE,
} from "../../remote-lib-common/src/remote/pocket-deployment.ts";

/**
 * Stage the relay Worker's assets: Pocket from `lib`'s `build:pocket` at the
 * root (`docs/specs/pocket-app.md` -> "Deployment: same-origin, always"), and
 * the one-time phone page from `build:one-time` at its page path
 * (`docs/specs/one-time.md` -> "Phone page"), and beside Pocket the
 * `POCKET_DEPLOYMENT_FILE` that tells it Hosted serves it
 * (`docs/specs/remote-network.md` -> "Anywhere"). The directory is emptied
 * first so these are all it holds, and each copy's shell is checked against
 * its own policy — what the relay serves, not only what `lib` built. Returns
 * how many scripts each shell loads.
 */
export function stageRelay({ pocket, oneTime }, assets) {
  for (const [built, command] of [
    [pocket, "build:pocket"],
    [oneTime, "build:one-time"],
  ])
    if (!existsSync(join(built, "index.html")))
      throw new Error(
        `${built} holds no build; run \`pnpm --filter dormouse-lib ${command}\` first.`,
      );
  const pagePath = join(assets, ONE_TIME_SHELL.base);
  if (existsSync(join(pocket, ONE_TIME_SHELL.base)))
    throw new Error(`the Pocket build has a ${ONE_TIME_SHELL.base} the one-time page owns`);
  // A self-host Relay serves that same build, which must read as self-host.
  if (existsSync(join(pocket, POCKET_DEPLOYMENT_FILE)))
    throw new Error(`the Pocket build has a ${POCKET_DEPLOYMENT_FILE} only Hosted's staging writes`);
  rmSync(assets, { recursive: true, force: true });
  mkdirSync(assets, { recursive: true });
  cpSync(pocket, assets, { recursive: true });
  assertPocketWorker(assets);
  const pocketScripts = assertPocketShell(assets);
  if (pocketScripts === 0) throw new Error("the staged Pocket shell has no script");
  writeFileSync(join(assets, POCKET_DEPLOYMENT_FILE), `${JSON.stringify(HOSTED_POCKET_DEPLOYMENT)}\n`);
  cpSync(oneTime, pagePath, { recursive: true });
  const oneTimeScripts = assertPocketShell(pagePath, ONE_TIME_SHELL);
  if (oneTimeScripts === 0) throw new Error("the staged one-time shell has no script");
  return { pocket: pocketScripts, oneTime: oneTimeScripts };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const scripts = stageRelay(
      {
        pocket: fileURLToPath(new URL("../../lib/dist-pocket", import.meta.url)),
        oneTime: fileURLToPath(new URL("../../lib/dist-one-time", import.meta.url)),
      },
      fileURLToPath(new URL("../dist/relay", import.meta.url)),
    );
    console.log(
      `relay assets staged at dist/relay: Pocket at / (${scripts.pocket} script(s)), the one-time page at ${ONE_TIME_SHELL.base} (${scripts.oneTime} script(s) under ${ONE_TIME_SHELL.scriptBase})`,
    );
  } catch (error) {
    console.error(`relay staging failed: ${error.message}`);
    process.exitCode = 1;
  }
}
