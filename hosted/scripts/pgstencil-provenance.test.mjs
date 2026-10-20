import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  judgeSignatures,
  judgeUpstream,
  lockedDigest,
  verifyProvenance,
} from "./pgstencil-provenance.mjs";

/**
 * `npm audit signatures --json --include-attestations` for pgstencil 0.4.0,
 * trimmed to each package's SLSA bundle's certificate and envelope.
 */
const AUDIT = JSON.parse(
  readFileSync(new URL("./fixtures/pgstencil-0.4.0-signatures.json", import.meta.url), "utf8"),
);
const COMMIT = "ddf68eadcefbbf7cf7c5351e032706106baffc26";
/** The 0.4.0 entries of `pnpm-lock.yaml`'s packages, as pnpm writes them. */
const LOCK = `packages:

  '@pgstencil/auth@0.4.0':
    resolution: {integrity: sha512-isQq1k8YxUCJyISCO7TpwGkwmfer+nGVbqsIZbrD2Na8G59B20p5bU+IL09z7tbVL80THJdD9p+PEyE0R1FuXA==}
    engines: {node: '>=24'}

  pgstencil@0.4.0:
    resolution: {integrity: sha512-81Y6LTzIc1RkOh5eiRmPXuwVTR0s8+aB6DGmI/TE08LzRfozskVzaKdK3Cd6++gNPp6GsEqG9yFSFNd3unUmYw==}
    engines: {node: '>=24'}
`;
const PACKAGES = ["pgstencil", "@pgstencil/auth"].map((name) => ({
  name,
  version: "0.4.0",
  digest: lockedDigest(LOCK, name, "0.4.0"),
}));
const audit = () => structuredClone(AUDIT);
const bundleOf = (copy, index = 0) => copy.verified[index].attestationBundles[0].bundle;
/** A failed `assert` whose message starts with `message`. */
const failure = (message) => ({ message: new RegExp(`^${RegExp.escape(message)}`) });

/** Rewrites the certificate's DER bytes: `from` to `to`, same length, at `after`'s first match on. */
function editCertificate(bundle, from, to, after = "") {
  const raw = Buffer.from(bundle.verificationMaterial.certificate.rawBytes, "base64");
  const at = raw.indexOf(from, raw.indexOf(after));
  assert.ok(at >= 0 && from.length === to.length);
  raw.write(to, at);
  bundle.verificationMaterial.certificate.rawBytes = raw.toString("base64");
}
/** Rewrites the signed statement; npm's signature check is upstream of the judge. */
function editStatement(bundle, edit) {
  const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64"));
  edit(statement);
  bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
}

test("the lockfile's sha512 for an exact version, as hex", () => {
  assert.equal(
    PACKAGES[0].digest,
    "f3563a2d3cc87354643a1e5e89198f5eec154d1d2cf3e681e831a623f4c4d3c2f345fa33b2457368a74adc277afbe80d3e9e86b04a86f7215214d777ba752663",
  );
  assert.throws(() => lockedDigest(LOCK, "pgstencil", "0.4.1"), failure("pnpm-lock.yaml has no sha512 integrity for pgstencil@0.4.1"));
  assert.throws(() => lockedDigest(LOCK.replace("sha512-81", "sha1-81"), "pgstencil", "0.4.0"));
});

test("npm-verified provenance from pgstencil's release workflow on main, for the installed tarballs and commit, passes", () => {
  judgeSignatures(audit(), PACKAGES, COMMIT);
});

test("a certificate from another signer, or naming another source commit, fails", () => {
  const signer = audit();
  // The SAN, the first of the DER's signer URIs.
  editCertificate(bundleOf(signer), "@refs/heads/main", "@refs/heads/mair");
  assert.throws(() => judgeSignatures(signer, PACKAGES, COMMIT), failure("pgstencil was not signed by pgstencil's release workflow on main"));

  // Only the Source Repository Digest extension (OID 1.3.6.1.4.1.57264.1.13).
  const digest = audit();
  editCertificate(bundleOf(digest), COMMIT, `${"0".repeat(39)}1`, Buffer.from("2b0601040183bf30010d", "hex"));
  assert.throws(() => judgeSignatures(digest, PACKAGES, COMMIT), failure("pgstencil's certificate names another source commit"));

  // The other package's certificate does not stand in for this one's commit.
  assert.throws(() => judgeSignatures(audit(), PACKAGES, "a".repeat(40)), failure("pgstencil's certificate names another source commit"));
});

