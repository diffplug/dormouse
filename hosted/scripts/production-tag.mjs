import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function productionDay(timestamp) {
  const date = new Date(timestamp);
  assert.ok(
    Number.isFinite(date.getTime()),
    "Supply a valid deployment timestamp",
  );
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function nextProductionTag(day, names) {
  const base = `hosted/${day}`;
  const pattern = new RegExp(`^${base}(?:--r([2-9]|[1-9][0-9]+))?$`);
  let revision = 0;
  for (const name of names) {
    const match = name.match(pattern);
    if (match) revision = Math.max(revision, Number(match[1] ?? 1));
  }
  return revision === 0 ? base : `${base}--r${revision + 1}`;
}

function github(path, body) {
  const args = ["api", "--method", body ? "POST" : "GET", path];
  if (body) args.push("--input", "-");
  const result = spawnSync("gh", args, {
    input: body ? JSON.stringify(body) : undefined,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`GitHub deployment tag request failed: ${path}`);
  return JSON.parse(result.stdout);
}

export async function recordDeployment(
  { repository, sha, verifiedAt, deploymentId },
  api = github,
) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.match(deploymentId, /^[1-9]\d*\/[1-9]\d*$/);
  const day = productionDay(verifiedAt);
  const prefix = `repos/${repository}/git`;
  const refs = await api(`${prefix}/matching-refs/tags/hosted/${day}`);
  const marker = `Deployment: ${deploymentId}`;
  // Retrying only the tag job must not invent another deployment.
  for (const ref of refs) {
    if (ref.object.type !== "tag") continue;
    const tag = await api(`${prefix}/tags/${ref.object.sha}`);
    if (tag.message.split("\n").includes(marker)) {
      assert.equal(tag.object.type, "commit");
      assert.equal(
        tag.object.sha,
        sha,
        "Existing deployment tag points to a different commit",
      );
      return ref.ref.replace("refs/tags/", "");
    }
  }
  const name = nextProductionTag(
    day,
    refs.map((ref) => ref.ref.replace("refs/tags/", "")),
  );
  const [runId, attempt] = deploymentId.split("/");
  const tag = await api(`${prefix}/tags`, {
    tag: name,
    object: sha,
    type: "commit",
    message: `Verified production deployment\n\n${marker}\nVerified at: ${new Date(verifiedAt).toISOString()}\nWorkflow: https://github.com/${repository}/actions/runs/${runId}/attempts/${attempt}\n`,
  });
  // Create only: never move or overwrite a production tag. A conflict fails safely.
  await api(`${prefix}/refs`, { ref: `refs/tags/${name}`, sha: tag.sha });
  return name;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const name = await recordDeployment({
      repository: process.env.GITHUB_REPOSITORY,
      sha: process.env.BUILD_SHA,
      verifiedAt: process.env.DEPLOYMENT_VERIFIED_AT,
      deploymentId: process.env.DEPLOYMENT_ID,
    });
    console.log(`Production deployment recorded: ${name}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `Production tag: [${name}](https://github.com/${process.env.GITHUB_REPOSITORY}/tree/${name})\n`,
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
