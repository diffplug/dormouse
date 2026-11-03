import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyAttestations, verifyReleaseAudit } from "./pgstencil-provenance.mjs";

const COMMIT = "a".repeat(40);
/** Self-signed, shaped as Fulcio's: release identity and source digest, as each name says. */
const CERTIFICATE = {
  released: "MIIB/jCCAaSgAwIBAgIUDwKr0SmuxaVfCTvhWudBBGzCAYgwCgYIKoZIzj0EAwIwFzEVMBMGA1UECgwMdGVzdCBmaXh0dXJlMB4XDTI2MTEwMzAzNDExMVoXDTM2MTAzMTAzNDExMVowFzEVMBMGA1UECgwMdGVzdCBmaXh0dXJlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEu21QrOqIG2w3mZ4RmGTMbe1ule9slKAA7r4tFLnGAamA9/jxTou6AEO1nODH5iAEaAklGDr51I9z5vd/9RQnrKOBzTCByjAdBgNVHQ4EFgQUkbvrOg694Anc7Gc7Wf+EvI59T44wDwYDVR0TAQH/BAUwAwEB/zBeBgNVHREEVzBVhlNodHRwczovL2dpdGh1Yi5jb20vZGlmZnBsdWcvcGdzdGVuY2lsLy5naXRodWIvd29ya2Zsb3dzL3JlbGVhc2UueW1sQHJlZnMvaGVhZHMvbWFpbjA4BgorBgEEAYO/MAENBCoMKGFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEwCgYIKoZIzj0EAwIDSAAwRQIgAxRD267myBff0DQMy3p0qHXuqJ4btzO8JdJ5g/c7JqgCIQDmXT2ej31/ABeGceThD0WpcumoY/t2kJshjzKiFaSf0A==",
  otherBranch: "MIICADCCAaWgAwIBAgIUaq+kHPDuXXVuEPZaEDrwYAAHVz4wCgYIKoZIzj0EAwIwFzEVMBMGA1UECgwMdGVzdCBmaXh0dXJlMB4XDTI2MTEwMzAzNDExMVoXDTM2MTAzMTAzNDExMVowFzEVMBMGA1UECgwMdGVzdCBmaXh0dXJlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJBuoScjpynpu7sV1LKQeklpb3Dh5CZU3YogF7IJEV40M2hIF2MMH2b0QRgVzypnQug5aYY+ljdUdev/c/Hz38qOBzjCByzAdBgNVHQ4EFgQUdFLnYImviGAUBoqZF4LqOscaj5owDwYDVR0TAQH/BAUwAwEB/zBfBgNVHREEWDBWhlRodHRwczovL2dpdGh1Yi5jb20vZGlmZnBsdWcvcGdzdGVuY2lsLy5naXRodWIvd29ya2Zsb3dzL3JlbGVhc2UueW1sQHJlZnMvaGVhZHMvb3RoZXIwOAYKKwYBBAGDvzABDQQqDChhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhMAoGCCqGSM49BAMCA0kAMEYCIQCAg3Q2dVw4ppLG2Y3HvSd0V3cx+2I0UjIABcZ+z9z8gAIhANMTT5hH0O5n5lsKyobP9Plt+cFKPMsJhdL5XCNfA9uI",
  otherCommit: "MIIB/jCCAaSgAwIBAgIUIUrKV+1MBzP7HD70kP11vHHCrdowCgYIKoZIzj0EAwIwFzEVMBMGA1UECgwMdGVzdCBmaXh0dXJlMB4XDTI2MTEwMzAzNDExMVoXDTM2MTAzMTAzNDExMVowFzEVMBMGA1UECgwMdGVzdCBmaXh0dXJlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE4zdGAWI6aDZjZqTyE1D0PxmrV/LapDPz4pShhkTzPOZHwOmVWiit5ELDEFvFspo1GN4W0BUioeQcoptKFn3dL6OBzTCByjAdBgNVHQ4EFgQUMD24BTZ3vawFsblU0HO1iJkZZvcwDwYDVR0TAQH/BAUwAwEB/zBeBgNVHREEVzBVhlNodHRwczovL2dpdGh1Yi5jb20vZGlmZnBsdWcvcGdzdGVuY2lsLy5naXRodWIvd29ya2Zsb3dzL3JlbGVhc2UueW1sQHJlZnMvaGVhZHMvbWFpbjA4BgorBgEEAYO/MAENBCoMKGJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmIwCgYIKoZIzj0EAwIDSAAwRQIgeeTVkBzkds5App5J4iMD4cxCIqGBPLGV9FakCFCDE7oCIQD0bsNRqjLcD6Z+c8c7UfbAlbn483zbn+4ASUR7rqKAcA==",
  noDigest: "MIIBxDCCAWqgAwIBAgIUW4leO3jO0MP6rAPbkiz9rtVFJLAwCgYIKoZIzj0EAwIwFzEVMBMGA1UECgwMdGVzdCBmaXh0dXJlMB4XDTI2MTEwMzAzNDExMVoXDTM2MTAzMTAzNDExMVowFzEVMBMGA1UECgwMdGVzdCBmaXh0dXJlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYg+TCcEEzq+CTekJAa8hTa6z1eft1XcINRzGwDTh6iGj5H5qYuiLF8TigTGnlTOUDJnepQVRjnd6Zf2wTz9SmaOBkzCBkDAdBgNVHQ4EFgQUwGvInS/NbO+Xaees6YgZVKREoo8wDwYDVR0TAQH/BAUwAwEB/zBeBgNVHREEVzBVhlNodHRwczovL2dpdGh1Yi5jb20vZGlmZnBsdWcvcGdzdGVuY2lsLy5naXRodWIvd29ya2Zsb3dzL3JlbGVhc2UueW1sQHJlZnMvaGVhZHMvbWFpbjAKBggqhkjOPQQDAgNIADBFAiBJDpaJrpSL5U9J59ER94AxntV5+BGBNI74LUn4f7QWPQIhAPtmnx4qHPDzaOMOtMMZCfxDXtwSYiu7Z9zhIPgErBHn",
};

