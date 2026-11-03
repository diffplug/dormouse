import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPocketShell,
  assertPocketWorker,
} from "../../lib/scripts/assert-pocket-worker.mjs";
import {
  HOSTED_POCKET_DEPLOYMENT,
  POCKET_DEPLOYMENT_FILE,
} from "../../remote-lib-common/src/remote/pocket-deployment.ts";

/**
 * Stage the relay Worker's assets: Pocket from `lib`'s `build:pocket` at the
 * root (`docs/specs/pocket-app.md` -> "Deployment: same-origin, always"), and
 * beside it the `POCKET_DEPLOYMENT_FILE` that tells it Hosted serves it
 * (`docs/specs/remote-network.md` -> "Anywhere"). The directory is emptied
 * first so these are all it holds, and the shell is checked against its policy
 * — what the relay serves, not only what `lib` built. Returns how many scripts
 * the shell loads.
 */
export function stageRelay(pocket, assets) {
  if (!existsSync(join(pocket, "index.html")))
    throw new Error(`${pocket} holds no build; run \`pnpm --filter dormouse-lib build:pocket\` first.`);
  // A self-host Relay serves that same build, which must read as self-host.
  if (existsSync(join(pocket, POCKET_DEPLOYMENT_FILE)))
    throw new Error(`the Pocket build has a ${POCKET_DEPLOYMENT_FILE} only Hosted's staging writes`);
  rmSync(assets, { recursive: true, force: true });
  mkdirSync(assets, { recursive: true });
  cpSync(pocket, assets, { recursive: true });
  assertPocketWorker(assets);
  const scripts = assertPocketShell(assets);
  if (scripts === 0) throw new Error("the staged Pocket shell has no script");
  writeFileSync(join(assets, POCKET_DEPLOYMENT_FILE), `${JSON.stringify(HOSTED_POCKET_DEPLOYMENT)}\n`);
  return scripts;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const scripts = stageRelay(
      fileURLToPath(new URL("../../lib/dist-pocket", import.meta.url)),
      fileURLToPath(new URL("../dist/relay", import.meta.url)),
    );
    console.log(`relay assets staged at dist/relay: Pocket at / (${scripts} script(s))`);
  } catch (error) {
    console.error(`relay staging failed: ${error.message}`);
    process.exitCode = 1;
  }
}
