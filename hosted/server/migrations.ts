import { fileURLToPath } from "node:url";
import { betterAuthMigrations } from "@pgstencil/auth/better-auth-migrations";
import { billingMigrations } from "@pgstencil/stripe/migrations";
export const migrations = [
  betterAuthMigrations,
  billingMigrations,
  fileURLToPath(new URL("./dormouse-migrations/", import.meta.url)),
];
