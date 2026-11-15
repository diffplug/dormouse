import { randomUUID } from "node:crypto";
import { queryDatabase } from "pgstencil/postgres";
import { ADMIN_EMAIL } from "../entitlement";

/** A user row made the one entitled account: `ADMIN_EMAIL` is unique, so whoever held it moves. */
export async function entitledAccount(databaseUrl: string): Promise<string> {
  const id = randomUUID();
  await queryDatabase(databaseUrl, `UPDATE "user" SET email = id || '@example.test' WHERE email = $1`, [ADMIN_EMAIL]);
  await queryDatabase(databaseUrl, `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $1, $2, true)`, [
    id,
    ADMIN_EMAIL,
  ]);
  return id;
}
