#!/usr/bin/env node
/**
 * What the production `verify` job holds an installed pgstencil release to
 * beyond npm's own verdict (`docs/specs/security-hosted.md` -> "Deployment
 * boundary"): who signed it, from which commit, and that commit's audit.
 *
 *   node hosted/scripts/pgstencil-provenance.mjs <npm audit signatures report>
 */
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGSTENCIL_PACKAGES, verifyPackages } from "./production.mjs";

const REPOSITORY = "diffplug/pgstencil";
const WORKFLOW = ".github/workflows/release.yml";
const REF = "refs/heads/main";
const SIGNER = `URI:https://github.com/${REPOSITORY}/${WORKFLOW}@${REF}`;
const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
/** Fulcio's source-repository digest, 1.3.6.1.4.1.57264.1.13, as DER. */
const SOURCE_DIGEST_OID = Buffer.from("2b0601040183bf30010d", "hex");

/** The DER values directly inside `der`. */
function derChildren(der) {
  const children = [];
  for (let at = 0; at < der.length; ) {
    const tag = der[at++];
    let length = der[at++];
    if (length & 0x80) {
      const bytes = length & 0x7f;
      length = der.subarray(at, at + bytes).reduce((sum, byte) => sum * 256 + byte, 0);
      at += bytes;
    }
    children.push({ tag, value: der.subarray(at, at + length) });
    at += length;
  }
  return children;
}

/** Fulcio's source-repository digest in a certificate's extensions, or `null`. */
function sourceDigestOf(certificate) {
  const [tbs] = derChildren(derChildren(certificate)[0].value);
  // `[3]`, the extensions of an X.509 v3 TBSCertificate.
  const extensions = derChildren(tbs.value).find(({ tag }) => tag === 0xa3);
  if (!extensions) return null;
  for (const { value } of derChildren(derChildren(extensions.value)[0].value)) {
    const fields = derChildren(value);
    if (fields[0].value.equals(SOURCE_DIGEST_OID)) {
      return derChildren(fields.at(-1).value)[0].value.toString("utf8");
    }
  }
  return null;
}

const certificateOf = ({ verificationMaterial: material }) =>
  Buffer.from(material.certificate?.rawBytes ?? material.x509CertificateChain?.certificates[0].rawBytes, "base64");

const purlOf = (name, version) => `pkg:npm/${name.replace("@", "%40")}@${version}`;

/** Holds one verified provenance `bundle` of `name@version` to `commit`. */
function verifyProvenance(name, version, bundle, commit) {
  const release = `${name}@${version}`;
  const der = certificateOf(bundle);
  assert.equal(new X509Certificate(der).subjectAltName, SIGNER, `${release} was signed by another identity`);
  assert.equal(sourceDigestOf(der), commit, `${release}'s certificate names another commit`);
  const { subject, predicate } = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  assert.deepEqual(subject.map((one) => one.name), [purlOf(name, version)], `${release}'s provenance names another package`);
  const { externalParameters, resolvedDependencies } = predicate.buildDefinition;
  const { ref, repository, path } = externalParameters.workflow;
  assert.deepEqual(
    { ref, repository, path },
    { ref: REF, repository: `https://github.com/${REPOSITORY}`, path: WORKFLOW },
    `${release}'s provenance names another workflow`,
  );
  const sources = resolvedDependencies.map((one) => one.digest?.gitCommit).filter(Boolean);
  assert.ok(sources.length && sources.every((source) => source === commit), `${release}'s provenance names another commit`);
}

/**
 * Holds `report`, what `npm audit signatures --json --include-attestations`
 * printed, to `commit`, the one `dist/provenance.json` names. A package counts
 * only from `verified`, and never with an entry in `invalid` or `missing`. npm
 * has verified each bundle's signature, chain, and subject digest; who signed is
 * not its question, and the payload's workflow is only the signer's own claim.
 */
export function verifyAttestations(report, commit) {
  for (const { name } of PGSTENCIL_PACKAGES) {
    for (const refusal of ["invalid", "missing"]) {
      assert.ok(!report[refusal]?.some((entry) => entry.name === name), `npm reports ${name} ${refusal}`);
    }
    const entries = (report.verified ?? []).filter((entry) => entry.name === name);
    assert.ok(entries.length, `${name} has no verified attestation`);
    for (const { version, attestationBundles = [] } of entries) {
      const provenance = attestationBundles.filter(({ predicateType }) => predicateType === PROVENANCE_PREDICATE);
      assert.ok(provenance.length, `${name}@${version} has no verified provenance attestation`);
      for (const { bundle } of provenance) verifyProvenance(name, version, bundle, commit);
    }
  }
}

/** `path` of GitHub's API, as JSON, by `fetcher`; anything but a 200 refuses. */
const githubJson = async (path, fetcher, token) => {
  const response = await fetcher(`https://api.github.com/${path}`, {
    headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(response.status, 200, `GitHub answered ${path} with ${response.status}`);
  return response.json();
};

/**
 * Holds `commit` to pgstencil's `main` and its `security-audit` check: at least
 * one `success`, and nothing but `success` and `cancelled`, a stopped manual run.
 * A run still going has no conclusion, and so refuses.
 */
export async function verifyReleaseAudit(commit, fetcher = fetch, token = process.env.GH_TOKEN) {
  const { status } = await githubJson(`repos/${REPOSITORY}/compare/${commit}...main`, fetcher, token);
  assert.ok(status === "ahead" || status === "identical", `pgstencil commit ${commit} is not on main (${status})`);
  const conclusions = [];
  for (let page = 1; ; page++) {
    const { check_runs: runs } = await githubJson(
      `repos/${REPOSITORY}/commits/${commit}/check-runs?check_name=security-audit&per_page=100&page=${page}`,
      fetcher,
      token,
    );
    conclusions.push(...runs.map((run) => run.conclusion));
    if (runs.length < 100) break;
  }
  assert.ok(conclusions.includes("success"), `pgstencil commit ${commit} has no passing security-audit`);
  const others = conclusions.filter((conclusion) => conclusion !== "success" && conclusion !== "cancelled");
  assert.deepEqual(others, [], `pgstencil commit ${commit} has a security-audit that did not pass`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const commit = await verifyPackages();
    verifyAttestations(JSON.parse(await readFile(process.argv[2], "utf8")), commit);
    await verifyReleaseAudit(commit);
    console.log(`pgstencil ${commit}: release identity, attestations, and security-audit verified.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
