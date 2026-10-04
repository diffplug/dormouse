import {
  readMigrations,
  migrate,
  validateMigrations,
  appliedMigrations,
} from "pgstencil/database";
import { migrations } from "./migrations";
import { previewMigrations } from "./preview-migrations";
import { applyRuntimeRoles } from "./runtime-roles";
const url = process.env.DATABASE_URL;
if (!url)
  throw new Error(
    "Set DATABASE_URL using your secret manager; never put it in a command argument.",
  );
const files = await readMigrations(
  process.argv.includes("--preview") ? previewMigrations : migrations,
);
const action = process.argv[2];
// Every migration is followed by the roles file, so the grants always match
// the schema just migrated; a failure there leaves the migration committed.
if (action === "migrate") {
  await migrate(url, files);
  await applyRuntimeRoles(url);
}
else if (action === "validate") await validateMigrations(url, files);
else if (action === "status") {
  const applied = new Set(await appliedMigrations(url));
  console.table(
    files.map((file) => ({ name: file.name, applied: applied.has(file.name) })),
  );
} else if (action === "roles") await applyRuntimeRoles(url);
else throw new Error("Use migrate, validate, status or roles.");
