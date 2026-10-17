import { HOME, StockTree, USER_CONFIG, VirtualFs } from "./vfs";
import USER_CONFIG_TEXT from "./dormouse.yml?raw";

/** Where the snapshot is mounted, and every playground shell's starting directory. */
export const PLAYGROUND_CWD = `${HOME}/dor-tools-lib`;

// The tracked files of the repo's `dor-tools-lib/`, inlined at build time;
// `playground-fs.test.ts` pins this glob to `git ls-files dor-tools-lib`.
const FILES = import.meta.glob(
  [
    "../../../../dor-tools-lib/**/*",
    "!../../../../dor-tools-lib/node_modules/**",
    "!../../../../dor-tools-lib/dist/**",
    "!**/*.tsbuildinfo",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const PREFIX = "../../../../dor-tools-lib/";

/** Snapshot path (relative to `dor-tools-lib/`) → text. */
export const SNAPSHOT_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([path, text]) => [path.slice(PREFIX.length), text]),
);

let stock: StockTree | undefined;

/** A fresh, empty overlay on the snapshot, which is built once and shared. */
export function createPlaygroundFs(): VirtualFs {
  stock ??= new StockTree({
    ...Object.fromEntries(Object.entries(SNAPSHOT_FILES).map(([path, text]) => [`${PLAYGROUND_CWD}/${path}`, text])),
    [USER_CONFIG]: USER_CONFIG_TEXT,
  });
  return new VirtualFs(stock);
}
