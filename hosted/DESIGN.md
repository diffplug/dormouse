---
name: Dormouse Hosted
description: The account pages of dormouse.sh, drawn as the next page of its docs.
colors:
  # Shared: @theme and the body tokens in lib/src/site/site.css; docs-paint.ts derives the --docs-* values per theme.
  page-bg: "var(--color-bg)"
  page-fg: "var(--color-text)"
  accent: "var(--docs-accent)"
  muted: "var(--docs-text-muted)"
  code-muted: "var(--docs-code-text-muted)"
  bad: "var(--docs-status-bad)"
  caramel: "var(--color-caramel)"
  rule: "color-mix(in oklab, var(--color-text) 15%, transparent)"
  control-edge: "color-mix(in oklab, var(--color-text) 30%, transparent)"
  field-edge: "color-mix(in oklab, var(--color-text) 50%, transparent)"
  card-tint: "color-mix(in oklab, var(--color-text) 4%, transparent)"
  door-tint: "color-mix(in oklab, var(--color-text) 12%, transparent)"
  code-tint: "color-mix(in oklab, var(--color-text) 15%, transparent)"
typography:
  display:
    # PAGE_TITLE_CLASS
    fontFamily: "var(--font-display)"
    fontSize: "clamp(1.75rem, 3vw + 0.5rem, 2.5rem)"
    fontWeight: 400
    lineHeight: 1.25
  headline:
    fontFamily: "var(--font-display)"
    fontSize: "1.5rem"
    fontWeight: 400
  title:
    fontFamily: "var(--font-display)"
    fontSize: "1.25rem"
    fontWeight: 400
  intro:
    # PAGE_INTRO_CLASS
    fontFamily: "var(--font-body)"
    fontSize: "1.125rem"
    fontWeight: 400
  body:
    fontFamily: "var(--font-body)"
    fontSize: "1rem"
    fontWeight: 400
  action:
    # siteButton
    fontFamily: "var(--font-display)"
    fontSize: "1rem"
    fontWeight: 400
  label:
    fontFamily: "var(--font-display)"
    fontSize: "0.875rem"
    fontWeight: 400
  detail:
    fontFamily: "var(--font-body)"
    fontSize: "0.875rem"
    fontWeight: 400
  confirm-digits:
    fontFamily: "var(--font-display)"
    fontSize: "40px"
    fontWeight: 400
    letterSpacing: "0.15em"
rounded:
  code: "0.25rem"
  control: "0.375rem"
  door: "0.5rem 0.5rem 0 0"
  card: "0.75rem"
spacing:
  row: "0.375rem"
  gutter: "1.5rem"
  intro: "2.5rem"
  section: "3.5rem"
  column: "33rem"
components:
  button-primary:
    # ACTION_CLASS
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    rounded: "{rounded.control}"
    padding: "0.75rem 1rem"
    typography: "{typography.action}"
    height: "48px"
    width: "100%"
  button-secondary:
    # siteButton({ tone: "neutral", size: "fit" })
    backgroundColor: "transparent"
    textColor: "{colors.page-fg}"
    rounded: "{rounded.control}"
    padding: "0.5rem 1rem"
    typography: "{typography.action}"
    height: "44px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    padding: "0"
    typography: "{typography.body}"
    height: "44px"
  input:
    # FIELD_CLASS + FIELD_TEXT_CLASS
    backgroundColor: "{colors.page-bg}"
    textColor: "{colors.page-fg}"
    rounded: "{rounded.control}"
    padding: "0.75rem 1rem"
    typography: "{typography.body}"
    height: "48px"
    width: "100%"
  notice:
    # CARD_CLASS
    backgroundColor: "{colors.card-tint}"
    textColor: "{colors.page-fg}"
    rounded: "{rounded.card}"
  account-id:
    # CODE_CLASS
    backgroundColor: "{colors.code-tint}"
    textColor: "{colors.code-muted}"
    rounded: "{rounded.code}"
  door:
    backgroundColor: "{colors.door-tint}"
    rounded: "{rounded.door}"
    padding: "0 0.625rem"
    typography: "{typography.detail}"
    height: "24px"
  dialog:
    # PANEL_CLASS
    backgroundColor: "{colors.page-bg}"
    textColor: "{colors.page-fg}"
    rounded: "{rounded.card}"
  confirm-digits:
    backgroundColor: "{colors.page-bg}"
    textColor: "{colors.page-fg}"
    rounded: "{rounded.control}"
    typography: "{typography.confirm-digits}"
    height: "72px"
    width: "4ch"
