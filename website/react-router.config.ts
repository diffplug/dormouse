import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "@react-router/dev/config";

type ChangelogData = {
  releases: Array<{
    version: string;
    tag: string;
  }>;
};

const configDir = dirname(fileURLToPath(import.meta.url));

function getChangelogAfterPaths() {
  const changelogPath = resolve(configDir, "src/data/changelog.json");
  const changelog = JSON.parse(readFileSync(changelogPath, "utf-8")) as ChangelogData;
  const paths = new Set<string>();

  for (const release of changelog.releases) {
    paths.add(`/changelog/after/${release.version}`);
    paths.add(`/changelog/after/${release.tag}`);
  }

  return [...paths];
}

export default {
  appDirectory: "src",
  buildDirectory: "dist",
  ssr: false,
  prerender() {
    return [
      "/",
      "/playground",
      "/playground/desktop",
      "/playground/pocket",
      "/pocket",
      "/changelog",
      "/supply-chain",
      ...getChangelogAfterPaths(),
    ];
  },
} satisfies Config;
