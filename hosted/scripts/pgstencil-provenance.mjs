import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The installed pgstencil packages' provenance and upstream standing: both
 * `dist/provenance.json` files name one clean commit, npm's verified SLSA
 * attestation binds each package to pgstencil's release workflow on `main` and
 * to that commit, and the commit is on pgstencil `main` with a passing
 * `security-audit`. The production `verify` job runs this before any deploy,
 * so a bump is checked before it ships.
 */
const REPOSITORY = "diffplug/pgstencil";
const NPM = "https://registry.npmjs.org/";
const SLSA = "https://slsa.dev/provenance/v1";
const SIGNER = `https://github.com/${REPOSITORY}/.github/workflows/release.yml@refs/heads/main`;
/** Fulcio's Source Repository Digest, OID 1.3.6.1.4.1.57264.1.13, DER-encoded. */
const SOURCE_DIGEST = Buffer.from("060a2b0601040183bf30010d", "hex");

/**
 * Each installed pgstencil package's `dist/provenance.json` names one clean
 * commit; returns that commit and each package's installed name and version.
 */
export async function verifyPackages() {
  const commits = [];
  const packages = [];
  for (const name of ["pgstencil", "@pgstencil/auth/better-auth"]) {
    // Resolve the installed entrypoint, then read the provenance beside it.
    const entry = import.meta.resolve(name);
    const provenance = JSON.parse(
      await readFile(new URL("./provenance.json", entry), "utf8"),
    );
    const { name: installed, version } = JSON.parse(
      await readFile(new URL("../package.json", entry), "utf8"),
    );
    packages.push({ name: installed, version });
    assert.match(
      provenance.commit,
      /^[a-f0-9]{40}$/,
      "Production requires accepted, clean pgstencil provenance",
    );
    assert.notEqual(
      provenance.dirty,
      true,
      "Production requires accepted, clean pgstencil provenance",
    );
    commits.push(provenance.commit);
  }
  assert.equal(
    commits[0],
    commits[1],
    "Production requires accepted, clean pgstencil provenance",
  );
  return { commit: commits[0], packages };
}

/** `name@version`'s sha512, as hex, from `pnpm-lock.yaml`'s packages. */
export function lockedDigest(lock, name, version) {
  const key = RegExp.escape(`${name}@${version}`);
  const match = lock.match(
    new RegExp(`^  '?${key}'?:\\n    resolution: \\{integrity: sha512-([A-Za-z0-9+/]+=*)\\}$`, "m"),
  );
  assert.ok(match, `pnpm-lock.yaml has no sha512 integrity for ${name}@${version}`);
  return Buffer.from(match[1], "base64").toString("hex");
}

/** The DER elements in `bytes` from `start` to `end`. */
function* der(bytes, start = 0, end = bytes.length) {
  for (let at = start; at < end; ) {
    const tag = bytes[at++];
    let length = bytes[at++];
    if (length & 0x80) {
      const octets = length & 0x7f;
      length = 0;
      for (let i = 0; i < octets; i++) length = length * 256 + bytes[at++];
    }
    yield { tag, start: at, end: at + length };
    at += length;
  }
}

/** The string content of every extension whose encoded OID is `oid`. */
function extensionValues(bytes, oid, start, end, found = []) {
  const children = [...der(bytes, start, end)];
  const [first] = children;
  const last = children.at(-1);
  if (first?.tag === 0x06 && bytes.subarray(first.start - 2, first.end).equals(oid) && last.tag === 0x04) {
    const [value] = der(bytes, last.start, last.end);
    found.push(bytes.subarray(value.start, value.end).toString("utf8"));
  } else
    for (const child of children)
      if (child.tag & 0x20) extensionValues(bytes, oid, child.start, child.end, found);
  return found;
}

/**
 * One verified SLSA bundle against S119's clauses: the Fulcio certificate's
 * signer and source digest, and the signed statement's subject, workflow, and
 * source commit. npm has already checked the signature, the certificate's
 * chain, and the subject against the registry's tarball.
 */
