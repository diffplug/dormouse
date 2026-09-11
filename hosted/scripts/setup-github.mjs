import { spawnSync } from "node:child_process";

// Uses the operator's existing gh keychain authentication. Never handles secret values.
const repository = "diffplug/dormouse";
function api(path, method = "GET", body) {
  const args = ["api", "--method", method, `repos/${repository}/${path}`];
  if (body) args.push("--input", "-");
  const result = spawnSync("gh", args, {
    input: body && JSON.stringify(body),
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`GitHub setup failed: ${method} ${path}`);
  return result.stdout ? JSON.parse(result.stdout) : undefined;
}
// Reviewed preview code can receive only dedicated test credentials. Production and tag
// identities additionally require main, preserving the repository's admin-only merge gate.
const reviewers = [
  { type: "User", id: 2924992 },
  { type: "User", id: 68454991 },
];
for (const name of [
  "hosted-preview",
  "hosted-production",
  "hosted-release-tag",
]) {
  api(`environments/${name}`, "PUT", {
    reviewers,
    prevent_self_review: false,
    can_admins_bypass: false,
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  });
  const expected =
    name === "hosted-preview" ? ["main", "refs/pull/*/merge"] : ["main"];
  const policies = api(
    `environments/${name}/deployment-branch-policies`,
  ).branch_policies;
  for (const policy of policies) {
    if (policy.type !== "branch" || !expected.includes(policy.name))
      throw new Error(
        `Unexpected deployment policy in ${name}; review it before continuing`,
      );
  }
  for (const pattern of expected) {
    if (!policies.some((p) => p.name === pattern))
      api(`environments/${name}/deployment-branch-policies`, "POST", {
        name: pattern,
        type: "branch",
      });
  }
  console.log(`Configured ${name}`);
}
console.log(
  "Next: hosted/DEPLOYMENT.md. Previews remain disabled until HOSTED_PREVIEWS_ENABLED=true.",
);