const payload = (name, change = {}) =>
  Buffer.from(
    JSON.stringify({
      subject: [{ name: change.subject ?? `pkg:npm/${name.replace("@", "%40")}@1.2.3`, digest: { sha512: "x" } }],
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              ref: change.ref ?? "refs/heads/main",
              repository: "https://github.com/diffplug/pgstencil",
              path: ".github/workflows/release.yml",
            },
          },
          resolvedDependencies: [{ uri: "git+https://example.test", digest: { gitCommit: change.commit ?? COMMIT } }],
        },
      },
    }),
  ).toString("base64");

const provenance = (name, change = {}) => ({
  predicateType: "https://slsa.dev/provenance/v1",
  bundle: {
    verificationMaterial: { certificate: { rawBytes: change.certificate ?? CERTIFICATE.released } },
    dsseEnvelope: { payload: payload(name, change) },
  },
});

/** npm's report for all three packages, with `change` applied to `@pgstencil/auth`'s provenance. */
const report = (change) => ({
  verified: ["pgstencil", "@pgstencil/auth", "@pgstencil/stripe"].map((name) => ({
    name,
    version: "1.2.3",
    attestationBundles: [
      { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", bundle: {} },
      provenance(name, name === "@pgstencil/auth" ? change : {}),
    ],
  })),
});

test("verifyAttestations admits a release its own workflow signed from the commit the packages name", () => {
  verifyAttestations(report(), COMMIT);
  // The other shape a sigstore bundle carries its certificate in.
  const chained = report();
  for (const { attestationBundles } of chained.verified) {
    const { bundle } = attestationBundles[1];
    bundle.verificationMaterial = {
      x509CertificateChain: { certificates: [{ rawBytes: bundle.verificationMaterial.certificate.rawBytes }] },
    };
  }
  verifyAttestations(chained, COMMIT);
});

test("verifyAttestations refuses each thing a release could disagree on", () => {
  const refused = (change, message) => assert.throws(() => verifyAttestations(report(change), COMMIT), { message });
  refused({ certificate: CERTIFICATE.otherBranch }, /signed by another identity/);
  refused({ certificate: CERTIFICATE.otherCommit }, /certificate names another commit/);
  refused({ certificate: CERTIFICATE.noDigest }, /certificate names another commit/);
  refused({ subject: "pkg:npm/%40pgstencil/auth@9.9.9" }, /provenance names another package/);
  refused({ ref: "refs/heads/other" }, /provenance names another workflow/);
  refused({ commit: "b".repeat(40) }, /provenance names another commit/);
  // The installed packages name another commit than a release that is otherwise fine.
  assert.throws(() => verifyAttestations(report(), "b".repeat(40)), /certificate names another commit/);
});

test("verifyAttestations refuses a package with no verified provenance", () => {
  const without = (edit) => {
    const edited = report();
    edit(edited.verified.find(({ name }) => name === "@pgstencil/stripe"));
    return edited;
  };
  assert.throws(() => verifyAttestations({}, COMMIT), /pgstencil has no verified attestation/);
  for (const refusal of ["invalid", "missing"]) {
    assert.throws(
      () => verifyAttestations({ ...report(), [refusal]: [{ name: "@pgstencil/auth" }] }, COMMIT),
      new RegExp(`npm reports @pgstencil/auth ${refusal}`),
    );
  }
  // Another package's trouble in Hosted's tree does not gate here.
  verifyAttestations({ ...report(), invalid: [{ name: "left-pad" }], missing: [{ name: "left-pad" }] }, COMMIT);
  assert.throws(
    () => verifyAttestations({ verified: report().verified.slice(0, 2) }, COMMIT),
    /@pgstencil\/stripe has no verified attestation/,
  );
  assert.throws(
    () => verifyAttestations(without((entry) => entry.attestationBundles.pop()), COMMIT),
    /no verified provenance attestation/,
  );
  assert.throws(
    () => verifyAttestations(without((entry) => delete entry.attestationBundles), COMMIT),
    /no verified provenance attestation/,
  );
});

/** GitHub, answering for `COMMIT` as `answers` says. */
const github = ({ status = "ahead", conclusions = ["success"], code = 200 } = {}) => {
  const asked = [];
  const fetcher = async (url, init) => {
    asked.push({ url, authorization: init.headers.authorization });
    const page = Number(new URL(url).searchParams.get("page"));
    const body = url.includes("/compare/")
      ? { status }
      : { check_runs: conclusions.slice((page - 1) * 100, page * 100).map((conclusion) => ({ conclusion })) };
    return new Response(JSON.stringify(body), { status: code });
  };
  return { fetcher, asked };
};

test("verifyReleaseAudit admits a commit on main whose audit passed", async () => {
  for (const answers of [
    {},
    { status: "identical" },
    { conclusions: ["cancelled", "success"] },
    { conclusions: [...Array(100).fill("cancelled"), "success"] },
  ]) {
    await verifyReleaseAudit(COMMIT, github(answers).fetcher, "token");
  }
  const { fetcher, asked } = github();
  await verifyReleaseAudit(COMMIT, fetcher, "token");
  assert.deepEqual(asked, [
    { url: `https://api.github.com/repos/diffplug/pgstencil/compare/${COMMIT}...main`, authorization: "Bearer token" },
    {
      url: `https://api.github.com/repos/diffplug/pgstencil/commits/${COMMIT}/check-runs?check_name=security-audit&per_page=100&page=1`,
      authorization: "Bearer token",
    },
  ]);
});

test("verifyReleaseAudit refuses a commit off main, unaudited, not passed, or unanswered", async () => {
  const refused = (answers, message) =>
    assert.rejects(verifyReleaseAudit(COMMIT, github(answers).fetcher, "token"), { message });
  await refused({ status: "behind" }, /is not on main/);
  await refused({ status: "diverged" }, /is not on main/);
  await refused({ conclusions: [] }, /no passing security-audit/);
  await refused({ conclusions: ["cancelled"] }, /no passing security-audit/);
  await refused({ conclusions: ["success", "failure"] }, /did not pass/);
  await refused({ conclusions: ["success", null] }, /did not pass/);
  await refused({ conclusions: [...Array(100).fill("success"), "failure"] }, /did not pass/);
  await refused({ code: 403 }, /answered .* with 403/);
});
