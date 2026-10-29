import { test, expect } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { betterAuthMigrations } from "@pgstencil/auth/better-auth-migrations";
import { migrate, readMigrations } from "pgstencil/database";
import { queryDatabase } from "pgstencil/postgres";
import { createTestContext } from "pgstencil/testing";

/**
 * Every Dormouse migration, by the SHA-256 of its LF-normalized text
 * (`docs/specs/hosted.md`: never edit a merged migration). A database that ran
 * one never runs it again, so an edit reaches only fresh databases; a change
 * appends the next numbered file and pins it here.
 */
const PINNED: Record<string, string> = {
  "001_voice_tokens.sql": "8dddec53bca7244411f3e8a007ccea665ede176c9c0bead6a0987af41c366cae",
  "002_relay.sql": "54651083ba1aac934ac0dcb5f62cc4f032d017f2c3be2161c0812ebc76f338c3",
  "003_relay_push.sql": "ee8cca19bb70eb89fcba708b54d8a188347caf0f32ec23551c56d27676ab094f",
  "004_relay_enrollment_redeemed.sql":
    "dd36852ac3efbdc7f0dc2b9ee449f8f213c3c63982c4ab176a27e4a19e08a74d",
  "005_terms_acceptances.sql":
    "b02891ae98157bf09927e51739057a7882d35e51e2e4d5cf3e25f8a9a3f29447",
  "006_relay_setup_token_claim.sql":
    "37bf7777f10416e9bbcb3df11d1cc355e13462ce99b1e49f2481436617d9eccc",
  "007_independent_voice.sql":
    "6b6d95fd3e3e5d71f3915913d483edebd6837e0481388b4f2af11a8249364264",
  "008_voice_token_idle_expiry.sql":
    "b3f265e4c99b7d78c84aa58fe3e95b9a609c450ccc0a7f3701f871c8798d4801",
  "009_relay_passkey_removal.sql":
    "c6c220960187e33a1350dc85e93d24f99866a72a579ed9def6a3663643f3e928",
  "010_relay_session_credential_required.sql":
    "f385398d16126381b6a976d74e23e10b07370c1a1da3205e71697aa62a3399f5",
  "011_enrollment_confirm_digits.sql":
    "54afe9ae8a2efd3c654503d479fce96c1ce8ff4f2df249aa93b5a91e925def6e",
  "012_relay_burrow_label.sql":
    "45b3df1530402622edeb12e12e1572698840ecc8ea6b9cfc585f3a9e28b4f230",
  "013_metrics.sql":
    "ffb460491d0d9d3cf00b33067b6cbe8dae04ca68fc663cb005aabf15619a08eb",
  "014_billing_disputes.sql":
    "ddf7454ce96f389f153d76d4001ca559fb5bd8969e6fda46e68dcd10e901a502",
  "015_founders.sql":
    "1610ccafe5450a7960a00cf7e393c6d99c22b20170ef230c76544632e6806eeb",
  "016_checkout_consents.sql":
    "0d0fcf0a44651ca819ee279d046ef55a622fa6398cf99e3b3d69b9a045ffe74c",
  "017_withdrawals_and_closures.sql":
    "136eb6ca31280e7f3852a0a42226235b0a639537b9ce64752efca66c091580c4",
  "018_billing_notices.sql":
    "20fe04c88694fd1cd00a83746ec8486e9bea7b0cb35aaabfd9c5a3fc4d6555c0",
};

const directory = new URL("../dormouse-migrations/", import.meta.url);

test("no merged Dormouse migration changes, and every one is pinned", () => {
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  expect(files).toEqual(Object.keys(PINNED).sort());
  for (const name of files) {
    const text = readFileSync(new URL(name, directory), "utf8").replace(/\r\n/g, "\n");
    const digest = createHash("sha256").update(text).digest("hex");
    expect(digest, `${name} was edited; append a new migration instead`).toBe(PINNED[name]);
  }
});

test("010 deletes the sessions that name no passkey, and every later one must name one", async ({
  onTestFinished,
}) => {
  // The Dormouse migrations through 009, then 010 over the rows they allowed.
  const before = mkdtempSync(join(tmpdir(), "dormouse-migrations-"));
  onTestFinished(() => rmSync(before, { recursive: true, force: true }));
  const source = fileURLToPath(directory);
  for (const name of Object.keys(PINNED).filter((name) => name < "010")) copyFileSync(join(source, name), join(before, name));
  const context = await createTestContext({ migrations: [betterAuthMigrations, before] });
  onTestFinished(context.close);
  const sql = (text: string, values?: unknown[]) => queryDatabase(context.database.url, text, values);
  const userId = randomUUID();
  await sql(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $1, $2, true)`, [userId, `${userId}@example.test`]);
  await sql(`INSERT INTO dormouse_relay_passkeys ("credentialId", "userId", "publicKey", label) VALUES ('pk', $1, 'x', '')`, [userId]);
  const session = (tokenHash: string, credentialId: string | null) =>
    sql(
      `INSERT INTO dormouse_relay_sessions ("tokenHash", "userId", "expiresAt", "credentialId")
      VALUES ($1, $2, now() + interval '1 hour', $3)`,
      [tokenHash, userId, credentialId],
    );
  await session("named", "pk");
  await session("unnamed", null);

  copyFileSync(join(source, "010_relay_session_credential_required.sql"), join(before, "010_relay_session_credential_required.sql"));
  await migrate(context.database.url, await readMigrations([betterAuthMigrations, before]));
  expect(await sql(`SELECT "tokenHash" FROM dormouse_relay_sessions`)).toEqual([{ tokenHash: "named" }]);
  await expect(session("later", null)).rejects.toThrow(/credentialId/);
});
