# Website Documentation

> See `docs/specs/glossary.md` for canonical Surface / Session / Pane
> vocabulary used by the public product guide and browser workflow.

The following references are generated from canonical sources.

```text
/dor                dor CLI reference
/compatible-agents  supported agents and contribution guide
/agent-skill        exact bundled agent skill
/self-host          the SELF_HOST.md runbook, minus its withheld halves
/security           the security spec, every section of it
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
| `/dor` | Complete CLI reference | Help snapshots in `dor/test/snapshots/help/`, verified against the built CLI |
| `/compatible-agents` | Agent recovery, watching, and contributions | `docs/compatible-agents.md` |
| `/agent-skill` | Agent-facing operating guide | Exact `dor/skill.md` |
| `/self-host` | Running your own Relay | The runbook half of `SELF_HOST.md` |
| `/hosted` | Account-service introduction and prelaunch managed services | `website/src/pages/Hosted.tsx` |
| `/security` | What Dormouse guarantees and how it is checked | Every section of `docs/specs/security.md`, minus title and front matter; its rows split across three pages |
| `/privacy`, `/terms` | Standalone Hosted account policies outside Docs | `website/src/pages/Privacy.tsx`, `website/src/pages/Terms.tsx` |
| GitHub root | Repository overview and contributor entry point | Root `README.md` |

Internal specs remain maintainer references, the one exception being the
security spec, published whole. Public docs are otherwise written from shipped
behavior above each spec's fold and do not expose host plumbing, internal state
shapes, or staged `## Future` material.

## Canonical product guide

`vscode-ext/README.md` is the single authored source for the general product
guide. It works without prose forks in the VS Code Marketplace, Open VSX, and
GitHub.

**Must parse and validate the guide on every build without publishing a guide page** (rationale).

The guide is written for a VS Code user, because every channel that publishes
it is an extension listing or the extension's folder on GitHub; the standalone
app gets one section pointing at its download. Its sections are:

```text
## Tmux with browsers
## Alerts
## Push notifications you can self-host
## Terminals that know their ports
## Browsers for you (and your agents)
## Select and copy-paste like you meant
## Getting started
## Keyboard shortcuts
## Coding agents
## Dormouse Hosted
## Standalone app
## Links
```

Content invariants, enforced by the public-doc lint where mechanically
checkable and by review otherwise:

- The alert explanation matches [alert.md](alert.md). Terminal notification
  protocols and unattended command exit ring with zero configuration,
  independent of WATCHING, whose defaults follow `docs/specs/alert.md` → WATCHING Track
  and which needs `OSC 633` / `OSC 133` shell integration. The guide must not promise that
  every quiet Pane is automatically marked done after a fixed interval.
- Pocket is described only as shipped or explicitly in development.
- Browser Surfaces are explained to match [dor-browser.md](dor-browser.md)
  without exposing persisted params, controller registries, proxy plumbing, or
  future renderers.
- VS Code command names in getting started exist in `vscode-ext/package.json`.
- Detailed CLI behavior links to `/dor`; the complete agent operating guide
  links to `/agent-skill`; the hosted-services preview links to `/hosted`.
- The guide renders no `TODO:` placeholders and no copied internal future
  design.

### Marketplace and Open VSX constraints

The extension-root README is the packaged listing body, so the canonical guide
stays within Marketplace-compatible Markdown:

- It does not depend on React, JavaScript, custom CSS, or website-only layout.
- User-provided SVG images are not allowed; content uses raster media or an
  approved badge provider.
- Media is **repo-relative local files under `vscode-ext/images/`**, referenced
  the way GitHub expects (`images/hero.jpg`). The Markdown stays the source of
  truth and ordinary GitHub authoring works: drop a file in and link it. It is
  `images/` and never `media/`: `vscode-ext/media/` is the webview bundle's
  Vite output directory, emptied on every extension build, so anything
  committed there is deleted by the next `pnpm build:vscode`.
  **Never** reference remote media, `github.com/user-attachments` URLs least of
  all (rationale).

Each renderer resolves those relative paths as follows:

| Renderer | How `images/x.gif` resolves |
| --- | --- |
| GitHub | Natively, relative to `vscode-ext/` |
| Packaged extension pane | From `images/` inside the VSIX, retained by `!images/**` in `.vscodeignore` |
| Marketplace / Open VSX | `vsce --baseImagesUrl https://dormouse.sh/guide` rewrites both Markdown images **and** raw `<img src>` attributes at package time |
| `dormouse.sh` | The generator copies `vscode-ext/images/` to `public/guide/images/`, which is what `--baseImagesUrl` above resolves against |

