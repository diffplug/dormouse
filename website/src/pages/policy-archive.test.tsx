// docs/specs/hosted.md -> "Terms acceptance": every version of the Hosted terms
// and privacy policy stays at its own URL, as a static file checked in here.
//
// To publish a new version, after moving TERMS_VERSION:
//   WRITE_POLICY_ARCHIVE=1 pnpm --filter dormouse-website exec vitest run src/pages/policy-archive.test.tsx
// writes the files it lacks, never one that exists. The test then fails naming
// each new file's hash for PUBLISHED below.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { TERMS_VERSION, termsArchiveUrl } from "../../../hosted/server/policy-constants";
import { PolicyText, type PolicyPage } from "../components/HostedPolicyLayout";
import { PRIVACY_PAGE } from "./Privacy";
import { TERMS_PAGE } from "./Terms";

/**
 * Each published file's SHA-256: never edit or remove an entry, because a
 * buyer's agreement and its emailed link name that text.
 */
const PUBLISHED: Record<string, string> = {
  "privacy/2026-10-30": "8ea8f468b67b3abc6ba55caf290b1e082bed01b57846e94ec7450b576d7f6b64",
  "privacy/2026-11-03": "97b754d37b337864dc8be72ea822c4ffcc3be82a9fb181440d61932c8cb8d1fc",
  "terms/2026-10-30": "d4a503ae7844db998d774afc873bfba3aab09b4c3fb93f43aa2278746da803bf",
  "terms/2026-11-03": "e470548890e0fe385c597d81a78b24a000e01631bd4a9763bbab28de0b32762e",
};

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "../../public");
const fileOf = (path: string) => resolve(PUBLIC, `.${path}index.html`);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Both policies print one revision date, which `TERMS_VERSION` is. */
const POLICIES: { live: string; page: PolicyPage }[] = [
  { live: "/terms/", page: TERMS_PAGE },
  { live: "/privacy/", page: PRIVACY_PAGE },
];

/**
 * A version's file: the policy's text as its live page renders it, without the
 * site's classes, so restyling the site never reads as a new version, and with
 * a break before each block, so one version's diff against the last is readable.
 */
function archive(live: string, version: string, page: PolicyPage) {
  const html = renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{`${page.title}, version ${version}`}</title>
        <style>{"body{max-width:46rem;margin:auto;padding:2rem 1rem;font:1rem/1.5 system-ui,sans-serif}"}</style>
      </head>
      <body>
        <p>
          <em>
            Version {version} of this document, kept unchanged. The current version is at <a href={live}>dormouse.sh{live}</a>.
          </em>
        </p>
        <main>
          <PolicyText {...page} />
        </main>
      </body>
    </html>,
  );
  return `<!DOCTYPE html>${html.replace(/ class="[^"]*"/g, "").replace(/<(p|h1|h2|section|main|ul|ol|li)\b/g, "\n<$1")}\n`;
}

describe.each(POLICIES)("$live", ({ live, page }) => {
  const path = `${live}${TERMS_VERSION}/`;
  const expected = archive(live, TERMS_VERSION, page);
  if (process.env.WRITE_POLICY_ARCHIVE && !existsSync(fileOf(path))) {
    mkdirSync(dirname(fileOf(path)), { recursive: true });
    writeFileSync(fileOf(path), expected);
  }

  test("the current version has an archive, holding what the page renders", () => {
    expect(existsSync(fileOf(path)), `${path} has no archive: see this test's header`).toBe(true);
    expect(readFileSync(fileOf(path), "utf8"), `${path} is not what the page renders: move TERMS_VERSION`).toBe(expected);
  });
});

test("the terms URL the account pages and emails link is the current version's archive", () => {
  expect(existsSync(fileOf(new URL(termsArchiveUrl(TERMS_VERSION)).pathname))).toBe(true);
});

test("a published version never changes or goes away, and every archived file is listed", () => {
  const onDisk = POLICIES.flatMap(({ live }) =>
    readdirSync(resolve(PUBLIC, `.${live}`)).map((version) => `${live.slice(1)}${version}`),
  );
  const hashes = Object.fromEntries(
    onDisk.map((name) => [name, sha256(readFileSync(fileOf(`/${name}/`), "utf8"))]),
  );
  expect(hashes).toEqual(PUBLISHED);
});
