import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hosted = fileURLToPath(new URL("..", import.meta.url));
const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const PREVIEW = "--also server/preview-migrations";
const database = Object.entries(scripts).filter(([name]) => /^db:(migrate|validate|status)(:preview)?$/.test(name));

test("each db script is the pgstencil command for its database, and migrate applies the roles after", () => {
  assert.deepEqual(database.map(([name]) => name).sort(), [
    "db:migrate", "db:migrate:preview", "db:status", "db:status:preview", "db:validate", "db:validate:preview",
  ]);
  for (const [name, script] of database) {
    const [command, preview] = name.slice(3).split(":");
    const roles = command === "migrate" ? " && tsx server/db.ts" : "";
    assert.equal(script, `pgstencil ${command} --require-database-url${preview ? ` ${PREVIEW}` : ""}${roles}`, name);
  }
  assert.ok(existsSync(new URL("../server/preview-migrations/", import.meta.url)));
});

// A workflow sees a lost secret as unset or empty; neither may reach the
// development database, and a refused migrate never applies the roles.
test("every db script refuses a missing or empty DATABASE_URL before touching a database", () => {
  const { DATABASE_URL: _, PGSTENCIL_PROJECT_ROOT: __, ...env } = process.env;
  env.PATH = `${hosted}node_modules/.bin${delimiter}${env.PATH}`;
  for (const [name, script] of database) {
    for (const url of [undefined, ""]) {
      const run = spawnSync("sh", ["-c", script], {
        cwd: hosted,
        env: url === undefined ? env : { ...env, DATABASE_URL: url },
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.notEqual(run.status, 0, `${name} with DATABASE_URL ${url === undefined ? "unset" : "empty"}`);
      assert.match(run.stderr, /DATABASE_URL is (unset|set but empty)/, name);
      assert.doesNotMatch(run.stderr, /runtime roles|Set DATABASE_URL using/, name);
    }
  }
});