**The guide spells site links absolutely** (`https://dormouse.sh/dor`),
because every channel that publishes it renders it away from this origin;
`localizeSiteLinks` turns them back into served paths on the site
([rendering contract](#markdown-rendering-contract) op 5).

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
replaces its `images/` directory each build (rationale). Hand-authored assets stay at
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

**Must reject unsupported Markdown with `UnsupportedMarkdownError`, never silently degrade it.** The parser is in-repo and dependency-free; public-doc lint reports parsing failures.

**May accept raw HTML only through the parser's `<img>` attribute allowlist, with a relative or `https:` source.** Other tags or attributes fail. Standalone HTML comments are dropped; inline comments fail (rationale).

**Must assign unique GitHub-style heading ids, reserving authored and generated numeric suffixes alike and replacing each space individually.** `website/scripts/docs-parser.test.js` pins slug collisions.

**Must retain ordered-list starts and blank-separated paragraphs within their own list item.** `website/scripts/generate-docs.test.js` pins the published first-run setup sequence; `website/src/components/MarkdownDocument.test.tsx` pins resumed numbering. **Must interpret backslash escapes only before ASCII punctuation**, preserving ordinary path characters.

Source of truth: `IMG_ALLOWED_ATTRS`, `parseMarkdown`, `parseInline`, and `createSlugger` in `website/scripts/docs-parser.js`.

## Markdown rendering contract

The website build reads each Markdown source and retains its headings,
paragraphs, lists, links, tables, code, and images in source order. The website
delta is structural:

1. Omit the README's top-level `# Dormouse`; a page shell supplies its own
   title.
2. Generate an on-page table of contents from the remaining headings.
3. Assign stable, unique heading ids with one checked slugger.
4. Resolve links into the repository: to the page that publishes the file
   where one exists (`SITE_ROUTES`), otherwise to the canonical file on GitHub,
   keeping the fragment.
5. Rewrite links pointing back at this site to the **served** root-relative
   path: origin dropped, `sitePath`'s trailing slash added unless the path
   already carries one or an extension, query and fragment verbatim — so
   `https://dormouse.sh/dor#agent-browser` becomes
   `/dor/#agent-browser`. Only exact-origin matches are rewritten.
6. Render the subset using the marketing website's typography, spacing, links,
   code blocks, tables, and responsive raster-media treatment.
7. Add the shared site header and footer.
8. Mark same-site and external navigation appropriately.

Operations 1–5 live in the generator; 6–8 live in the page components.
Operations 1–5 run in `buildDocument`, so they apply to the guide, which has no
page today, the self-host runbook, and the security spec. `dor/skill.md` is
exempt from operation 5 and asserted instead
([`/agent-skill` guide](#agent-skill-guide)).

**Never** publish a relative repository link as-is; `resolveRepoLinks` sends it
to the publishing page or the canonical file and fails the build when the
target does not exist, and `assertRouteFragments` fails it when a fragment into
a published page names no heading that page renders. A source keeps its
repo-relative link, which spec-lint verifies down to the fragment as it cannot
for a URL. Known gap: `assertRouteFragments` skips query-bearing links.

**Never** use a regular expression to turn a canonical source's prose into
site prose. Channel-specific differences are explicit entries in one fixed
delta table per document — `DOCS_DELTA` for the guide, `SELF_HOST_DELTA` for
the runbook, `SECURITY_DELTA` for the security spec. Each entry names exactly
one source target and fails the build when its target matches zero blocks or
more than one. Fuzzy text and line-number patches are forbidden.

**Must remove a withheld section with all its subsections, stopping at the next same-depth or shallower heading.**

**Must** leave no `#anchor` link pointing at a heading the delta removed.
**Must redirect withheld-section links to the canonical file on GitHub and fail generation on remaining dangling anchors.**

The renderer preserves selectable code, authored image alt text, safe
external-link attributes, mobile table access, and mobile-width media and prose
without horizontal overflow — an inline code span offers a break at each of its
separators. **Never** let such a hint change what the span's `textContent`
yields, so a path still pastes into a shell. No HTML string is ever injected —
`dangerouslySetInnerHTML` is absent.

Source of truth: `buildDocument`, `applyDelta`, `resolveRemovedAnchors`,
`assertAnchorsResolve`, `resolveRepoLinks`, `assertRouteFragments`, and
`localizeSiteLinks` in `website/scripts/generate-docs.js`; `MarkdownDocument`
and `CodeSpan` in `website/src/components/MarkdownDocument.tsx`.

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

**Every in-site link spells that served path** — `sitePath` in components, the
generator's rewrites in reference prose — so no reader lands on a redirect.
Exempt: `/` with its anchors, and the `/docs` entrypoint, which names no page.
`<Link to>` never leaves the client, so it is unaffected.
`checkInSiteHrefsAreServed` pins it.

## Reference page chrome

`DOCS_PAGES` pages use `DocsLayout` for header, rail, `h1`, intro, and
prev/next. `/hosted` follows `/self-host`. **Must place “Compatible agents”
immediately after “dor CLI reference”.**

**Each page's `linkedFrom` names every document owing it a link** — the two
READMEs and the homepage — so the obligation is registry-driven, never inferred
from the path. The changelog names none; the rail and the updater's deep link
are its way in. `checkRoutesToReferences` reads it.

**Must title `/self-host` “How to self-host” and `/hosted` “Dormouse Hosted”
in chrome and metadata while keeping URLs stable.**

**The rail is the only table of contents.** List all pages; expand only current
sections.

**The page list never shrinks; the expanded sections scroll.** The rail is a
bounded flex column whose section list is the only part that gives up space, so
everything shows when it fits and the page list stays reachable when it does
not. `/dor` nests its subcommands under one `Commands` heading rather than
listing every command beside the handful of entries elsewhere. A reader on a screen reader
navigates the outline rather than the rail, so **must** keep the two agreeing:
the commands render a level below that heading, and their own labels a level
below them again (`website/src/pages/DorDocs.test.tsx`).

**`/docs` is an entrypoint, not an index.** It redirects to the page
`DOCS_DEFAULT_PATH` names — a 302, because the target is a judgement call we
expect to revisit and a 301 outlives it in readers' caches. There is no page at
`/docs` itself, and `checkDocsEntrypoint` keeps the redirect and the constant
saying the same thing. Reference pages live at the top level (`/dor`,
`/security`), and each old `/docs/<page>` URL keeps a 301 in `_redirects` because
it is in READMEs and external links. **Never give a page a slug that
`website/src/routes.ts` or `website/public/` already serves.** `Docs` joins the marketing nav on desktop only; on a
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

**Prose links take the picked theme's `accent`, contrast-corrected — never
brand caramel, never `--vscode-textLink-foreground`** (rationale). Caramel
stays where the reader cannot retheme it — the wordmark, the header, the
homepage — and is the fallback before a theme applies.

**Must derive docs call-to-action text against its strongest accent-tinted
state and clear WCAG AA both at rest and on hover** (rationale).

**Muted reference text uses an opaque foreground-derived color that clears
WCAG AA against the surface carrying it; never dim text with opacity**
(rationale). `docsMutedTextForSurfaces` and `website/src/lib/docs-accent.test.ts` pin
the base and every registered tinted surface composition across bundled themes;
`checkNoDimmedDocsText` pins the call sites, allowlisting what is not text. **Must follow transitive relative imports with repository-relative paths on every platform.** `scripts/docs-surfaces.test.mjs` pins the graph traversal.

**Must prompt a reader to pick a theme until they answer, and dismiss both
responsive placements together.** Picking one and closing the prompt both count.
Keyed on the website's own `dormouse:docs-theme-prompt-dismissed`, because
`dormouse:active-theme` cannot answer it: restoring writes that key too.

**Must keep** prerendered and first-client prompt markup independent of
`localStorage`, then reconcile after hydration. Until then the prompt stays
hidden, so a returning reader never sees dismissed UI flash. Pinned by
`website/src/components/DocsThemeControl.test.tsx`.

## `/hosted` preview

**Must describe the account service and link its account app, privacy policy, and terms.**
Source of truth: `Hosted` in `website/src/pages/Hosted.tsx`.

**Must mark both services unavailable:** Hosted operates Pocket's Relay;
optional ElevenLabs replaces browser voice. Terminals stay on an awake, online
computer; browser speech and self-hosting remain. `NotifySignupForm` exposes
the `nedshed.dev` devlog handoff and keeps email per tab.
**Must use native required-email validation.**
`website/src/components/NotifySignupForm.test.tsx` pins all three.

**Must open both hosting pages with the Relay boundary:** Dormouse needs none;
remote features require a configured Relay and otherwise make no network
requests. `/self-host` links `/hosted`; `/hosted` labels hosting pending review,
discloses metadata, and links the model.
`website/src/lib/docs-rail.test.tsx` pins this.

**Must also link the preview from** Pocket marketing/tutorial, self-host docs,
and the speech and remote-control settings; `linkedFrom` owns the rest.

## Hosted policies

**Must prerender `/privacy` and `/terms` outside Docs navigation with standalone marketing chrome and an effective date.**

Source of truth: `HostedPolicyLayout` in `website/src/components/HostedPolicyLayout.tsx`.

## `/dor` reference

The CLI page consumes the Markdown snapshots generated by
`dor/test/cli-help.test.mjs`. The root help snapshot owns command order and
inventory. That existing test remains responsible for proving every command's
snapshot equals real help output.

**Must retain `#targeting`, `#surface-handles`, `#dor`, `#commands`, and one anchor per canonical command snapshot filename.** `dor agent-browser` links to `#agent-browser`.

The targeting and Surface-handle introduction is extracted from the matching
sections of `dor/skill.md`; it is not re-authored in the website.

Each command section renders its title and invocation, usage as copyable
monospace lines, normally wrapped descriptive prose, separate examples and
text/JSON output blocks, responsive flag and argument definition tables, and a
collapsed disclosure containing the original help byte for byte.

**Must preserve unclassified help as ordered prose and reconstruct each shipped snapshot byte for byte from parsed source slices.** The parser owns marker recognition and aligned definition-row parsing; `website/scripts/help-parser.test.js` pins their boundaries and wrapped descriptions.

Generation fails on a malformed snapshot envelope, duplicate command id, missing
or extra snapshot, or root inventory mismatch. Semantic parsing may fall back to
prose but never silently discards source text.

Source of truth: `buildCli` and `CLI_COMMANDS_SECTION` in `website/scripts/generate-docs.js`; `parseSnapshot`, `parseHelp`, and `definitionRows` in `website/scripts/help-parser.js`; `DorCommandReference` in `website/src/components/DorCommandReference.tsx`.

## `/compatible-agents` guide

**Must publish `docs/compatible-agents.md` with `COMPATIBLE_AGENTS_DELTA` removing its title, spec front matter, “Recovery contract (maintainers)” section, and `## Future`.** Links into withheld sections resolve to the canonical file on GitHub. **Must keep its supported-agent table aligned with
`CODING_AGENTS` in `lib/src/lib/coding-agents.ts`**, pinned by
`compatible agents` in `website/scripts/generate-docs.test.js`.

Source of truth: `generateDocs` in `website/scripts/generate-docs.js`.

## `/agent-skill` guide

**Must render `dor/skill.md` exactly, adding only page chrome:** table of contents, stable heading ids, styled code, copy buttons for `dor skill` and `dor skill --install`, and contextual CLI links. **Never emit the unused raw skill Markdown into browser data.** An independent re-parse compares the generated headings and ids.

**Must derive contextual CLI links from skill headings.** Backticked `dor <command>` tokens select the first spelling with a matching CLI section, labelled by the first authored spelling. Targeting and Surface handles match by heading prefix and link to the corresponding CLI introductions. Generation fails on missing or ambiguous introduction headings, or a command heading with no matching anchor.

**Never inject website URLs into the bundled skill; must reject links to the website's origin rather than rewriting them** (rationale). Known gap: the current prefix check misses bare-origin, case, default-port, and protocol-relative spellings. `buildCli` reuses the same intro block objects.

Source of truth: `buildSkill`, `assertNoSiteLinks`, and `linkSkillHeadings` in `website/scripts/generate-docs.js`; `AgentSkillDocs` in `website/src/pages/AgentSkillDocs.tsx`.
Tests: `website/scripts/generate-docs.test.js`.

## `/self-host` runbook

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

**Must preserve published subsections and withhold removed subsections.**
`website/scripts/generate-docs.test.js`.

**Must** keep every withheld section present in `SELF_HOST.md`. `applyDelta`
owns this: a rule matching nothing fails the build naming the rule, so a
renamed section is a decision rather than a silent republication of what the
delta meant to hold back.

Above the runbook the page renders the security spec's self-host rows and
bullets — guarantees, what is not defended, known gaps — from
`docs.security.json` ([`/security` spec](#security-spec)), then the
disclosure link and the advice to use an assistant.

## `/security` spec

`docs/specs/security.md` stays canonical in `docs/specs/` because it is a spec:
`scripts/spec-lint.mjs` budgets it like any other, and the nightly audit reads
it as the contract it audits against. `SECURITY_DELTA` withholds the `#` title
and the front-matter blockquote — the page shell supplies both — and nothing
else.

**Must** publish every section. A reader deciding whether to run this is owed
the gaps and the undefended edges beside the guarantees, so **the spec may
carry no `## Future` heading and no `Reserved:` paragraph**; `checkSecurityFold`
pins that, and staged material has to be withheld by a delta rule before it can
exist in the file.

**Must** render the guarantees table and the two lists by audience, from
`docs.security.json`, never restated: `securityAudiences` splits each entry by
the spec its links name — `security-local.md`, `security-ci.md`, and
`security-audit.md` to this page; `remote-security-model.md`,
`security-remote.md`, and `SELF_HOST.md` to `/self-host`;
`security-supply-chain.md` to `/supply-chain` — and an entry naming no spec, a
spec in no group, or two groups fails the build. `audienceBlocks` gives this
page its own audience's three blocks with every other block whole, so the spec
file on GitHub is the one place every entry appears together. All three pages
cross-link in prose, this page's callout naming where the other two audiences
are, and each specialized page links
`/security#how-the-guarantees-are-checked`;
`website/src/pages/security-pages.test.tsx` pins the rendered entries and the
links.

## Generated documentation boundary

**Must generate public references from their canonical sources at build time.** `generateDocs` owns the inputs; `PUBLISHED_PAGES` owns which results are emitted. **Must write a separate gitignored `website/src/data/docs.<page>.json` per published result, never one combined module** (rationale).

**Must parse and validate the unpublished product guide and sync its media without emitting its data.** Reserved: **Scope: guide-page-return** restores that write. **Must strip `BUILD_ONLY_FIELDS` from emitted results while retaining them in memory for tests and public-doc lint.**

The generated data carries Markdown block/heading inventories after explicit deltas, semantic CLI nodes with exact raw help, and skill blocks with validated contextual links. **Never import Node-based Dor command implementations into browser pages.**

**Must run generation from website `predev`, `pretest`, and `prebuild`, and reproduce output from a clean checkout.**

Source of truth: `generateDocs`, `PUBLISHED_PAGES`, `BUILD_ONLY_FIELDS`, `publishable`, and `main` in `website/scripts/generate-docs.js`; scripts in `website/package.json`; generated paths in `.gitignore`.

## Homepage browser proof

The **Browsers for you (and your agents)** section in
`website/src/pages/Home.tsx` shows a terminal-to-browser transcript followed by
a browser Surface preview, and links to `/dor#agent-browser` and
`/agent-skill`.

The transcript is **authored literals in `Home.tsx`, not generated or tested**,
so it can drift from real output with nothing to catch it (rationale). Two
mitigations bound that drift: command *syntax* matches
`dor/test/snapshots/help/`, which is tested against the real CLI, and output
uses notation the CLI itself documents — `created surface:N  "<command>"` from
`dor ensure`'s text output, the resolution arrow from `dor agent-browser`'s own examples —
rather than invented formatting. **Must mark the block authored and untested in
a source comment.**

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

**Must typecheck the website before its tests.** `website/package.json` runs
`tsc --noEmit` before Vitest, including the playground adapters and generated-doc
consumers.

`scripts/public-docs-lint.mjs`, invoked by root `pnpm test` after the spec
lint, checks the rules above mechanically; each rule names its own check, and
the lint's header comment is the inventory. The rules with no other home:

- **No public source renders a `TODO:` placeholder** — the two READMEs and
  every Markdown page `SITE_ROUTES` publishes. A pending image may wait in an
  HTML comment.
- **Public links use canonical HTTPS URLs, and a local link resolves** — read
  off the parsed tree, so a link-shaped string in a code span is not a link.
  `SELF_HOST.md` and the security spec get only the HTTPS half; spec-lint
  already resolves their relative links and validates their fragments.
- **Every page whose `linkedFrom` names a README is linked from it**, as an
  exact URL, so the `/docs` entrypoint cannot stand in for a page under a
  prefix test. The guide owes no link to `/self-host` or `/security`:
  it is a Marketplace listing for the editor extension, and neither running a
  Relay nor auditing the repository is part of installing one.
- **The homepage links every page whose `linkedFrom` names it**, root-relatively,
  because a rewritten section can strand a page's only link.
- **No page is served under `/docs`, and the homepage links none there**:
  `checkNoDocsPrefixPages` fails on a `DOCS_PAGES` path or a homepage href
  starting with `/docs`, which can only be the entrypoint or a legacy 301.

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
| `docs/specs/security.md` | The security spec; every section publishes, its rows split across three pages |
| `docs/compatible-agents.md` | The agent guide and recovery contract; the public guide publishes at `/compatible-agents` |
| `vscode-ext/package.json` | Listing metadata and VS Code command inventory |
| `README.md` | Repository and contributor entry point |
| `vscode-ext/images/` | Guide media; the generator copies it to `public/guide/images/`, which the Marketplace listing loads from |
| `dor/skill.md` | The bundled agent skill, rendered exactly at `/agent-skill` |
| `dor/test/snapshots/help/` | Tested CLI help, the source for `/dor` |
| `website/src/lib/site-meta.ts` | Every page's title, description, canonical, and social cards |
| `website/src/lib/docs-pages.ts` | The rail's pages and their order; routes, prerender, rail, and lint all read it |
| `website/src/pages/Changelog.tsx`, `website/src/pages/SupplyChain.tsx` | Rail pages deriving their own sections |
| `website/public/_redirects` | The `/docs` entrypoint and the changelog SPA fallback |
| `website/src/routes.ts`, `website/src/components/SiteHeader.tsx` | The published routes and the marketing nav, which carries `Docs` on desktop |
| `website/scripts/docs-parser.js` | Markdown subset parser, slugger, `<img>` allowlist |
| `website/scripts/help-parser.js` | Narrow CLI-help parser with losslessness |
| `website/scripts/generate-docs.js` | Codegen: the delta tables, `buildDocument`, `localizeSiteLinks`, `resolveRemovedAnchors`, `resolveRepoLinks` and `SITE_ROUTES`, `assertRouteFragments`, `securityAudiences` and `audienceBlocks`, `linkSkillHeadings` |
| `website/src/components/MarkdownDocument.tsx` | Renders parsed Markdown blocks |
| `website/src/components/DocsLayout.tsx` | Docs chrome: header, the rail and its mobile drawer, prev/next, theme restore |
| `website/src/components/DocsThemeControl.tsx` | The picker's two placements and its first-visit prompt |
| `website/src/lib/docs-accent.ts` | The themed text colors, contrast-corrected per rendered surface |
| `website/src/lib/docs-theme.ts` | Default docs theme, and whether the reader has chosen |
| `website/src/components/DorCommandReference.tsx` | One CLI command section |
| `website/src/pages/DorDocs.tsx` | `/dor` |
| `website/src/pages/AgentSkillDocs.tsx` | `/agent-skill` |
| `website/src/pages/CompatibleAgentsDocs.tsx` | `/compatible-agents` |
| `website/src/pages/SelfHostDocs.tsx`, `website/src/pages/Hosted.tsx`; `website/src/components/HostingRequirementNotice.tsx` | The two hosting choices and their shared server boundary |
| `website/src/pages/SecurityDocs.tsx` | `/security` |
| `scripts/public-docs-lint.mjs` | Public-doc validation |

## Future

**Scope: website-docs-release**

Remaining work, in staged order:

1. **VSIX packaging verification.** Inspect the packaged README and media
   inventory as part of release, so a listing cannot ship with a broken image
   or an unretained local asset. Packaging already passes `--baseImagesUrl`,
   and `vscode-ext/.vscodeignore` already retains `README.md`, `icon.png`, and
   `images/`; only the inspection is missing.
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
whole, not a stub: `buildGuide` runs on every build, and only the write of its
data file was dropped once nothing imported it.

Reviving it needs a page component, an entry in `docs-pages.ts`, and
`PUBLISHED_PAGES` gaining `guide` — not new pipeline work. Whoever does it should first answer the question that removed
the page: what this rendering gives a reader that the Marketplace and GitHub
renderings do not.