function judgeProvenance(bundle, { name, version, digest }, commit) {
  const raw = Buffer.from(bundle.verificationMaterial.certificate.rawBytes, "base64");
  const certificate = new X509Certificate(raw);
  assert.equal(certificate.subjectAltName, `URI:${SIGNER}`, `${name} was not signed by pgstencil's release workflow on main`);
  assert.deepEqual(extensionValues(raw, SOURCE_DIGEST), [commit], `${name}'s certificate names another source commit`);
  const envelope = bundle.dsseEnvelope;
  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  assert.deepEqual(
    [envelope.payloadType, statement._type, statement.predicateType],
    ["application/vnd.in-toto+json", "https://in-toto.io/Statement/v1", SLSA],
    `${name}'s attestation is not an in-toto SLSA provenance statement`,
  );
  assert.deepEqual(
    statement.subject,
    [{ name: `pkg:npm/${name.replace(/^@/, "%40")}@${version}`, digest: { sha512: digest } }],
    `${name}'s attestation names another package or tarball`,
  );
  const { externalParameters, resolvedDependencies } = statement.predicate.buildDefinition;
  assert.deepEqual(
    externalParameters.workflow,
    { ref: "refs/heads/main", repository: `https://github.com/${REPOSITORY}`, path: ".github/workflows/release.yml" },
    `${name}'s attestation names another workflow`,
  );
  assert.deepEqual(
    resolvedDependencies,
    [{ uri: `git+https://github.com/${REPOSITORY}@refs/heads/main`, digest: { gitCommit: commit } }],
    `${name}'s attestation names another source commit`,
  );
}

/** `npm audit signatures` output: each package verified, from npm, with one SLSA bundle. */
export function judgeSignatures(audit, packages, commit) {
  for (const pkg of packages) {
    const same = (entry) => entry.name === pkg.name && entry.version === pkg.version;
    assert.ok(!audit.invalid?.some(same) && !audit.missing?.some(same), `npm could not verify ${pkg.name}@${pkg.version}'s signatures`);
    const entries = (audit.verified ?? []).filter(same);
    assert.equal(entries.length, 1, `npm verified no attestation for ${pkg.name}@${pkg.version}`);
    assert.equal(entries[0].registry, NPM, `${pkg.name} was not verified against npm`);
    const bundles = entries[0].attestationBundles.filter((b) => b.predicateType === SLSA);
    assert.equal(bundles.length, 1, `${pkg.name}@${pkg.version} has no single SLSA provenance attestation`);
    judgeProvenance(bundles[0].bundle, pkg, commit);
  }
}

/**
 * Runs `npm audit signatures` over a temporary consumer of exactly these
 * versions, since npm does not audit a pnpm install. npm verifies each
 * installed name and version against the registry, so the consumer holds only
 * their `package.json` stubs and downloads no package code.
 */
export function auditSignatures(packages) {
  const dir = mkdtempSync(join(tmpdir(), "pgstencil-provenance-"));
  try {
    const dependencies = {};
    for (const { name, version } of packages) {
      dependencies[name] = version;
      mkdirSync(join(dir, "node_modules", name), { recursive: true });
      writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
    }
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pgstencil-provenance", private: true, dependencies }));
    const result = spawnSync(
      "npm",
      ["audit", "signatures", "--json", "--include-attestations", `--registry=${NPM}`],
      { cwd: dir, encoding: "utf8" },
    );
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(`npm audit signatures failed: ${result.stderr || result.error?.message}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A public GitHub API read, authenticated when `GH_TOKEN` is set. */
async function github(path) {
  const token = process.env.GH_TOKEN;
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token && { authorization: `Bearer ${token}` }),
    },
  });
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}): ${path}`);
  return response.json();
}

/**
 * S120: the commit is on pgstencil `main`, and its `security-audit` runs
 * include a success and conclude nothing but success or cancelled.
 */
export async function judgeUpstream(commit, api = github) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  const { status } = await api(`repos/${REPOSITORY}/compare/${commit}...main`);
  assert.ok(["ahead", "identical"].includes(status), `pgstencil ${commit} is not on main (${status})`);
  const conclusions = [];
  for (let page = 1; ; page++) {
    const { check_runs: runs } = await api(
      `repos/${REPOSITORY}/commits/${commit}/check-runs?check_name=security-audit&per_page=100&page=${page}`,
    );
    conclusions.push(...runs.map((run) => run.conclusion));
    if (runs.length < 100) break;
  }
  assert.ok(conclusions.includes("success"), `pgstencil ${commit} has no successful security-audit`);
  for (const conclusion of conclusions)
    assert.ok(
      conclusion === "success" || conclusion === "cancelled",
      `pgstencil ${commit} has a security-audit concluding ${conclusion}`,
    );
}

/** S118's checks, then S119's and S120's, over the packages pnpm installed. */
export async function verifyProvenance({ audit = auditSignatures, api = github } = {}) {
  const { commit, packages } = await verifyPackages();
  const lock = await readFile(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8");
  const locked = packages.map((pkg) => ({ ...pkg, digest: lockedDigest(lock, pkg.name, pkg.version) }));
  judgeSignatures(audit(locked), locked, commit);
  await judgeUpstream(commit, api);
  return commit;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const commit = await verifyProvenance();
    console.log(`pgstencil ${commit}: signed provenance verified, on main, and audited.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
