---
name: Dormouse
description: A mouse-friendly multitasking terminal that feels native inside VSCode.
colors:
  app-bg: "var(--vscode-sideBar-background)"
  app-fg: "var(--vscode-sideBar-foreground)"
  surface-raised: "var(--vscode-editorWidget-background)"
  foreground: "var(--vscode-editor-foreground)"
  muted: "var(--vscode-descriptionForeground)"
  border: "var(--vscode-panel-border)"
  header-active-bg: "var(--vscode-list-activeSelectionBackground)"
  header-active-fg: "var(--vscode-list-activeSelectionForeground)"
  header-inactive-bg: "var(--vscode-list-inactiveSelectionBackground)"
  header-inactive-fg: "var(--vscode-list-inactiveSelectionForeground)"
  door-bg: "var(--color-door-bg)"
  door-fg: "var(--color-door-fg)"
  focus-ring: "var(--color-focus-ring)"
  terminal-bg: "var(--vscode-terminal-background)"
  terminal-fg: "var(--vscode-terminal-foreground)"
  input-bg: "var(--vscode-input-background)"
  input-border: "var(--vscode-input-border)"
  error: "var(--vscode-terminal-ansiRed)"
  success: "var(--vscode-terminal-ansiGreen)"
  alarm: "var(--vscode-terminal-ansiYellow)"
  window-close-hover: "#b92a1b"
typography:
  body:
    fontFamily: "var(--vscode-editor-font-family)"
    fontSize: "0.75rem"
    lineHeight: "1rem"
    fontWeight: 500
  label:
    fontFamily: "var(--vscode-editor-font-family)"
    fontSize: "0.625rem"
    lineHeight: "1rem"
    fontWeight: 600
    letterSpacing: "0.08em"
  shortcut:
    fontFamily: "var(--vscode-editor-font-family)"
    fontSize: "0.75rem"
    fontWeight: 500
rounded:
  sm: "4px"
  lg: "8px"
spacing:
  xs: "2px"
  sm: "6px"
  md: "10px"
  lg: "16px"
components:
  door:
    backgroundColor: "{colors.door-bg}"
    textColor: "{colors.door-fg}"
    rounded: "{rounded.lg}"
    height: "24px"
    padding: "0 10px"
    typography: "{typography.body}"
  header-action-button-icon:
    rounded: "{rounded.sm}"
    height: "20px"
    width: "20px"
  header-action-button-labeled:
    rounded: "{rounded.sm}"
    height: "20px"
    padding: "0 6px"
    typography: "{typography.body}"
  popup-button-row:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    typography: "{typography.body}"
  chrome-button-window:
    width: "44px"
    height: "20px"
  chrome-button-window-close:
    width: "44px"
    height: "20px"
  todo-pill:
    typography: "{typography.label}"
    textColor: "{colors.foreground}"
  kill-confirm-dialog:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "16px 24px"
---

# Design System: Dormouse

## 1. Overview

**Creative North Star: "The Native Tenant"**

Dormouse is a tenant in someone else's house. The house is VSCode. The user picked the furniture (their theme), the lighting (their mode), the typography (their editor font). Dormouse moves in, multiplies what the user can do with their terminals, and leaves the decor alone. The interface should be indistinguishable from a built-in panel: not because it imitates VSCode, but because it inherits from VSCode. Every color, every font, every surface is a passthrough of the host's tokens.

