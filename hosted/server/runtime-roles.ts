import { readFile } from "node:fs/promises";
import { withClient } from "pgstencil/postgres";

/** The restricted Postgres role of each Worker `runtime-roles.sql` provisions; the account Worker has none. */
export const RUNTIME_ROLES = {
  relay: "dormouse_relay",
  voice: "dormouse_voice",
} as const;

/**
 * Applies `runtime-roles.sql` to the database at `url`, connected as the
 * migration role, which owns every table it grants on. Safe to repeat.
 */
export async function applyRuntimeRoles(url: string) {
  const sql = await readFile(new URL("./runtime-roles.sql", import.meta.url), "utf8");
  await withClient(url, (client) => client.query(sql));
}
