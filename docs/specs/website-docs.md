# Website Documentation

> See `docs/specs/glossary.md` for canonical Surface / Session / Pane
> vocabulary used by the public product guide and browser workflow.

Dormouse has one general user guide and two specialized references, all served
from the marketing site and all generated from sources that live next to the
code they describe.

```text
/docs                 product guide
  /docs/dor           dor CLI reference
  /docs/agent-skill   exact bundled agent skill
```

The global website **Docs** link points to `/docs`.
Source of truth: `website/src/routes.ts`, `website/src/components/SiteHeader.tsx`.

| Surface | Purpose | Canonical content |
| --- | --- | --- |
| Homepage | Product marketing, visual proof, playground and download conversion | `website/src/pages/Home.tsx` |
| Marketplace and Open VSX | Extension discovery, evaluation, and basic onboarding | `vscode-ext/README.md` plus public metadata in `vscode-ext/package.json` |
| `/docs` | General guide for VS Code and standalone | Fixed-delta web rendering of `vscode-ext/README.md` |
| `/docs/dor` | Complete CLI reference | Help snapshots in `dor/test/snapshots/help/`, verified against the built CLI |
| `/docs/agent-skill` | Agent-facing operating guide | Exact `dor/skill.md` |
| GitHub root | Repository overview and contributor entry point | Root `README.md` |

Internal specs remain maintainer references. Public docs are written from
shipped behavior above each spec's fold and do not expose host plumbing,
internal state shapes, or staged `## Future` material.

## Canonical product guide

`vscode-ext/README.md` is the single authored source for the general product
guide. It works without prose forks in three renderers: the VS Code
Marketplace, Open VSX, and `https://dormouse.sh/docs`.

The guide is host-neutral at the top level; VS Code and standalone instructions
live under explicit subsections rather than relying on the website to rewrite
host-specific prose. Its sections are:

```text
## Get Dormouse
## Layout and panes
## Alerts and TODOs
## Browsers for you and your agents
## Mouse, selection, and copy/paste
## Keyboard shortcuts
## Themes and host integration
## Getting started  (### VS Code, ### Standalone)
## Automation and agents
## Help and project links
```

Content invariants, enforced by the public-doc lint where mechanically
checkable and by review otherwise:

- The alert explanation matches [alert.md](alert.md). Terminal notification
  protocols and unattended command exit are independent, zero-configuration
  tracks; WATCHING is opt-in per command name and needs `OSC 633` / `OSC 133`
  shell integration. The guide must not promise that every quiet Pane is
  automatically marked done after a fixed interval.
- Pocket is described only as shipped or explicitly in development, and never
  presents WebRTC staged in [remote-api.md](remote-api.md) as available.
- Browser Surfaces are explained to match [dor-browser.md](dor-browser.md)
  without exposing persisted params, controller registries, proxy plumbing, or
  future renderers.
- VS Code command names in getting started exist in `vscode-ext/package.json`.
- Detailed CLI behavior links to `/docs/dor`; the complete agent operating guide
  links to `/docs/agent-skill`.
- The guide contains no `TODO:` placeholders and no copied internal future
  design.

### Marketplace and Open VSX constraints

The extension-root README is the packaged listing body, so the canonical guide
stays within Marketplace-compatible Markdown:

- It does not depend on React, JavaScript, custom CSS, or website-only layout.
- README image URLs use HTTPS.
- User-provided SVG images are not allowed; content uses raster media or an
  approved badge provider.
- Media is **project-owned and served from `dormouse.sh`**, backed by files in
  `website/public/`. `github.com/user-attachments` URLs are specifically
  excluded: they 302 to a signature-expiring S3 object (so `HEAD` 403s where
  `GET` succeeds), cannot be cached downstream, leak every visitor's IP to a
  third party, and disappear with the comment they were uploaded to — taking
  the Marketplace listing's images with them. The public-doc lint enforces
  both the origin and the file's presence on disk.
- Critical documentation, install, issue, and media links are explicit absolute
  URLs. The monorepo does not rely on `vsce` inferring a relative subdirectory
  base for critical navigation.