test("a statement for another package, tarball, workflow, or commit fails", () => {
  const cases = [
    ["pgstencil's attestation names another package or tarball", (s) => (s.subject[0].digest.sha512 = "0".repeat(128))],
    ["pgstencil's attestation names another package or tarball", (s) => (s.subject[0].name = "pkg:npm/pgstencil@0.3.0")],
    ["pgstencil's attestation names another package or tarball", (s) => s.subject.push(s.subject[0])],
    ["pgstencil's attestation names another workflow", (s) => (s.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml")],
    ["pgstencil's attestation names another workflow", (s) => (s.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/feature")],
    ["pgstencil's attestation names another workflow", (s) => (s.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/someone/pgstencil")],
    ["pgstencil's attestation names another source commit", (s) => (s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "a".repeat(40))],
    ["pgstencil's attestation names another source commit", (s) => s.predicate.buildDefinition.resolvedDependencies.push({ uri: "git+https://github.com/someone/x@refs/heads/main" })],
  ];
  for (const [message, edit] of cases) {
    const copy = audit();
    editStatement(bundleOf(copy), edit);
    assert.throws(() => judgeSignatures(copy, PACKAGES, COMMIT), failure(message), message);
  }
  const kinds = [
    (bundle) => editStatement(bundle, (s) => (s.predicateType = "https://slsa.dev/provenance/v0.2")),
    (bundle) => editStatement(bundle, (s) => (s._type = "https://in-toto.io/Statement/v0.1")),
    (bundle) => (bundle.dsseEnvelope.payloadType = "application/json"),
  ];
  for (const edit of kinds) {
    const copy = audit();
    edit(bundleOf(copy));
    assert.throws(() => judgeSignatures(copy, PACKAGES, COMMIT), failure("pgstencil's attestation is not an in-toto SLSA provenance statement"));
  }
  // A scoped package's subject keeps its percent-encoded `@`.
  const scoped = audit();
  editStatement(bundleOf(scoped, 1), (s) => (s.subject[0].name = "pkg:npm/@pgstencil/auth@0.4.0"));
  assert.throws(() => judgeSignatures(scoped, PACKAGES, COMMIT), failure("@pgstencil/auth's attestation names another package or tarball"));
});

test("a package npm did not verify, from another registry, or without one SLSA bundle fails", () => {
  const invalid = audit();
  invalid.invalid.push({ name: "@pgstencil/auth", version: "0.4.0", code: "EATTESTATIONVERIFY" });
  assert.throws(() => judgeSignatures(invalid, PACKAGES, COMMIT), failure("npm could not verify @pgstencil/auth@0.4.0's signatures"));

  const missing = audit();
  missing.missing.push({ name: "pgstencil", version: "0.4.0" });
  assert.throws(() => judgeSignatures(missing, PACKAGES, COMMIT), failure("npm could not verify pgstencil@0.4.0's signatures"));

  const absent = audit();
  absent.verified.pop();
  assert.throws(() => judgeSignatures(absent, PACKAGES, COMMIT), failure("npm verified no attestation for @pgstencil/auth@0.4.0"));
  assert.throws(() => judgeSignatures({ error: { code: "ENETUNREACH" } }, PACKAGES, COMMIT), failure("npm verified no attestation for pgstencil@0.4.0"));

  const version = audit();
  version.verified[0].version = "0.3.0";
  assert.throws(() => judgeSignatures(version, PACKAGES, COMMIT), failure("npm verified no attestation for pgstencil@0.4.0"));

  const registry = audit();
  registry.verified[0].registry = "https://registry.example/";
  assert.throws(() => judgeSignatures(registry, PACKAGES, COMMIT), failure("pgstencil was not verified against npm"));

  const none = audit();
  none.verified[0].attestationBundles = [];
  assert.throws(() => judgeSignatures(none, PACKAGES, COMMIT), failure("pgstencil@0.4.0 has no single SLSA provenance attestation"));
  const two = audit();
  two.verified[0].attestationBundles.push(two.verified[0].attestationBundles[0]);
  assert.throws(() => judgeSignatures(two, PACKAGES, COMMIT), failure("pgstencil@0.4.0 has no single SLSA provenance attestation"));
});

test("the installed packages' versions and locked tarball digests reach npm, and its verdict gates the upstream check", async () => {
  const installed = (name) =>
    JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8")).version;
  let seen;
  const asked = [];
  await assert.rejects(
    verifyProvenance({
      audit: (packages) => ((seen = packages), { verified: [], invalid: [], missing: [] }),
      api: async (path) => asked.push(path),
    }),
    failure(`npm verified no attestation for pgstencil@${installed("pgstencil")}`),
  );
  assert.deepEqual(seen.map(({ name, version }) => [name, version]), [
    ["pgstencil", installed("pgstencil")],
    ["@pgstencil/auth", installed("@pgstencil/auth")],
  ]);
  for (const { digest } of seen) assert.match(digest, /^[a-f0-9]{128}$/);
  assert.deepEqual(asked, []);
});

/** A GitHub API fake: the compare status, then pages of check-run conclusions. */
function github(status, ...pages) {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.includes("/compare/")) return { status };
    const page = Number(new URL(path, "https://api.github.com/").searchParams.get("page"));
    return { check_runs: (pages[page - 1] ?? []).map((conclusion) => ({ name: "security-audit", conclusion })) };
  };
  return { api, calls };
}

test("an upstream commit on main with a successful security-audit passes, and asks only pgstencil", async () => {
  for (const status of ["ahead", "identical"]) {
    const { api, calls } = github(status, ["success", "cancelled"]);
    await judgeUpstream(COMMIT, api);
    assert.deepEqual(calls, [
      `repos/diffplug/pgstencil/compare/${COMMIT}...main`,
      `repos/diffplug/pgstencil/commits/${COMMIT}/check-runs?check_name=security-audit&per_page=100&page=1`,
    ]);
  }
});

test("a commit off main, or without a passing security-audit, fails", async () => {
  for (const status of ["behind", "diverged"])
    await assert.rejects(judgeUpstream(COMMIT, github(status, ["success"]).api), failure(`pgstencil ${COMMIT} is not on main (${status})`));
  await assert.rejects(judgeUpstream(COMMIT, github("ahead", []).api), failure(`pgstencil ${COMMIT} has no successful security-audit`));
  await assert.rejects(judgeUpstream(COMMIT, github("ahead", ["cancelled"]).api), failure(`pgstencil ${COMMIT} has no successful security-audit`));
  for (const conclusion of ["failure", "timed_out", "action_required", "neutral", "skipped", null])
    await assert.rejects(
      judgeUpstream(COMMIT, github("ahead", ["success", conclusion]).api),
      failure(`pgstencil ${COMMIT} has a security-audit concluding ${conclusion}`),
    );
  // A failure on a later page counts.
  const { api, calls } = github("ahead", Array(100).fill("success"), ["failure"]);
  await assert.rejects(judgeUpstream(COMMIT, api), failure(`pgstencil ${COMMIT} has a security-audit concluding failure`));
  assert.equal(calls.length, 3);
  await assert.rejects(judgeUpstream("main", github("identical", ["success"]).api));
});

test("the production verify job runs the provenance check with a read-only token", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/hosted-production.yml", import.meta.url),
    "utf8",
  );
  const start = workflow.indexOf("\n  verify:\n");
  const verify = workflow.slice(start, workflow.indexOf("\n  deploy:\n"));
  const step = verify.match(/\n      - name: [^\n]+\n        run: node hosted\/scripts\/pgstencil-provenance\.mjs\n        env:\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/);
  assert.ok(step, "verify runs hosted/scripts/pgstencil-provenance.mjs with GH_TOKEN from github.token");
  assert.ok(verify.indexOf(step[0]) < verify.indexOf("actions/upload-artifact@"), "before the deploy's artifact is uploaded");
  assert.doesNotMatch(verify, /permissions:/);
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.match(workflow, /\n  deploy:\n    needs: verify\n/);
});
