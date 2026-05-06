import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChangelog } from "./changelog-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const changelogPath = resolve(repoRoot, "CHANGELOG.md");
const outPath = resolve(__dirname, "../src/data/changelog.json");

const changelog = parseChangelog(readFileSync(changelogPath, "utf-8"));

writeFileSync(outPath, JSON.stringify(changelog, null, 2) + "\n");
console.log(`Wrote ${changelog.releases.length} changelog releases to src/data/changelog.json`);
