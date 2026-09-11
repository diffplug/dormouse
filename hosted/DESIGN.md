---
name: Dormouse Hosted
description: Theme-adaptive account controls for Dormouse hosted services.
colors:
  app-bg: "var(--vscode-sideBar-background)"
  app-fg: "var(--vscode-sideBar-foreground)"
  action-bg: "var(--vscode-list-activeSelectionBackground)"
  action-fg: "var(--vscode-list-activeSelectionForeground)"
  control-bg: "var(--vscode-list-inactiveSelectionBackground)"
  control-fg: "var(--vscode-list-inactiveSelectionForeground)"
  link: "var(--vscode-textLink-foreground)"
  focus: "var(--vscode-focusBorder)"
  error: "var(--vscode-errorForeground)"
typography:
  title:
    fontFamily: "var(--vscode-editor-font-family)"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "var(--vscode-editor-font-family)"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  input:
    fontFamily: "var(--vscode-editor-font-family)"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  detail:
    fontFamily: "var(--vscode-editor-font-family)"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  control: "4px"
spacing:
  small: "8px"
  medium: "16px"
  large: "24px"
  section: "32px"
components:
  button-primary:
    backgroundColor: "{colors.action-bg}"
    textColor: "{colors.action-fg}"
    rounded: "{rounded.control}"
    padding: "9px 14px"
    typography: "{typography.body}"
    width: "100%"
  button-secondary:
    backgroundColor: "{colors.control-bg}"
    textColor: "{colors.control-fg}"
    rounded: "{rounded.control}"
    padding: "9px 14px"
    typography: "{typography.body}"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.link}"
    rounded: "{rounded.control}"
    padding: "6px 0"
    typography: "{typography.body}"
  input:
    backgroundColor: "{colors.control-bg}"
    textColor: "{colors.control-fg}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
    typography: "{typography.input}"
    width: "100%"
  notice:
    backgroundColor: "{colors.control-bg}"
    textColor: "{colors.control-fg}"
    padding: "12px"
    typography: "{typography.body}"
---

# Design System: Dormouse Hosted

## Overview

**Creative North Star: "The Native Tenant"**

Hosted inherits [Dormouse's product world](../PRODUCT.md) and [parent design system](../DESIGN.md): focused, approachable, capable, with monospace text and quiet, flat controls. This app-boundary record captures the implemented account interface and its browser/mobile sizing exceptions; the parent owns shared product identity.

**Key Characteristics:**

- Runtime theme colors, including matched foreground/background pairs.
- A narrow task column with open spacing between sections.
- Mobile-sized controls with compact monospace labels.
- Inline feedback and explicit account connection states.

Implementation evidence: `src/style.css`, `src/App.tsx`, and `src/main.tsx`. The surface direction contract lives in `index.html`.

## Colors

The palette comes from bundled Dormouse themes through `applyTheme()`. System color preference selects Kimbie Dark or Light Visual Studio and updates when that preference changes.

### Primary

The active-selection pair identifies the email form's primary action. Links use the theme's link foreground; keyboard focus uses its focus border.

### Neutral

Sidebar colors paint the page and text. The inactive-selection pair paints secondary buttons, inputs, and notices. Secondary prose retains the page foreground at 0.95 opacity. Error text uses the theme's error foreground.

**The Matched Pair Rule.** Keep every control foreground paired with its theme background. Inputs, placeholders, and readonly values retain full foreground opacity.

**The Runtime Palette Rule.** Inherit colors through the existing theme variables; do not introduce fixed colors or synthetic tonal ramps.

## Typography

All roles use the parent system's editor font. Hosted deliberately extends the compact terminal type scale with the title, body, and input roles in the frontmatter. Section headings stay at body size, bold with a 1.5 line height; account identifiers and footer text use the detail role. There is no display tier.

**The Browser Form Rule.** Preserve the input role's larger type and a minimum control height of 44px for buttons and inputs, including text buttons. These are Hosted account-form exceptions to the parent's terminal chrome sizing.

## Layout

The full-height shell places header and footer around a centered column capped at 480px, including 24px horizontal padding. Main content starts 64px below its container top. Section gaps use the section spacing token; provider buttons use a two-column grid with the small gap. Account method rows align the method name left and its action or connection state right, with a minimum height of 52px.

At 540px and below, header padding becomes 16px, main top padding becomes 36px, and the footer stacks vertically. The page supports a minimum width of 280px. Long account identifiers, email addresses, and errors wrap rather than truncate.

## Elevation & Depth

The account interface has no shadows, gradients, overlays, or animated transitions. Background changes and spacing establish grouping; notices sit inline with the form or account content.

## Shapes

Buttons and inputs share gently rounded corners from the control radius token and have no resting border. Notice blocks are square. Keyboard focus uses a visible 2px outline with 3px offset.

## Components

- **Buttons:** primary actions fill the column; secondary buttons serve provider sign-in, explicit connections, and sign-out. Enabled button hover brightens the existing theme color. Disabled buttons use 0.55 opacity and a default cursor. Busy actions replace their label with progress text.
- **Text buttons and links:** use underlines with a 3px offset, thickening on hover. Text buttons retain the common minimum target height.
- **Inputs:** full-width fields with visible labels. Email and verification code share styling; readonly email keeps its normal appearance. The code field receives focus when revealed.
- **Feedback:** errors use `role="alert"` and an inline retry action. Notices and loading text use `role="status"`.
- **Account method rows:** show the provider name with either a Connect action or Connected text. State is communicated in words, not solely through color.
- **Navigation:** plain product and external links in the header and footer, with no tab bar or card wrapper.

## Do's and Don'ts

- **Do** inherit the parent theme and monospace identity.
- **Do** preserve full foreground opacity in editable, placeholder, and readonly input text.
- **Do** keep connection state and progress visible in action labels.
- **Don't** import the marketing site's palette, imagery, or typography into account controls.
- **Don't** add shadows or decorative card wrappers to this flat account surface.
- **Don't** reduce form controls to the parent's terminal chrome dimensions.
