# Website Documentation

> See `docs/specs/glossary.md` for canonical Surface / Session / Pane
> vocabulary used by the public product guide and browser workflow.

Dormouse publishes four specialized references on the marketing site, each
generated from a source that lives next to the code it describes.

```text
/docs/dor           dor CLI reference
/docs/agent-skill   exact bundled agent skill
/docs/self-host     the SELF_HOST.md runbook, minus its withheld halves
/docs/security      the security spec, published whole
```

`/docs` is an entrypoint rather than a page: it redirects to the page
`DOCS_DEFAULT_PATH` names (see [Reference page chrome](#reference-page-chrome)),
and the marketing nav's desktop **Docs** link is the only public link to it. The
general product guide is `vscode-ext/README.md`, published through the
Marketplace, Open VSX, and GitHub rather than through this site; the machinery
that once rendered it at `/docs` is retained and still runs (see
[Canonical product guide](#canonical-product-guide)).

| Surface | Purpose | Canonical content |
| --- | --- | --- |
| Homepage | Product marketing, visual proof, conversion, and the way in to every reference | `website/src/pages/Home.tsx` |
| Marketplace and Open VSX | Extension discovery, evaluation, and basic onboarding | `vscode-ext/README.md` plus public metadata in `vscode-ext/package.json` |
| `/docs/dor` | Complete CLI reference | Help snapshots in `dor/test/snapshots/help/`, verified against the built CLI |
| `/docs/agent-skill` | Agent-facing operating guide | Exact `dor/skill.md` |
| `/docs/self-host` | Running the coordinating server yourself | The runbook half of `SELF_HOST.md` |
| `/docs/security` | What Dormouse guarantees and how it is checked | Whole `docs/specs/security.md`, minus title and front matter |
| GitHub root | Repository overview and contributor entry point | Root `README.md` |

The guide reaches readers through the Marketplace, Open VSX, and GitHub rows of
that table. It has no row of its own on this site.

Internal specs remain maintainer references, the one exception being the
security spec, published whole. Public docs are otherwise written from shipped
behavior above each spec's fold and do not expose host plumbing, internal state
shapes, or staged `## Future` material.

## Canonical product guide

`vscode-ext/README.md` is the single authored source for the general product
guide. It works without prose forks in the VS Code Marketplace, Open VSX, and
GitHub.

The guide is not served by this site. It was rendered at `/docs`; that page and
every link to it were removed, and the guide is now read where it is published.
The generator still parses it on every build, for two reasons that outlive the
page: the pass validates the guide's media against the Marketplace rules and
copies `vscode-ext/images/` to `public/guide/images/`, which the
packaged listing resolves its images against, and the parsed guide is what a
replacement page would render. Its data file is generated and unconsumed. The
lint's guide checks still run, because they constrain the guide as a
*Marketplace listing*, not as a website page.

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
  links to `/docs/agent-skill`. Those two are the only site pages the guide may
  send a reader to for documentation.
- The guide contains no `TODO:` placeholders and no copied internal future
  design.

### Marketplace and Open VSX constraints

The extension-root README is the packaged listing body, so the canonical guide
stays within Marketplace-compatible Markdown:

- It does not depend on React, JavaScript, custom CSS, or website-only layout.
- README image URLs use HTTPS.
- User-provided SVG images are not allowed; content uses raster media or an
  approved badge provider.
- Media is **repo-relative local files under `vscode-ext/images/`**, referenced
  the way GitHub expects (`images/hero.jpg`). The Markdown stays the source of
  truth and ordinary GitHub authoring works: drop a file in and link it. It is
  `images/` and never `media/`: `vscode-ext/media/` is the webview bundle's
  Vite output directory, emptied on every extension build, so anything
  committed there is deleted by the next `pnpm build:vscode`.
  Remote media is rejected outright. `github.com/user-attachments` URLs in
  particular 302 to a signature-expiring S3 object (so `HEAD` 403s where `GET`
  succeeds), cannot be cached downstream, leak every visitor's IP to a third
  party, and disappear with the comment they were uploaded to — taking the
  listing's images with them.

Each renderer resolves those relative paths differently, and all four are
verified:

| Renderer | How `images/x.gif` resolves |
| --- | --- |
| GitHub | Natively, relative to `vscode-ext/` |
| Packaged extension pane | From `images/` inside the VSIX, retained by `!images/**` in `.vscodeignore` |
| Marketplace / Open VSX | `vsce --baseImagesUrl https://dormouse.sh/guide` rewrites both Markdown images **and** raw `<img src>` attributes at package time |
| `dormouse.sh` | The generator copies `vscode-ext/images/` to `public/guide/images/`, which is what `--baseImagesUrl` above resolves against |

Links back to this site take the same shape of treatment. The guide spells them
absolutely (`https://dormouse.sh/docs/dor`) because the Marketplace, Open VSX,
and GitHub all render it away from this origin, where a root-relative path
resolves against the wrong host or not at all. On the site those same URLs must
be root-relative: an absolute one leaves the origin on every click, so a link
followed from a dev server or a preview build lands on production instead of
the page next to it. The generator therefore strips its own origin and keeps
path, query, and fragment, so `/docs/dor#agent-browser` survives as a deep
link. Only exact-origin matches are rewritten; every other host is untouched.

Reserved: because the generator guarantees it, same-site hrefs reach
`MarkdownDocument` root-relative, and the renderer's external-link test is a
bare scheme check. A new documentation source rendered through that component
— the revived guide page under **Scope: guide-page-return** included — must run
through `localizeSiteLinks` too, or its site links will open in a new tab
pointed at production.

**Must pass** `--baseImagesUrl` on every `vsce` or `ovsx` invocation that
builds a VSIX from source, rather than letting either infer a base (rationale);
`checkImageBaseUrl` pins them to `SITE_IMAGE_BASE`, exempting a `--packagePath`
republish.

**Never** write to `public/guide/` from anything but the generator, which
deletes it wholesale each build (rationale). Hand-authored assets stay at
`public/` root, where git tracks them.
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

## Markdown rendering contract

The website build reads each Markdown source and retains its headings,
paragraphs, lists, links, tables, code, and images in source order. The website
delta is structural:

1. Omit the README's top-level `# Dormouse`; a page shell supplies its own
   title.
2. Generate an on-page table of contents from the remaining headings.
3. Assign stable, unique heading ids with one checked slugger.
4. Resolve links into the repository to the canonical file on GitHub, keeping
   the fragment.
5. Rewrite links pointing back at this site to root-relative paths, dropping
   only the origin.
6. Render the subset using the marketing website's typography, spacing, links,
   code blocks, tables, and responsive raster-media treatment.
7. Add the shared site header and footer.
8. Mark same-site and external navigation appropriately.

Operations 1–5 live in the generator; 6–8 live in the page components.
Operations 1–4 run in `buildDocument`, so they apply to the guide, which has no
page today, the self-host runbook, and the security spec; operation 5 runs over
those three and `dor/skill.md`, the last before `/docs/dor` lifts its
introduction out of those same blocks, so every published page inherits one
rewrite.

**Never** publish a relative repository link as-is; `resolveRepoLinks` sends it
to the canonical file and fails the build when the target does not exist.

**Never** use a regular expression to turn a canonical source's prose into
site prose. Channel-specific differences are explicit entries in one fixed
delta table per document — `DOCS_DELTA` for the guide, `SELF_HOST_DELTA` for
the runbook, `SECURITY_DELTA` for the security spec. Each entry names exactly
one source target and fails the build when its target matches zero blocks or
more than one. Fuzzy text and line-number patches are forbidden.

Two operations exist. `remove` drops the matched block. `remove-section`
requires a heading and drops it with every block up to the next heading of the
same or shallower depth, so a removed `##` takes its `###` subsections with it.

**Must** leave no `#anchor` link pointing at a heading the delta removed.
`resolveRemovedAnchors` rewrites such a link to the canonical file on GitHub —
the material still exists, it is just not published here — and
`assertAnchorsResolve` then fails the build on any that remain. Both run on
every page built from a delta, so the guarantee does not depend on remembering
to ask for it.

The renderer preserves selectable code, authored image alt text, safe
external-link attributes, mobile table access, and mobile-width media and prose
without horizontal overflow — an inline code span offers a break at each of its
separators. **Never** let such a hint change what the span's `textContent`
yields, so a path still pastes into a shell. No HTML string is ever injected —
`dangerouslySetInnerHTML` is deliberately absent.

## Per-page head tags

`website/src/lib/site-meta.ts` builds every page's title, description,
canonical, and social cards. The root route calls it with the homepage's copy;
a page overrides by exporting `meta` and calling it with its own.

**Never** hardcode one of those in `root.tsx`'s `<head>`: a `<head>` tag is
emitted before `<Meta />`, so a page with its own `meta` ships two `<title>`
elements and crawlers read the first (rationale). **Must** give every
prerendered page a canonical on its own path, carrying the trailing slash the
host redirects to. **Never** claim one from a route served through the SPA
fallback — the client `<Meta />` appends rather than replaces, so a second
canonical joins the fallback's and both are discarded; `siteMeta`'s
`indexable: false` sends `robots: noindex, follow` instead.
`checkPageHeadTags` and `checkSiteOrigin` pin the first two;
`ChangelogAfter.tsx` is the only route under the third.

## Reference page chrome

Every page in `DOCS_PAGES` shares `DocsLayout`: the site header, the left
navigation rail, an `h1` and intro, and prev/next. The changelog and the supply
chain are in that list too — a reader meets them the same way, as long-form
material reached from the rail rather than from the marketing nav.

**The rail is the only table of contents.** It lists every page and expands the
current one's sections beneath it, so moving between pages and within one is
the same control. A second "on this page" would restate half of it.

**The page list never shrinks; the expanded sections scroll.** The rail is a
bounded flex column whose section list is the only part that gives up space, so
everything shows when it fits and the page list stays reachable when it does
not. `/docs/dor` nests its subcommands under one `Commands` heading rather than
listing fourteen entries beside four elsewhere. A reader on a screen reader
navigates the outline rather than the rail, so **must** keep the two agreeing:
the commands render a level below that heading, and their own labels a level
below them again (`website/src/pages/DorDocs.test.tsx`).

**`/docs` is an entrypoint, not an index.** It redirects to the page
`DOCS_DEFAULT_PATH` names — a 302, because the target is a judgement call we
expect to revisit and a 301 outlives it in readers' caches. There is no page at
`/docs` itself, and `checkDocsEntrypoint` keeps the redirect and the constant
saying the same thing. `Docs` joins the marketing nav on desktop only; on a
phone the docs are reached from the homepage's own links.

**These pages follow the reader's theme; the rest of the site does not.** They
are long-form reading, so `DocsLayout` restores a theme and gives the `compact`
`ThemePicker` two placements: floating bottom right at `lg`, opening upward, and
inline at the end of the mobile docs bar below that, opening downward
([theme.md](./theme.md) → Where the user picks a theme). The `docs-themed` body
class redefines the site's own `--color-*` tokens from the applied
`--vscode-*`, and only `DocsLayout` adds it, so the homepage keeps its black.
The changelog and the supply chain joined that rule when they joined the rail,
which is why their links moved off caramel.
`applyTheme` writes to `body.style`, which `html` cannot read, so `html` gives
up the canvas and lets body's background propagate.

**Prose links take the picked theme's `accent`, contrast-corrected — never
brand caramel, never `--vscode-textLink-foreground`** (rationale). Caramel
stays where the reader cannot retheme it — the wordmark, the header, the
homepage — and is the fallback before a theme applies.

**A reader is prompted to pick a theme until they answer.** Picking one and
closing the prompt both count — a reader who declined has seen the offer.
Keyed on the website's own `dormouse:docs-theme-prompt-dismissed`, because
`dormouse:active-theme` cannot answer it: restoring writes that key too.

**Must keep** prerendered and first-client prompt markup independent of
`localStorage`, then reconcile after hydration. Until then the prompt stays
hidden, so a returning reader never sees dismissed UI flash. Pinned by
`website/src/components/DocsThemeControl.test.tsx`.

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

## `/docs/agent-skill` guide

The agent page renders `dor/skill.md` exactly. Page chrome adds a table of
contents, stable heading ids, styled code blocks, copy buttons for `dor skill`
and `dor skill --install`, and reference links, but adds nothing to the skill
body. The raw Markdown is deliberately **not** emitted into the generated data:
nothing renders it, and a copy of the generator's own input proves nothing about
the generator. A test instead re-parses the file independently and compares the
resulting heading inventory and ids.

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

## `/docs/self-host` runbook

`SELF_HOST.md` stays canonical in the repository and is published from there.
It has two consumers that outrank the website: an assistant reads it in a
checkout (`read @SELF_HOST.md and walk me through it`), and
`scripts/deploy-lint.mjs` audits its Installer contract against
`deploy/local/`. A second copy under `website/` would be a second file to keep
true about how a server is installed.

The file is two documents in one, and `SELF_HOST_DELTA` publishes only the
first: it withholds the `#` title, the opening blockquote, and the three
sections addressed to the assistant or to a maintainer, each rule carrying its
own `reason`. What survives is the runbook — prerequisites, what the installer
does, the definition of done, the six checkpoints, official references,
troubleshooting boundaries, and keeping the relay up while the laptop sleeps.

**Must** keep every withheld section present in `SELF_HOST.md`. `applyDelta`
owns this: a rule matching nothing fails the build naming the rule, so a
renamed section is a decision rather than a silent republication of what the
delta meant to hold back.

The page carries one authored paragraph the source does not: a pointer to
running the runbook with an assistant. It belongs to the page because it is
advice about reading this document here.

## `/docs/security` spec

`docs/specs/security.md` stays canonical in `docs/specs/` because it is a spec:
`scripts/spec-lint.mjs` budgets it like any other, and the nightly audit reads
it as the contract it audits against. `SECURITY_DELTA` withholds the `#` title
and the front-matter blockquote — the page shell supplies both — and nothing
else.

**Must** publish everything else. A reader deciding whether to run this is
owed the gaps and the undefended edges beside the guarantees, so **the spec may
carry no `## Future` heading and no `Reserved:` paragraph**; `checkSecurityFold`
pins that, and staged material has to be withheld by a delta rule before it can
exist in the file.

The page carries one authored paragraph the source does not: that this is the
spec the audit runs against, and that the four domain specs it links live
beside it. Those four are not published, and reach the reader as GitHub links
like every other repository link on the page.

## Generated documentation boundary

One build-time generator reads the canonical inputs and writes a gitignored
website data module:

```text
website/scripts/generate-docs.js
website/scripts/docs-parser.js
website/scripts/help-parser.js
website/src/data/docs.guide.json    generated, no page consumes it today
website/src/data/docs.selfhost.json
website/src/data/docs.security.json
website/src/data/docs.cli.json
website/src/data/docs.skill.json
```

One file per document rather than one combined module: a shared import made
every docs route pull the others' content into one chunk.

Inputs:

```text
vscode-ext/README.md
SELF_HOST.md
docs/specs/security.md
dor/test/snapshots/help/*.md
dor/skill.md
```

The generated data contains the canonical product-guide blocks and heading
inventory with the explicit fixed delta applied, ordered semantic CLI nodes
plus exact raw help, and the skill blocks plus validated heading-to-reference
links. The raw skill Markdown is deliberately not emitted.

Website `predev`, `pretest`, and `prebuild` run the generator, mirroring
`generate-changelog.js`. Browser code consumes generated data rather than
importing Dor command implementation modules, which use Node APIs. Generated
output stays out of version control and is reproducible from a clean checkout.

## Homepage browser proof

The **Browsers for you (and your agents)** section in
`website/src/pages/Home.tsx` shows a terminal-to-browser transcript followed by
a browser Surface preview, and links to `/docs/dor#agent-browser` and
`/docs/agent-skill`.

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
description, playground/Marketplace/Open VSX/standalone links, links to every
published reference, a concise current feature summary, contributor setup and
repository structure
with links to `AGENTS.md` and the internal specs, and license and supply-chain
links.

GitHub-specific development material lives here and is audited against current
package scripts and architecture. Staged implementation plans are not presented
as shipped behavior.

## Public-doc validation

`scripts/public-docs-lint.mjs`, invoked by root `pnpm test` after the spec lint,
verifies:

- the canonical guide carries every section listed in the `text` fence above,
  read out of this spec rather than restated in the lint;
- neither public README nor `SELF_HOST.md` nor `docs/specs/security.md`
  contains `TODO:` placeholders;
- every canonical Markdown source stays inside the parser's supported subset;
- public links use canonical HTTPS URLs, and a local link resolves — read off
  the parsed tree, so a link-shaped string in a code span is not a link.
  `SELF_HOST.md` and the security spec get only the HTTPS half; spec-lint
  already resolves their relative links and validates their fragments;
- the security spec carries no `## Future` heading and no `Reserved:`
  paragraph, because it is published whole (`checkSecurityFold`);
- guide images are repo-relative files that exist under `vscode-ext/images/`,
  with no remote URLs and no SVG, and every file there is referenced;
- VS Code commands named by the guide exist in `vscode-ext/package.json`, and
  the listing metadata fields are present;
- guide heading ids are stable and unique;
- every agent-skill reference target exists in `/docs/dor`;
- generated command inventory matches the snapshot set exactly;
- both READMEs link to every reference page in `docs-pages.ts`, except that
  the root README alone owns `/docs/self-host` and `/docs/security` — checked
  as exact URLs, so the `/docs` entrypoint cannot stand in for a page under a
  prefix test. The guide carries neither obligation: it is a Marketplace
  listing for the editor extension, and neither running a relay server nor
  auditing the repository is part of installing one;
- the homepage links every `/docs` page root-relatively, and every `/docs` href
  on it resolves to one — both directions, because a rewritten section can
  strand a page's only link or leave one aimed at the entrypoint;
- every `vsce` or `ovsx` invocation that packages the extension from source
  passes the site image base;
- no per-page head tag is hardcoded in the root route, every route that
  exports `meta` builds it with `siteMeta`, and the two spellings of the site
  origin agree;
- `/docs` redirects to a page the rail actually lists, with the status the
  entrypoint's own constant expects;
- public copy does not present staged WebRTC as shipped, for as long as WebRTC
  is still under `## Future` in [remote-api.md](remote-api.md).

Each check is isolated, so one malformed source reports its own failure instead
of aborting the run and hiding every other problem behind a stack trace.

Nuanced product prose is not checked with phrase blacklists. When a public
feature section changes, review compares it with its owning implementation
spec.

## Code map

| File | Role |
| --- | --- |
| `vscode-ext/README.md` | The canonical product guide; published off-site, parsed here |
| `SELF_HOST.md` | The self-host runbook and Installer contract; the runbook half is published |
| `docs/specs/security.md` | The security spec, published whole at `/docs/security` |
| `vscode-ext/package.json` | Listing metadata and VS Code command inventory |
| `README.md` | Repository and contributor entry point |
| `vscode-ext/images/` | Guide media; the generator copies it to `public/guide/images/`, which the Marketplace listing loads from |
| `dor/skill.md` | The bundled agent skill, rendered exactly at `/docs/agent-skill` |
| `dor/test/snapshots/help/` | Tested CLI help, the source for `/docs/dor` |
| `website/src/lib/site-meta.ts` | Every page's title, description, canonical, and social cards |
| `website/src/lib/docs-pages.ts` | The rail's pages and their order; routes, prerender, rail, and lint all read it |
| `website/src/lib/docs-rail.test.tsx` | Every entry anchors on an id its page renders |
| `website/src/pages/Changelog.tsx`, `website/src/pages/SupplyChain.tsx` | Rail pages deriving their own sections |
| `website/public/_redirects` | The `/docs` entrypoint and the changelog SPA fallback |
| `website/src/routes.ts`, `website/src/components/SiteHeader.tsx` | The published routes and the marketing nav, which carries `Docs` on desktop |
| `website/scripts/docs-parser.js` (+ `.test.js`) | Markdown subset parser, slugger, `<img>` allowlist |
| `website/scripts/help-parser.js` (+ `.test.js`) | Narrow CLI-help parser with losslessness |
| `website/scripts/generate-docs.js` | Codegen: the delta tables, `buildDocument`, `localizeSiteLinks`, `resolveRemovedAnchors`, `resolveRepoLinks`, `linkSkillHeadings` |
| `website/src/components/MarkdownDocument.tsx` | Renders parsed Markdown blocks |
| `website/src/components/DocsLayout.tsx` | Docs chrome: header, the rail and its mobile drawer, prev/next, theme restore |
| `website/src/components/DocsThemeControl.tsx` | The picker's two placements and its first-visit prompt |
| `website/src/lib/docs-accent.ts` (+ `.test.ts`) | The themed link color, contrast-corrected per theme |
| `website/src/lib/docs-theme.ts` | Default docs theme, and whether the reader has chosen |
| `website/src/components/DorCommandReference.tsx` | One CLI command section |
| `website/src/pages/DorDocs.tsx` | `/docs/dor` |
| `website/src/pages/AgentSkillDocs.tsx` | `/docs/agent-skill` |
| `website/src/pages/SelfHostDocs.tsx` | `/docs/self-host` |
| `website/src/pages/SecurityDocs.tsx` | `/docs/security` |
| `scripts/public-docs-lint.mjs` | Public-doc validation |

## Future

**Scope: website-docs-release**

Remaining work, in staged order:

1. **VSIX packaging verification.** Package the extension and inspect its
   README and media inventory as part of release, so a listing cannot ship with
   a broken image or an unretained local asset. `vscode-ext/.vscodeignore`
   already retains `README.md`, `icon.png`, and `images/`.
2. **Live listing verification.** After publication, inspect the rendered
   Marketplace and Open VSX pages, and preview the root README under GitHub
   Markdown. If packaged or live README inspection becomes a release step,
   [deploy.md](deploy.md) owns that release ordering and verification.
3. **Promote public-doc contracts.** Move the contracts that constrain CLI help
   text and VS Code command titles into [dor-cli.md](dor-cli.md) and
   [vscode.md](vscode.md), so a change there sees the public-doc consequence
   without reading this spec. Public wording alone does not change a behavior
   spec when it accurately describes already-shipped behavior.

**Scope: guide-page-return**

A hosted rendering of the general product guide was built, shipped at `/docs`,
and then withdrawn — the guide reads well enough where it is already published,
and the page did not earn its place in the site's navigation. The pipeline is
whole, not a stub: `docs.guide.json` is written on every build with no
consumer.

Reviving it needs a page component and an entry in `docs-pages.ts` — not new
pipeline work. Whoever does it should first answer the question that removed
the page: what this rendering gives a reader that the Marketplace and GitHub
renderings do not.

The lint checks reference URLs exactly rather than by prefix, so a link to a
`/docs/...` page that does not exist is caught rather than satisfied by the
entrypoint redirect.