The system is intentionally minimal and bg-only. Chrome recedes; terminals are the content. Hierarchy is conveyed through background shifts between `header-active-bg` and `header-inactive-bg`, not through borders, shadows, or accent stripes. Status is conveyed through shape and position (a bell icon, a door's alert state) and through the active terminal palette's own ANSI red/green/yellow, not through a separate design-system palette.

The system explicitly rejects: rounded SaaS cards, gradient accents, hacker-aesthetic green-on-black, "Slack-style" Electron chrome bloat, decorative animations, and any token that hardcodes a color. If a user installs a high-contrast theme, the chrome can look flatter than usual: that is accepted, not "fixed" with overrides.

**Key Characteristics:**
- Host-theme-driven palette: every color is a `var(--vscode-*)` passthrough.
- Bg-only chrome: no decorative borders, no resting shadows, no accent stripes.
- Monospace everywhere: sans and mono resolve to the same VSCode editor font.
- Tight type scale: `text-xs` (10px) and `text-sm` (12px) override Tailwind defaults; almost everything sits on these two steps.
- Status through palette already in the room: alerts use the user's ANSI red / green / yellow, not a brand color.
- Motion: short, exponential ease-out for layout transitions; sparing spring-overshoot reserved for celebratory state-resolution.

## 2. Colors

The palette has no fixed values. Every semantic token resolves to a `--vscode-*` variable at runtime. Inside VSCode, those variables are injected by the host. Outside VSCode (standalone, website playground), `applyTheme()` materializes the same variable shape on `document.body` from a bundled Dormouse theme.

### Primary
This system has no "primary" accent in the brand sense. The closest analogue is the **focused-header pair**:
- **Header Active Background** (`var(--vscode-list-activeSelectionBackground)`): the bg of the focused pane's header tab. This is the only consistent visual cue for "this pane has focus." Used at full opacity for the header bg, and at `/25` opacity for the active terminal selection ring and copy-confirm flash background.
- **Header Active Foreground** (`var(--vscode-list-activeSelectionForeground)`): text on the focused header. Inherited by buttons inside the focused header.

### Secondary
- **Header Inactive Background** (`var(--vscode-list-inactiveSelectionBackground)`): unfocused pane headers and the candidate bg for doors. The bg-bg delta between this and `header-active-bg` is the entire focus affordance.
- **Header Inactive Foreground** (`var(--vscode-list-inactiveSelectionForeground)`): text on unfocused headers. Inherits the nearest `sideBar.foreground`, not the active-selection white.

### Tertiary
- **Door Background / Foreground** (`var(--color-door-bg)` / `var(--color-door-fg)`): runtime-chosen at body level by `computeDynamicPalette()`. Picks whichever of (inactive-header bg/fg) or (terminal bg/fg) has stronger OKLab perceptual separation from the app bg, so doors stay readable regardless of how close the user's chosen header and terminal palettes happen to be.
- **Focus Ring** (`var(--color-focus-ring)`): runtime-chosen. Prefers a chromatic `focusBorder`, then a chromatic active-header background, then the highest-contrast fallback. Used for the marching-ants command-mode ring and the terminal text-selection border.

### Neutral
- **App Background** (`var(--vscode-sideBar-background)`): the chrome host. Baseboard, dockview gutters, gaps around panes. Reads as "the editor's sidebar," because it literally is.
- **App Foreground** (`var(--vscode-sideBar-foreground)`): default text on app chrome.
- **Surface Raised** (`var(--vscode-editorWidget-background)`): popovers, tooltips, dialogs, kill-confirm sheet, theme picker dropdown. Roughly one step above app-bg in the host's vocabulary.
- **Foreground** (`var(--vscode-editor-foreground)`): primary text in raised surfaces (popups, dialogs).
- **Muted** (`var(--vscode-descriptionForeground)`): secondary text, shortcut hints inside `[brackets]`, theme picker chip captions.
- **Border** (`var(--vscode-panel-border)`): hairline border on raised surfaces (popups, dialogs, theme picker). The only place borders carry weight.

### Status
- **Terminal Background / Foreground** (`var(--vscode-terminal-background)` / `var(--vscode-terminal-foreground)`): the terminal content surface and xterm default text. Orthogonal to the chrome.
- **Error** (`var(--vscode-terminal-ansiRed)`): destructive actions and kill-confirm letter flash.
- **Success** (`var(--vscode-terminal-ansiGreen)`): TODO check, theme-store install confirm.
- **Alarm** (`var(--vscode-terminal-ansiYellow)` initial; runtime-rotated): bell-ringing alert tint. Per-surface OKLCH hue-rotation by `use-dynamic-palette.ts` from the bg the bell sits on, so the alert pops off any header.

### Fixed Exception
- **Window Close Hover** (`#b92a1b`): the only literal color in the whole system. Native OS close-button hover on Windows/Linux chrome buttons; matches the platform convention across themes.

### Named Rules
**The Host-Theme-Only Rule.** Never write a hex value or `oklch()` literal into `theme.css` or a component. Never use `var(..., fallback)` chains. Every color must resolve through `--vscode-*` or one of the body-published runtime picks (`--color-door-*`, `--color-focus-ring`, `--color-alarm-vs-*`). The one allowed exception is `#b92a1b` for native window-close hover.

**The Bg-Only Chrome Rule.** Pane headers, doors, and the baseboard convey hierarchy through background shifts only. Do not add borders or shadows to "make the hierarchy work." If a high-contrast theme makes a header look flat against the app bg, that is the user's theme speaking; do not override.

**The Active Header Doubles as Accent Rule.** Animated emphasis (copy-confirm flash, active-pane selection ring) tints with `header-active-bg/25`. The accent is not separate from the focus signal; they are the same color, used at different opacities.

## 3. Typography

**Display Font:** none (no display tier).
**Body Font:** `var(--vscode-editor-font-family)`.
**Label/Mono Font:** same as body. Sans and mono resolve to the same VSCode editor font.

**Character:** monospace, the user's own editor face. The system has no opinion about Cascadia vs. SF Mono vs. JetBrains Mono vs. Fira Code; whatever is set in the editor is what Dormouse uses, including ligature settings. This is the typographic equivalent of the host-theme rule.

### Hierarchy
- **Body** (weight 500, `text-sm` = 0.75rem / 12px, line-height 1rem): pane headers, doors, popup contents, button labels. The single most-used step.
- **Label** (weight 600, `text-xs` = 0.625rem / 10px, line-height 1rem, `tracking-[0.08em]`): TODO pills, kill-confirm hint, shortcut prompts. The wider tracking is non-negotiable at this size; without it the pill characters smear together.
- **Shortcut** (weight 500, `text-sm`, muted color): keybinding text inside `[brackets]`. Always rendered with the `Shortcut` component or `renderShortcuts()`, never inline.

The Tailwind defaults for `text-xs` (12px) and `text-sm` (14px) are overridden in `theme.css` to 10px and 12px respectively. The override is intentional: the chrome needs to recede, and the default Tailwind sizes are too loud against terminal output.

### Named Rules
**The Two-Step Rule.** Almost everything sits on `text-xs` or `text-sm`. If a new surface wants `text-base` or larger, the surface is probably wrong. Make it smaller or rethink the affordance.

**The Bracket-Shortcut Rule.** Keybindings always render as `[k]` in muted color via `<Shortcut>` or `renderShortcuts(...)`. Never put `Ctrl+K` or `⌘K` in chrome text. The bracket convention is the entire visual hint system for "this is a key."

## 4. Elevation

Flat by default. Pane headers, doors, the baseboard, and terminal panes carry zero shadow at rest. Hierarchy is delegated to background shifts (active vs. inactive header) and to position (doors sit on the baseboard, the baseboard sits below panes).

Shadows appear only on **raised surfaces that float above content**: popovers, tooltips, dialogs. They are ambient, not structural; they say "I am temporary and on top," not "I have weight."

### Shadow Vocabulary
- **Popover** (`box-shadow: var(--tw-shadow-md)`): tooltips (`PopupButtonRow`), selection popup, illegal-rename warning, terminal-pane header tooltips.
- **Dialog** (`box-shadow: var(--tw-shadow-lg)`): kill-confirm sheet, TODO alert dialog.
- **Modal** (`box-shadow: var(--tw-shadow-2xl)`): theme picker dropdown (when expanded), theme debugger, theme store dialog.
- **Inset hairline** (`box-shadow: inset 0 0 0 1px var(--color-focus-ring)` / `var(--color-border)`): mobile UI segmented controls. Used instead of `border` when the surface needs a 1px stroke that does not shift layout on state change.

### Named Rules
**The Flat-At-Rest Rule.** Surfaces in the resting layout (panes, doors, baseboard, terminal content) carry no shadow. Shadow appears only when a surface enters the air (popover, tooltip, dialog, modal).

**The Inset-Over-Border Rule.** When a surface needs a 1px stroke that may toggle on state change (active vs. inactive), prefer `shadow-[inset_0_0_0_1px_…]` over `border`. The shadow does not affect layout; the border does.

## 5. Components

### Doors
Doors are the pane-header indicators on the baseboard. The most signature component in the system.
- **Shape:** top corners only — `rounded-t-lg` (8px). The bottom is square so the door visually anchors to the baseboard. The pane body owns the bottom corners (`rounded-b-lg`); together they form one continuous rounded rectangle when expanded.
- **Surface:** `bg-door-bg` + `text-door-fg`. These resolve at runtime via `computeDynamicPalette()` and may match either the inactive-header palette or the terminal palette, whichever has stronger separation from `app-bg`.
- **Dimensions:** `h-6` (24px), `min-w-[68px]`, `max-w-[220px]`, horizontal padding `px-2.5` (10px), `gap-2` between title and badges.
- **Type:** `text-sm font-medium font-mono`.
- **Content:** truncated title; optional TODO pill (`text-xs font-semibold tracking-[0.08em]`, success-tinted when flourishing); optional bell icon (`size={11}`, `weight="fill"`), `text-alarm-vs-door` when ringing.
- **Hover/Focus:** no decorative hover. The whole door is a button; the focus state is conveyed by the parent pane's selection ring, not by a per-door treatment.

### Buttons

#### Header Action Button
The icon-and-tooltip button used inside pane headers (kill, alert toggle, todo, etc.).
- **Shape:** `rounded` (4px) when icon-only, also `rounded` for labeled variants.
- **Color:** `text-inherit` — inherits the header's foreground, so it tints with the active/inactive header palette.
- **Hover:** `hover:bg-current/10` — a 10%-opacity wash of the current text color. Theme-agnostic, works light or dark.
- **Tooltip:** rendered through a portal as a `PopupButtonRow` 8px below the button, with `text-sm` primary line and an optional muted detail line. Keybindings inside the tooltip auto-render as `[bracketed]` shortcuts.

#### Chrome Button (window controls)
The Windows/Linux native-style window control row in the standalone app bar.
- **Variants:** `icon` (h-5 min-w-5, hover bg-current/10), `labeled` (h-5 min-w-5 px-1.5 text-xs), `window` (w-11, hover bg-current/10), `windowClose` (w-11, hover bg `#b92a1b` text-white).
- **The exception:** `windowClose` is the only place a literal hex color is permitted, because the platform convention is a hard red regardless of theme.

### Cards / Containers

The system uses **raised surfaces**, not "cards." There are no nested cards. There is no resting card grid.
- **Raised surface** (`PopupButtonRow`, tooltips, popups): `bg-surface-raised`, `border border-border`, `rounded` (4px), `shadow-md`, `font-mono text-sm`.
- **Dialog** (`KillConfirm`, `TodoAlertDialog`): `bg-surface-raised`, `border border-border`, `rounded-lg` (8px), `shadow-lg`, generous padding (`px-6 py-4` for kill-confirm).
- **Modal** (`ThemePicker` dropdown, `ThemeDebugger`, `ThemeStoreDialog`): `bg-surface-raised`, `border`, `rounded`, `shadow-2xl`, fixed-position with viewport-clamped sizing.

### Inputs
- Used by `ThemePicker`. Style: `bg-input-bg`, `border border-input-border`, `rounded`, `font-mono`, `text-sm`.
- **Focus:** native browser focus outline; this is acceptable because the entire input lives inside a raised surface that already has `shadow-2xl` and a border.

### Navigation

The system has no traditional product top-nav. Three surfaces play navigational roles:
- **Workspace strip** (standalone app bar, top): horizontal tabs, one per Workspace, for switching between Workspaces within one window. Inactive tabs carry the union alert/TODO indicators (bell + TODO pill) borrowed from the Door vocabulary; the active tab carries none. This is standalone app-bar chrome around the Wall — see `docs/specs/layout.md` and `docs/specs/alert.md` — and its exact visual treatment is being designed in Storybook. VS Code surfaces the same status on its own native tab/badge chrome instead (`docs/specs/vscode.md`).
- **Baseboard** (bottom of the app): horizontal strip of doors representing minimized panes plus chrome action buttons. Doors are the primary navigation affordance to a minimized terminal. Button style: `h-5 rounded px-1.5 text-sm font-medium font-mono text-muted` with `hover:bg-surface-raised hover:text-foreground transition-colors`.
- **Pane Header (TerminalPaneHeader)**: the tab-replacing strip at the top of each pane. Tab-bar styling is stripped from dockview entirely (`--dv-tabs-and-actions-container-*` overrides); the React header IS the tab.

### Signature Components

#### TODO Pill
A tiny inline label that appears in pane headers and inside doors when a terminal has a TODO state.
- `text-xs font-semibold tracking-[0.08em]` — the tracking is mandatory at this size.
- Grid-stacked `<letters>` and `<check>` so width stays stable when the dismiss flourish runs.
- **Flourish (500ms):** letters fade 0–30%, check springs in 0–40% with `cubic-bezier(0.34, 1.56, 0.64, 1)` (overshoot 1.15x, settle to 1.0x at 55%), whole pill dissolves 55–100%. Reduced-motion replaces the entire sequence with opacity:0 at zero duration.

#### Pane Spawn / Kill Choreography
The most distinctive motion in the system. Implemented as `clip-path` reveals, not transforms, so `getBoundingClientRect` stays accurate during the animation (the selection overlay measures real bounds).
- **Spawn:** 440ms `cubic-bezier(0.22, 1, 0.36, 1)` clip-path reveal from left / top / top-left, depending on which side of the layout the new pane appeared on.
- **Kill (edge/middle):** 440ms `pane-fade-out`. The neighbor's spawn-grow carries the directional cue; the dying pane just fades.
- **Kill (last-pane):** 440ms `pane-fade-and-shrink-to-br`, paired with `ring-shrink-to-br` so the focus ring stays glued to the pane as it disappears.
- **Reduced-motion:** all of the above are nulled.

#### Marching Ants (Command Mode)
The selection ring around the focused pane in command mode is an SVG with `stroke-dasharray` and an infinite `marching-ants` keyframe that increments `stroke-dashoffset` by `var(--march-offset)`. Color: `var(--color-focus-ring)`. This is the system's only ongoing animation; it is meant to be the visual signature of "you are now in command mode."

## 6. Do's and Don'ts

### Do:
- **Do** route every color through a `--vscode-*` variable or a body-published runtime pick (`--color-door-*`, `--color-focus-ring`, `--color-alarm-vs-*`). The frontmatter is the contract.
- **Do** keep chrome on `text-xs` (10px) and `text-sm` (12px). The Tailwind defaults are overridden for a reason; do not write `text-base` into chrome to "make it readable."
- **Do** use `hover:bg-current/10` for neutral hover feedback inside theme-tinted chrome. It is the one hover treatment that always works.
- **Do** convey active-vs-inactive pane state through the `header-active-bg` / `header-inactive-bg` background swap. That is the entire focus affordance.
- **Do** render keybindings as `[k]` via `<Shortcut>` / `renderShortcuts`. Always muted, always bracketed.
- **Do** gate every keyframe animation behind `@media (prefers-reduced-motion: reduce)`. The pattern is in `theme.css` already; reuse it.
- **Do** use `shadow-[inset_0_0_0_1px_var(--color-…)]` instead of `border` when a stroke may toggle on state change. Border shifts layout; inset shadow does not.
- **Do** treat doors as the navigation primitive. Doors own `rounded-t-lg`; terminal bodies own `rounded-b-lg`; together they form one rectangle.
- **Do** use the spring-overshoot curve `cubic-bezier(0.34, 1.56, 0.64, 1)` only for state-resolution moments (TODO check, kill confirm, copy flash), and keep durations short (220–500ms).

### Don't:
- **Don't** write a hex color anywhere except `#b92a1b` for the windowClose hover. No exceptions. No `oklch()` literals either; even those bypass the host theme.
- **Don't** add `var(--vscode-*, #fallback)` fallback chains in `theme.css`. The runtime host plus the resolver are responsible for providing the variable; a fallback hides a real bug.
- **Don't** add borders or shadows to pane headers or doors to "make the hierarchy work." The hierarchy is `header-active-bg` vs. `header-inactive-bg`. If a high-contrast theme makes that look flat, accept it.
- **Don't** introduce a `text-muted` color inside an active or inactive pane header. Header-internal text inherits the header foreground; muting inside it breaks the focus signal.
- **Don't** use rounded SaaS cards, gradient accents, gradient text, or glassmorphism. PRODUCT.md names these directly: "Generic SaaS (rounded cards, gradients, startup illustrations)," "Electron bloat (Slack — heavy, slow-feeling, too much chrome)."
- **Don't** use hacker-aesthetic green-on-black, terminal-cliché Matrix tints, or any color that signals "this is a programmer tool." The user's theme decides what color this tool is.
- **Don't** animate layout properties (`width`, `height`, `top`, `left`, `padding`). Pane transitions use `clip-path` and `opacity` deliberately so layout measurements stay valid mid-animation.
- **Don't** add an emoji, mascot, or illustration to chrome. PRODUCT.md is explicit: "Overly playful (too many animations, emojis, mascots)."
- **Don't** wrap things in containers. Most surfaces don't need one; the host's sidebar already is the container.
- **Don't** introduce a new pass-through `--mt-*` token or a one-off color for tabs, badges, accents, or button hovers. If a new rendered surface truly needs a token that isn't in the hierarchy above, update `theme.css` and `design.tsx` together, document the addition in `docs/specs/theme.md`, and update `CONSUMED_VSCODE_KEYS` in `bundle-themes.mjs`.
