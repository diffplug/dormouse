import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FRAME_BOOTSTRAP_PATH,
  FRAME_BOOTSTRAP_SCRIPT_PATH,
  FRAME_WORKER_PATH,
} from "../../remote-lib-common/src/remote/frame-origin-paths.ts";

/** Everything a frame origin serves (`docs/specs/pocket-app.md` -> "Frame origin"). */
const FRAME_FILES = [FRAME_WORKER_PATH, FRAME_BOOTSTRAP_PATH, FRAME_BOOTSTRAP_SCRIPT_PATH]
  .map((path) => path.slice(1))
  .sort();

/**
 * Stage the frame Worker's assets from `lib`'s `build:frame-origin`. The
 * directory is emptied first, and must end up holding those files and nothing
 * else: whatever else a build left there would be served beside a framed page.
 */
export function stageFrames(built, assets) {
  if (!existsSync(built))
    throw new Error(`${built} holds no build; run \`pnpm --filter dormouse-lib build:frame-origin\` first.`);
  rmSync(assets, { recursive: true, force: true });
  mkdirSync(assets, { recursive: true });
  cpSync(built, assets, { recursive: true });
  const staged = readdirSync(assets, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(assets.length + 1))
    .sort();
  if (JSON.stringify(staged) !== JSON.stringify(FRAME_FILES))
    throw new Error(`the frame origin build holds ${staged.join(", ")}, not ${FRAME_FILES.join(", ")}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    stageFrames(
      fileURLToPath(new URL("../../lib/dist-frame-origin", import.meta.url)),
      fileURLToPath(new URL("../dist/frames", import.meta.url)),
    );
    console.log("frame origin assets staged at dist/frames");
  } catch (error) {
    console.error(`frame origin staging failed: ${error.message}`);
    process.exitCode = 1;
  }
}
