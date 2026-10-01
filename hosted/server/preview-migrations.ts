import { fileURLToPath } from "node:url";
import { migrations } from "./migrations.ts";
export const previewMigrations = [
  ...migrations,
  fileURLToPath(new URL("./preview-migrations/", import.meta.url)),
];
