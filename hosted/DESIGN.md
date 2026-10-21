---
name: Dormouse Hosted
description: The account pages of dormouse.sh, drawn as the next page of its docs.
colors:
  page-bg: "var(--vscode-editor-background, #000)"
  page-fg: "var(--vscode-editor-foreground, #dedede)"
  accent: "var(--hosted-accent, #b47624)"
  muted: "var(--hosted-muted, #767676)"
  bad: "var(--hosted-bad, #d55050)"
  caramel: "#b47624"
  rule: "color-mix(in srgb, var(--page-fg) 15%, transparent)"
  notice-bg: "color-mix(in srgb, var(--page-fg) 4%, var(--page-bg))"
  token-bg: "color-mix(in srgb, var(--page-fg) 15%, var(--page-bg))"
  door-bg: "color-mix(in srgb, var(--page-fg) 12%, var(--page-bg))"
typography:
  display:
    fontFamily: "Ubuntu Sans Mono, ui-monospace, monospace"
    fontSize: "clamp(1.75rem, 3vw + 0.5rem, 2.5rem)"
    fontWeight: 400
    lineHeight: 1.2
  headline:
    fontFamily: "Ubuntu Sans Mono, ui-monospace, monospace"
    fontSize: "24px"
    fontWeight: 400
    lineHeight: 1.4
  title:
    fontFamily: "Ubuntu Sans Mono, ui-monospace, monospace"
    fontSize: "20px"
    fontWeight: 400
    lineHeight: 1.4
  intro:
    fontFamily: "Ubuntu Mono, ui-monospace, monospace"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "Ubuntu Mono, ui-monospace, monospace"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Ubuntu Sans Mono, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  detail:
    fontFamily: "Ubuntu Mono, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  confirm-digits:
    fontFamily: "Ubuntu Sans Mono, ui-monospace, monospace"
    fontSize: "40px"
    fontWeight: 400
    letterSpacing: "0.15em"
rounded:
  token: "4px"
  control: "6px"
  notice: "8px"
  dialog: "12px"
spacing:
  xs: "8px"
  sm: "16px"
  md: "24px"
  lg: "32px"
  xl: "48px"
components:
  button-primary:
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    typography: "{typography.body}"
    height: "48px"
    width: "100%"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.page-fg}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    typography: "{typography.body}"
    height: "44px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    padding: "0"
    typography: "{typography.body}"
    height: "44px"
  input:
    backgroundColor: "{colors.page-bg}"
    textColor: "{colors.page-fg}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
    typography: "{typography.body}"
    height: "48px"
    width: "100%"
  notice:
    backgroundColor: "{colors.notice-bg}"
    textColor: "{colors.page-fg}"
    rounded: "{rounded.notice}"
    padding: "14px 16px"
  token:
    backgroundColor: "{colors.token-bg}"
    rounded: "{rounded.token}"
    padding: "2px 6px"
    typography: "{typography.detail}"
  door:
    backgroundColor: "{colors.door-bg}"
    padding: "0 10px"
    typography: "{typography.detail}"
    height: "24px"
  dialog:
    backgroundColor: "{colors.page-bg}"
    textColor: "{colors.page-fg}"
    rounded: "{rounded.dialog}"
    padding: "24px"
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

Hosted continues the dormouse.sh reference pages it is linked from (`website/src/components/DocsLayout.tsx`, `SiteHeader.tsx`, `docs-tokens.ts`, `website/src/pages/Hosted.tsx`), not the app's design system: the [parent DESIGN.md](../DESIGN.md) Scope names it as the one product surface outside that system. The reader's editor theme is the ground, the site's Ubuntu pair is the type, the caramel wordmark is the one fixed color, and the theme's accent, corrected to AA, carries links and outlined actions. The visitor recognizes the site they came from, does one task in a narrow column, and leaves.

The page is flat and quiet: hairline rules between sections, dashed rules between list rows, outlined controls with no fill. Product facts from [PRODUCT.md](../PRODUCT.md) that bind here are the 44px target, the 16px input, and a page that makes no request beyond its own origin.

**Key Characteristics:**

- A bundled editor theme as ground, Dark Visual Studio by default, chosen in a native footer select.
- Ubuntu Sans Mono display over Ubuntu Mono body, weight 400 only, served from Hosted's origin.
- Accent, muted, and error colors derived per theme to AA; caramel fixed for the wordmark.
- One narrow column; hairline section rules; dashed checklist rows.
- Outlined controls, 44px minimum, inputs at 16px.

Implementation evidence: `src/style.css`, `src/theme.ts`, `src/ThemeSelect.tsx`, `src/HostedPage.tsx`, `src/ConfirmDigits.tsx`, `src/main.tsx`.

## Colors

Every color but the wordmark comes from the active bundled theme; `applyHostedTheme()` in `src/theme.ts` sets the theme's variables on `body` and derives the three `--hosted-*` tokens from them.

### Primary

- **Theme Accent** (`--hosted-accent`): the theme's accent through the docs' `docsAccentFor`, corrected to AA against the editor background. Links, the primary outline and its label, text buttons, focus outlines, the caret, the drawn check, hover borders, and (at 35%) the selection.
- **Caramel** (fixed): the Dormouse half of the wordmark and the header nav hover, unchanged by any theme.

### Neutral

