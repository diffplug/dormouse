import {
  readMigrations,
  migrate,
  validateMigrations,
  appliedMigrations,
} from "pgstencil/database";
import { migrations } from "./migrations";
const url = process.env.DATABASE_URL;
if (!url)
  throw new Error(
    "Set DATABASE_URL using your secret manager; never put it in a command argument.",
  );
const files = await readMigrations(migrations);
const action = process.argv[2];
if (action === "migrate") await migrate(url, files);
else if (action === "validate") await validateMigrations(url, files);
else if (action === "status") {
  const applied = new Set(await appliedMigrations(url));
  console.table(
    files.map((file) => ({ name: file.name, applied: applied.has(file.name) })),
  );
} else throw new Error("Use migrate, validate or status.");
