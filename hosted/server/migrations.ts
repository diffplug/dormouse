import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseConfig } from "pgstencil/database";

const config = new URL("../pgstencil.json", import.meta.url);
/** Production's migration sources, in order: `hosted/pgstencil.json`'s, which the `pgstencil` CLI behind `pnpm db:*` applies. */
export const migrations = parseConfig(
  fileURLToPath(new URL(".", config)),
  JSON.parse(readFileSync(config, "utf8")),
).migrations;
