// The built-in viewers' Monaco and Markdown assets, which the desktop
// playground's virtual viewers load from `/builtin-viewer/`
// (docs/specs/tutorial.md -> Playground filesystem). Generated, not checked in.
import { fileURLToPath } from "node:url";
import { buildViewerAssets } from "../../dor-tools-builtin/scripts/build-viewer.mjs";

await buildViewerAssets(fileURLToPath(new URL("../public/builtin-viewer/", import.meta.url)));