- **Editor Ground / Editor Ink** (`--vscode-editor-background` / `--vscode-editor-foreground`): page, inputs, select, and dialog background; body text. The fallbacks paint the site's black before `theme.ts` runs.
- **Muted** (`--hosted-muted`, via `docsMutedTextFor`): intro, help, labels, footnotes, details, the footer, dialog prose, and placeholders, at AA.
- **Rule** (15% foreground): section, footer, notice, and dialog edges. Control borders mix more foreground: 30% on buttons and the door's lower edge, 50% on inputs and the select.
- **Tints** (4%, 12%, 15% foreground over the ground): notice, door, and inline token fills.
- **Bad** (`--hosted-bad`, the theme's ANSI red through `docsStatusColorFor`): error text and the failed notice, whose border takes it at 50%.

**The Theme Owns the Ground Rule.** Every surface, text, and edge color derives from the active theme's editor pair or a `--hosted-*` token; caramel is the only literal, and only for the wordmark and nav hover.

**The Docs Correction Rule.** Accent, muted, and error colors pass through the same contrast functions the docs pages use (`website/src/lib/docs-accent.ts`), so a theme reads the same here as on dormouse.sh/hosted.

## Typography

**Display Font:** Ubuntu Sans Mono (with ui-monospace, monospace)

**Body Font:** Ubuntu Mono (with ui-monospace, monospace)

**Character:** The site's own pair: the sans mono for headings, header, labels, and controls; the classic mono for reading text. Both arrive through `@fontsource` at weight 400 and are served from Hosted's origin; `font-synthesis: none` forbids faux bold.

### Hierarchy

- **Display** (400, clamp 1.75 to 2.5rem, 1.2): the page heading, balanced.
- **Headline** (400, 24px): the dialog heading.
- **Title** (400, 20px, 1.4): section headings; also the wordmark size.
- **Intro** (400, 18px, muted): the line under the heading; also the header nav size.
- **Body** (400, 16px, 1.6): reading text, buttons, and every input.
- **Label** (400, 14px, display face, muted): field labels, definition terms, the theme select.
- **Detail** (400, 14px): footnotes, row details, the inline token, the door, the footer, the provider separator.
- **Confirm digits** (400, 40px, 0.15em tracking, centered): the two enrollment digits, sized to compare at a glance against Dormouse's.

**The One Weight Rule.** Hierarchy comes from size and face, never weight: only 400 ships.

## Layout

A full-height shell stacks header, main, and footer. Main is one column capped at 528px wide with 24px side padding, 48px above and 64px below. Sections after the first sit 48px apart, each opened by a hairline rule and 32px of padding; the enrollment and provider blocks skip the rule. The intro holds 40px beneath it. Provider sign-in buttons share a two-column grid with an 8px gap.

The header is 80px tall with 32px side padding, wordmark left and site nav right (40px gaps). The footer wraps a muted tagline, three links, and the theme select, with a hairline rule above.

At 540px and below, the header drops to 64px with 16px padding and tighter type, Download hides, main starts 32px down, and the footer stacks. At 360px Playground hides too. The page holds at 280px; long ids, emails, and errors wrap anywhere rather than truncate.

## Elevation & Depth

Flat. No shadows or gradients; grouping comes from rules, spacing, and faint foreground tints. The one overlay is the Turn off Natural Voice native dialog over a 70% black backdrop. The only motion is a 150ms ease-out on button border and text color.

## Shapes

Controls carry a 6px radius; notices 8px, the dialog 12px, the inline token 4px. The computer id is a door, rounded on top only (8px 8px 0 0) over a 30% foreground sill, as the app draws a minimized Pane. Readonly inputs switch to a dashed border. Focus is a 2px accent outline at a 2px offset on every interactive element.

## Components

- **Site header:** caramel "Dormouse" and foreground "Hosted" in the display face, then the site's nav links in foreground, caramel on hover; every link at least 44px tall.
- **Primary button:** a full-width accent outline with accent label, 48px tall, underlined on hover; also drawn on a link (the subscribe action). Busy actions swap the label for progress text.
- **Secondary button:** a 30% foreground outline, 44px; hover turns border and label to the accent. Disabled is 0.5 opacity.
- **Text button:** accent text, no border or padding, 44px tall, underlined on hover.
- **Inputs:** labelled, full width, 48px, 16px text on the page ground with a 50% foreground border; muted placeholder at full opacity.
- **Notice:** a faint-tinted, rule-edged block with `role="status"`; the failed variant takes the error color. Errors outside a notice are plain error text with `role="alert"` and an inline retry.
- **Checklist rows:** sign-in methods, computers, and passkeys as 56px rows split by dashed rules, the name left and its state or action right. State is a drawn accent check plus words (Available, Connected).
- **Computer id:** the first eight characters of the id in the door shape, beside a muted enrollment date.
- **Account id:** the full id in the docs' inline-code token.
- **Dialog:** native modal, 440px max, rule-edged, muted prose; actions right-aligned with the confirming action in the accent outline right of Cancel.
- **Confirm digits:** a two-character numeric field at 4ch and 72px tall in the confirm-digits role, above help text and the full-width Approve.
- **Footer:** muted tagline and links (accent on hover) and a native theme select over the bundled themes, 44px, with a drawn chevron; the pick persists in this origin's storage.

## Do's and Don'ts

### Do:

- **Do** take every color from the active theme or a `--hosted-*` token derived in `theme.ts`.
- **Do** keep controls at 44px or more and every input at 16px.
- **Do** say state in words next to the check; never by color alone.
- **Do** serve fonts and themes from Hosted's own origin.

### Don't:

- **Don't** load remote fonts, the theme store, or any third-party resource.
- **Don't** add font weights, shadows, filled buttons, or card wrappers.
- **Don't** use caramel for anything but the wordmark and header nav hover.
- **Don't** fall back to the app's `--vscode-sideBar-*` / list-selection tokens; Hosted's ground is the editor pair.