---

# Design System: Dormouse Hosted

## Overview

**Creative North Star: "The Next Page of the Docs"**

Hosted continues the dormouse.sh reference pages it is linked from, so it is built from their design rather than the app's: `lib/src/site/` holds the Tailwind `@theme` (`site.css`), the class strings (`docs-tokens.ts`), the per-theme token painter (`docs-paint.ts`), `SiteHeader`, and `DocsThemeControl`, and the website consumes the same module. This file records only what Hosted composes from that module and what it adds; the shared token values live there and are never restated here. The [parent DESIGN.md](../DESIGN.md) Scope names Hosted as the one product surface outside the app's system.

The reader's editor theme is the ground (`useDocsThemedBody` adds `docs-themed` to `body`, remapping `--color-bg` and `--color-text` onto `--vscode-editor-*`), the site's Ubuntu pair is the type, caramel is the wordmark, and the theme's accent corrected to AA carries links and outlined actions. The visitor recognizes the site they came from, does one task in a narrow column, and leaves. Product facts from [PRODUCT.md](../PRODUCT.md) that bind here: 44px minimum targets, 16px inputs, and no request beyond Hosted's own origin.

**Key Characteristics:**

- The docs theme as ground, picked in the shared theme control with the theme store off.
- Ubuntu Sans Mono display over Ubuntu Mono body, weight 400 only, bundled from `@fontsource`.
- One 33rem column; hairline section rules; dashed checklist rows.
- Outlined controls in the display face, 44px minimum, fields at 16px.
- The computer id drawn as the app's door.

Implementation evidence: `hosted/src/index.css`, `hosted/src/classes.ts`, `hosted/src/HostedPage.tsx`, `hosted/src/ConfirmDigits.tsx`, `hosted/src/App.tsx`, and `lib/src/site/`.

## Colors

Every color is a shared variable from `lib/src/site/site.css`, repainted per theme by `docsTokensFor`; Hosted adds no color of its own.

### Primary

- **Docs Accent** (`--docs-accent`): links, the primary outline and its label, text buttons, the drawn check, hover borders and labels on neutral buttons, focused field borders, button focus outlines, the caret, and (at 35%) the selection, the last two set in `hosted/src/index.css`.
- **Caramel** (`--color-caramel`): the wordmark and header nav hover, owned by `SiteHeader`; unchanged by any theme.

### Neutral

- **Ground / Ink** (`--color-bg` / `--color-text`): page, field, and dialog background; body text.
- **Muted** (`--docs-text-muted`): intro, help, labels, definition terms, row details, footnotes, the footer, and dialog prose. The account id takes `--docs-code-text-muted` through `CODE_CLASS`.
- **Foreground mixes** (4%, 12%, 15%, 30%, 50% of `--color-text`): notice tint, door tint, code tint and hairline rules, neutral-button and door-sill edges, field edges.
- **Bad** (`--docs-status-bad`): error text and the failed notice, whose border takes it at 50%.

**The Shared Token Rule.** Hosted takes every color from a `lib/src/site/` variable or class; a new color, or a new tinted container, goes into that module (with its `TINTED_DOCS_SURFACES` entry) so the website and Hosted stay one design.

## Typography

**Display Font:** Ubuntu Sans Mono (`--font-display`)

**Body Font:** Ubuntu Mono (`--font-body`)

**Character:** The site's own pair: the sans mono for headings, header, labels, and every button; the classic mono for reading text and fields. `hosted/src/index.css` imports only the 400 face of each from `@fontsource`, served from Hosted's origin.

### Hierarchy

- **Display** (`PAGE_TITLE_CLASS`, balanced, tight leading): the page heading.
- **Headline** (display, 1.5rem): the dialog heading.
- **Title** (display, 1.25rem): section headings; also the wordmark size.
- **Intro** (`PAGE_INTRO_CLASS`, muted): the line under the heading.
- **Body** (1rem): reading text, text buttons, and every field.
- **Action** (display, 1rem): every `siteButton`.
- **Label** (display, 0.875rem, muted): field labels and definition terms.
- **Detail** (body, 0.875rem): footnotes, row details, the door, the footer, "Or continue with".
- **Confirm digits** (display, 40px, 0.15em tracking, centered): the two enrollment digits, sized to compare at a glance against Dormouse's.

**The One Weight Rule.** Hierarchy comes from size and face, never weight: only 400 ships.

## Layout