- The same content renders usefully in Open VSX and GitHub Markdown.

The listing's discovery contract also includes `displayName`, `description`,
icon, category, keywords, homepage, repository, and issue URL in
`vscode-ext/package.json`. A major guide rewrite reviews those fields at the
same time.

Source constraints: the official VS Code
[publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#marketplace-integration)
and
[Marketplace presentation guide](https://code.visualstudio.com/api/references/extension-manifest#marketplace-presentation-tips).

## Markdown parsing

The Markdown parser is in-repo and takes no third-party dependency. It
therefore supports a deliberate *subset* of CommonMark and raises
`UnsupportedMarkdownError` outside it, rather than degrading silently the way a
general parser would. The public-doc lint turns that error into a build
failure, which is what makes a hand-rolled parser safe as the guide grows.

Raw HTML is disabled except for a narrow `<img>` allowlist carrying only `src`,
`alt`, `width`, `height`, and `title`, with an `https:` source. Every other tag,
and every other attribute on `<img>`, is rejected outright. The exception exists
because the guide's inline 22px alert-state icons need sizing and portable
Markdown has no syntax for it; it is not a general licence for HTML.

Heading ids come from one slugger that mirrors `github-slugger`, including
replacing each space individually rather than collapsing runs — so a heading
whose punctuation sits between two spaces yields a double hyphen exactly as on
GitHub. That is what keeps `/docs` anchors identical to the same heading's
anchor on GitHub.

Source of truth: `website/scripts/docs-parser.js`,
`website/scripts/docs-parser.test.js`.

## `/docs` rendering contract

The website build reads `vscode-ext/README.md` and retains its headings,
paragraphs, lists, links, tables, code, and images in source order. The website
delta is structural:

1. Omit the README's top-level `# Dormouse`; the page shell supplies its title
   and breadcrumb.
2. Generate an on-page table of contents from the remaining headings.
3. Assign stable, unique heading ids with one checked slugger.
4. Render the subset using the marketing website's typography, spacing, links,
   code blocks, tables, and responsive raster-media treatment.
5. Add the shared site header, docs breadcrumb, and footer.
6. Mark same-site and external navigation appropriately.

Operations 1–3 live in the generator; 4–6 live in the page components.

The website does not use regular expressions to turn VS Code prose into generic
prose. Channel-specific differences are explicit entries in one fixed delta
table (`DOCS_DELTA`). Each entry names exactly one source target and fails the
build when its target matches zero blocks or more than one. Fuzzy text and
line-number patches are forbidden. The table currently holds a single
operation: dropping the document title.

The renderer preserves selectable code, authored image alt text, safe
external-link attributes, mobile table access, and mobile-width media without
horizontal overflow. No HTML string is ever injected —
`dangerouslySetInnerHTML` is deliberately absent.

Source of truth: `website/scripts/generate-docs.js` (`DOCS_DELTA`,
`buildGuide`), `website/src/components/MarkdownDocument.tsx`,
`website/src/pages/Docs.tsx`.

## `/docs/dor` reference

The CLI page consumes the Markdown snapshots generated by
`dor/test/cli-help.test.mjs`. The root help snapshot owns command order and
inventory. That existing test remains responsible for proving every command's
snapshot equals real help output.

Stable anchors: `#targeting`, `#surface-handles`, `#dor`, one per canonical
command snapshot filename, and `#agent-browser` for both `dor agent-browser` and
the `dor ab` alias.

The targeting and Surface-handle introduction is extracted from the matching
sections of `dor/skill.md`; it is not re-authored in the website.

Each command section renders its title and invocation, usage as copyable
monospace lines, normally wrapped descriptive prose, separate examples and
text/JSON output blocks, responsive flag and argument definition tables, and a
collapsed disclosure containing the original help byte for byte.

The narrow help parser recognizes only the current column-zero markers `USAGE`,
`COMMANDS`, `FLAGS`, `ARGUMENTS`, `Examples:`, `Text output:`, and
`JSON output:`. A marker section owns only its indented body: the first
column-zero non-blank line that is not itself a marker ends it and begins
prose. Unclassified content remains ordered prose. Every parsed node retains its
raw source slice, and a losslessness test reconstructs the complete raw help
from those slices for every shipped snapshot.

Definition rows split on the block's aligned description column rather than the
first whitespace run, because a term may contain its own gap (`-h  --help`). A
description that wrapped onto the next line is one whose indent sits nearer the
description column than the term column; `dor split --help` produces exactly
that for its long direction flag.

Generation fails on a malformed snapshot envelope, duplicate command id, missing
or extra snapshot, or root inventory mismatch. Semantic parsing may fall back to
prose but never silently discards source text.

Source of truth: `website/scripts/help-parser.js`,
`website/scripts/help-parser.test.js`,
`website/src/components/DorCommandReference.tsx`,
`website/src/pages/DorDocs.tsx`.

## `/docs/agent-skill` guide

The agent page renders `dor/skill.md` exactly. Page chrome adds a table of
contents, stable heading ids, styled code blocks, copy buttons for `dor skill`
and `dor skill --install`, and reference links, but the generated data retains
the skill Markdown byte for byte — asserted against the file on disk.

The web rendering adds contextual reference links beside matching skill
headings. Command rules match on a backticked token inside the heading, since
skill headings carry descriptive suffixes; the two prose rules match the
heading's opening words.

| Skill section | CLI target |
| --- | --- |
| Targeting | `/docs/dor#targeting` |
| Surface handles | `/docs/dor#surface-handles` |
| `dor list` | `/docs/dor#list` |
| `dor split` | `/docs/dor#split` |
| `dor ensure` | `/docs/dor#ensure` |
| `dor send` | `/docs/dor#send` |
| `dor read` | `/docs/dor#read` |
| `dor kill` | `/docs/dor#kill` |
| `dor ab` / `dor agent-browser` | `/docs/dor#agent-browser` |
| `dor iframe` | `/docs/dor#iframe` |

These links are presentation adjacent to the skill body. Website URLs are never
injected into `dor/skill.md`: an older installed CLI must remain self-contained
and version-matched rather than directing its instructions to the latest
website reference.

Generation fails when a mapped skill heading is missing or ambiguous, or when
its target anchor does not exist in the generated CLI reference.

Source of truth: `SKILL_REFERENCES` in `website/scripts/generate-docs.js`,
`website/src/pages/AgentSkillDocs.tsx`.

## Generated documentation boundary

One build-time generator reads the canonical inputs and writes a gitignored
website data module:

```text
website/scripts/generate-docs.js
website/scripts/docs-parser.js
website/scripts/help-parser.js
website/src/data/docs.json
```

Inputs:

```text
vscode-ext/README.md
dor/test/snapshots/help/*.md
dor/skill.md
```

The generated data contains the canonical product-guide blocks and heading
inventory, the explicit fixed delta applied to `/docs`, ordered semantic CLI
nodes plus exact raw help, and the exact skill Markdown plus validated
heading-to-reference links.

Website `predev`, `pretest`, and `prebuild` run the generator, mirroring
`generate-changelog.js`. Browser code consumes generated data rather than
importing Dor command implementation modules, which use Node APIs. Generated
output stays out of version control and is reproducible from a clean checkout.

## Homepage browser proof

The **Browsers for you (and your agents)** section in
`website/src/pages/Home.tsx` shows a terminal-to-browser transcript followed by
a browser Surface preview, and links to the browser section of `/docs`,
`/docs/dor#agent-browser`, and `/docs/agent-skill`.

The transcript is **authored literals in `Home.tsx`, not generated or tested.**
Proving it end to end would need a live Host and a real `agent-browser` in CI,
and a captured dev-server port is not stable enough to commit — a busy 5173
silently becomes 5174. The accepted cost is that the transcript can drift from
real output with no test to catch it.

Two mitigations bound that drift. Command *syntax* matches
`dor/test/snapshots/help/`, which is tested against the real CLI, so only the
output lines are unverified. And output uses notation the CLI itself documents —
`created surface:N  "<command>"` from `dor ensure`'s text output, and the
resolution arrow from `dor ab`'s own examples — rather than invented
formatting. A source comment marks the block as authored and untested.

Desktop and mobile presentations keep the terminal and browser relationship
legible, selectable, and accessible without requiring animation.

## Root README

Root `README.md` is shorter than the canonical product guide and does not
duplicate it. It carries a product image and one-sentence cross-platform
description, playground/Marketplace/Open VSX/standalone links, a prominent link
to `https://dormouse.sh/docs` with the CLI and agent links subordinate, a
concise current feature summary, contributor setup and repository structure
with links to `AGENTS.md` and the internal specs, and license and supply-chain
links.

GitHub-specific development material lives here and is audited against current
package scripts and architecture. Staged implementation plans are not presented
as shipped behavior.

## Public-doc validation

`scripts/public-docs-lint.mjs`, invoked by root `pnpm test` after the spec lint,
verifies:

- the canonical guide contains its required product sections;
- neither public README contains `TODO:` placeholders;
- both canonical Markdown sources stay inside the parser's supported subset;
- local Markdown links resolve and public links use canonical HTTPS URLs;
- Marketplace README images use HTTPS and no SVG;
- VS Code commands named by the guide exist in `vscode-ext/package.json`, and
  the listing metadata fields are present;
- `/docs` heading ids are stable and unique;
- every agent-skill reference target exists in `/docs/dor`;
- generated command inventory matches the snapshot set exactly;
- generated skill Markdown equals `dor/skill.md` byte for byte;
- both READMEs route durable user documentation to `/docs`;
- public copy does not present staged WebRTC as shipped.

Each check is isolated, so one malformed source reports its own failure instead
of aborting the run and hiding every other problem behind a stack trace.

Nuanced product prose is not checked with phrase blacklists. When a public
feature section changes, review compares it with its owning implementation
spec.

## Code map

| File | Role |
| --- | --- |
| `vscode-ext/README.md` | The canonical product guide |
| `vscode-ext/package.json` | Listing metadata and VS Code command inventory |
| `README.md` | Repository and contributor entry point |
| `website/public/media/` | Project-owned guide media, served from `dormouse.sh` |
| `dor/skill.md` | The bundled agent skill, rendered exactly at `/docs/agent-skill` |
| `dor/test/snapshots/help/` | Tested CLI help, the source for `/docs/dor` |
| `website/scripts/docs-parser.js` | Markdown subset parser, slugger, `<img>` allowlist |
| `website/scripts/help-parser.js` | Narrow CLI-help parser with losslessness |
| `website/scripts/generate-docs.js` | Codegen, `DOCS_DELTA`, `SKILL_REFERENCES` |
| `website/src/components/MarkdownDocument.tsx` | Renders parsed Markdown blocks |
| `website/src/components/DocsLayout.tsx` | Docs chrome: breadcrumb, TOC, footer |
| `website/src/components/DorCommandReference.tsx` | One CLI command section |
| `website/src/pages/Docs.tsx` | `/docs` |
| `website/src/pages/DorDocs.tsx` | `/docs/dor` |
| `website/src/pages/AgentSkillDocs.tsx` | `/docs/agent-skill` |
| `scripts/public-docs-lint.mjs` | Public-doc validation |

## Future

**Scope: website-docs-release**

Remaining work, in staged order:

1. **VSIX packaging verification.** Package the extension and inspect its
   README and media inventory as part of release, so a listing cannot ship with
   a broken image or an unretained local asset. `vscode-ext/.vscodeignore`
   already retains `README.md`, `icon.png`, and `media/`.
2. **Live listing verification.** After publication, inspect the rendered
   Marketplace and Open VSX pages, and preview the root README under GitHub
   Markdown. If packaged or live README inspection becomes a release step,
   [deploy.md](deploy.md) owns that release ordering and verification.
3. **Promote public-doc contracts.** Move the contracts that constrain CLI help
   text and VS Code command titles into [dor-cli.md](dor-cli.md) and
   [vscode.md](vscode.md), so a change there sees the public-doc consequence
   without reading this spec. Public wording alone does not change a behavior
   spec when it accurately describes already-shipped behavior.
