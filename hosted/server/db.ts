// `pnpm db:roles`, and the last step of `db:migrate` and `db:migrate:preview`,
// so the grants always match the schema just migrated; a failure here leaves
// the migration committed. The standard commands are the `pgstencil` CLI,
// configured by `hosted/pgstencil.json`.
import { applyRuntimeRoles } from "./runtime-roles";
const url = process.env.DATABASE_URL;
if (!url)
  throw new Error(
    "Set DATABASE_URL using your secret manager; never put it in a command argument.",
  );
if (process.argv.length > 2)
  throw new Error(`db.ts applies the runtime roles and takes no arguments, got ${process.argv.slice(2).join(" ")}`);
await applyRuntimeRoles(url);
