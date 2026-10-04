import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

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
  "005_voice_token_burrow.sql": "ccb395314dd49f9b5c72560121994fd7a21d349580c0d746d0d380e29d0aefec",
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
