import { readFile } from "node:fs/promises";
import { withClient } from "pgstencil/postgres";

let source: Promise<string> | undefined;

/** `runtime-roles.sql`, read once. */
export const runtimeRolesSql = () =>
  (source ??= readFile(new URL("./runtime-roles.sql", import.meta.url), "utf8"));

/**
 * Applies `runtime-roles.sql` to the database at `url`, connected as the
 * migration role, which owns every table it grants on. Safe to repeat.
 */
export async function applyRuntimeRoles(url: string) {
  const sql = await runtimeRolesSql();
  await withClient(url, (client) => client.query(sql));
}
