import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { required, hyperdriveOrigin } from "./preview.mjs";

// Plaintext and the age identity exist only in private runner scratch space.
// Only the encrypted archive leaves the runner, after decrypt-and-restore succeeds.
const temporary = await mkdtemp(join(tmpdir(), "hosted-backup-"));
const container = `hosted-restore-${randomUUID()}`;
const image = "postgres:17.11-alpine";
function run(step, command, args, env = process.env) {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  // Third-party stderr can contain connection details or rows; report the failed command only.
  if (result.status !== 0)
    throw new Error(`Backup ${step} failed (exit ${result.status})`);
  return result.stdout.trim();
}
try {
  const origin = hyperdriveOrigin(required(process.env, "DATABASE_URL"));
  const pgEnv = {
    ...process.env,
    PGHOST: origin.host,
    PGPORT: String(origin.port),
    PGDATABASE: origin.database,
    PGUSER: origin.user,
    PGPASSWORD: origin.password,
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: "system",
    PGCONNECT_TIMEOUT: "30",
  };
  const identity = join(temporary, "identity.txt");
  await writeFile(
    identity,
    required(process.env, "BACKUP_AGE_IDENTITY") + "\n",
    { mode: 0o600 },
  );
  const recipient = run("read encryption identity", "age-keygen", [
    "-y",
    identity,
  ]);
  run(
    "database dump",
    "docker",
    [
      "run",
      "--rm",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      ...[
        "PGHOST",
        "PGPORT",
        "PGDATABASE",
        "PGUSER",
        "PGPASSWORD",
        "PGSSLMODE",
        "PGSSLROOTCERT",
        "PGCONNECT_TIMEOUT",
      ].flatMap((key) => ["-e", key]),
      "-v",
      `${temporary}:/backup`,
      image,
      "pg_dump",
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--file=/backup/database.dump",
    ],
    pgEnv,
  );
  const encrypted = join(temporary, "database.dump.age");
  run("encryption", "age", [
    "-r",
    recipient,
    "-o",
    encrypted,
    join(temporary, "database.dump"),
  ]);
  run("decryption", "age", [
    "-d",
    "-i",
    identity,
    "-o",
    join(temporary, "restored.dump"),
    encrypted,
  ]);
  run("start restore container", "docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    container,
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    image,
  ]);
  for (let attempt = 0; ; attempt++) {
    // The image's temporary initialization server accepts Unix sockets only.
    // Wait for TCP so restore cannot race its shutdown and final server startup.
    const ready = spawnSync(
      "docker",
      ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
      { stdio: "ignore" },
    );
    if (ready.status === 0) break;
    if (attempt >= 30) throw new Error("Backup restore database did not start");
    await new Promise((done) => setTimeout(done, 1000));
  }
  run("copy restore archive", "docker", [
    "cp",
    join(temporary, "restored.dump"),
    `${container}:/tmp/restored.dump`,
  ]);
  run("database restore", "docker", [
    "exec",
    container,
    "pg_restore",
    "--host=127.0.0.1",
    "--username=postgres",
    "--dbname=postgres",
    "--no-owner",
    "--no-acl",
    "--exit-on-error",
    "/tmp/restored.dump",
  ]);
  const output = resolve("hosted/.wrangler/production-backup");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const { copyFile } = await import("node:fs/promises");
  await copyFile(
    encrypted,
    join(output, `${new Date().toISOString().replaceAll(":", "-")}.dump.age`),
  );
  console.log(
    "Encrypted production backup created; decryption and PostgreSQL restore verified.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  await rm(temporary, { recursive: true, force: true });
}