A full-height shell (`min-h-svh`) offsets the fixed `SiteHeader` (`pt-16 md:pt-20`) and stacks main and footer. Main is one column capped at 33rem with 1.5rem gutters, 3rem above and 4rem below. The heading sits 0.75rem over the intro, which holds 2.5rem beneath it. Sections after the first take `SECTION_CLASS`; the enrollment, sign-in form, and provider blocks skip it. Provider sign-in buttons share a two-column grid with a 0.5rem gap. Long ids, emails, and errors wrap anywhere rather than truncate; `body` holds at 280px.

The header passes `title="Hosted"` beside the wordmark, absolute dormouse.sh links, and `DOCS_HEADER_STYLE`. Playground and Download set `hideOnMobile`, so below `md` only Docs and GitHub remain, leaving room for "Hosted"; the nav steps its own type down at `sm` and 360px.

The footer wraps a muted tagline (pushed left) and three links over a hairline rule, `px-4` widening to `px-8` at `md`. Below `lg` the theme control sits inline at the footer's end; from `lg` it floats bottom right.

## Elevation & Depth

The page is flat: grouping comes from rules, spacing, and faint foreground tints. Three shared devices carry depth: the fixed header's translucent ground with a 12px backdrop blur (`DOCS_HEADER_STYLE`), the theme control's floating panel shadow (`DocsThemeControl`), and the Turn off Natural Voice native dialog over a 70% black backdrop. Neutral buttons transition color on hover; nothing else moves.

## Shapes

Controls and fields carry `rounded-md`; notices and the dialog `rounded-xl` from `CARD_CLASS` and `PANEL_CLASS`; the account id the code token's small radius. The computer id is a door: `TERMINAL_TOP_RADIUS_CLASS` from `lib/src/components/design.tsx` rounds its top only, over a 30% foreground sill, as the app draws a minimized Pane. Readonly fields switch to a dashed border.

## Components

- **Site header:** shared `SiteHeader`; see Layout for what Hosted passes it.
- **Primary button** (`PRIMARY_CLASS`, `ACTION_CLASS` plus top margin): full-width accent outline, 48px, underlined on hover; also drawn on the subscribe link. Busy actions swap the label for progress text.
- **Secondary button** (`siteButton` neutral, fit): a 30% foreground outline, 44px; hover turns border and label to the accent. The dialog's confirming action is the accent tone at fit size. Disabled is 50% opacity.
- **Text button:** `LINK_CLASS` at 44px tall, for inline retry and form options.
- **Fields** (`INPUT_CLASS`, `LABEL_CLASS`, `HELP_CLASS` in `hosted/src/classes.ts`): a labelled `FIELD_CLASS` field, 48px, 16px text; focus turns the border to the accent.
- **Notice:** `CARD_CLASS` with `role="status"`; the failed variant is `CARD_BASE_CLASS` edged and lettered in the bad color. Errors outside a notice are plain bad text with `role="alert"` and an inline retry.
- **Checklist rows:** sign-in methods, computers, and passkeys as 56px rows split by `DASHED_ROW_CLASS`, name left and its state or action right. State is a drawn accent check (Phosphor `CheckIcon`, bold) plus muted words (Available, Connected).
- **Computer id:** the id's first eight characters in the door, beside a muted enrollment date.
- **Account details:** a definition list with muted display-face terms; the account id in `CODE_CLASS`.
- **Dialog:** native modal at `max-w-lg` holding `PANEL_CLASS`, muted prose, actions end-aligned with the accent action right of Cancel.
- **Confirm digits:** a two-character numeric field at 4ch and 72px in the confirm-digits role, sharing the field's edge and focus, above help text and the full-width Approve.
- **Footer:** muted tagline and three 44px links (`MUTED_ACCENT_LINK_CLASS`), plus `DocsThemeControl` with `offerStore={false}`.

## Do's and Don'ts

### Do:

- **Do** compose from `lib/src/site/` and add anything reusable there, not in Hosted.
- **Do** keep every target at 44px or more and every field at 16px.
- **Do** say state in words next to the check; never by color alone.
- **Do** bundle fonts from `@fontsource` and serve them from Hosted's origin.

### Don't:

- **Don't** load remote fonts, offer the theme store, or make any third-party request.
- **Don't** add font weights, filled buttons, or shadows on page content.
- **Don't** use caramel for anything but the wordmark and header nav.
- **Don't** fall back to the app's `--vscode-sideBar-*` or list-selection tokens; Hosted's ground is the docs-themed editor pair.
