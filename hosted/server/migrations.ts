import { fileURLToPath } from "node:url";
import { betterAuthMigrations } from "@pgstencil/auth/better-auth-migrations";
export const migrations = [
  betterAuthMigrations,
  fileURLToPath(new URL("./dormouse-migrations/", import.meta.url)),
];
