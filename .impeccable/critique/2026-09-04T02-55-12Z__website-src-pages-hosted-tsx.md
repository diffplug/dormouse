---
target: "Dormouse hosted-services funnel, especially http://localhost:5173/hosted/"
total_score: 24
max_score: 36
na_heuristics: 7
p0_count: 0
p1_count: 5
timestamp: 2026-09-04T02-55-12Z
slug: website-src-pages-hosted-tsx
---
# Dormouse Hosted funnel critique and audit

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 3 | Coming-soon, validation, and redirect states exist, but persisted theme state can be announced incorrectly after hydration. |
| 2 | Match System / Real World | 3 | Hosting boundaries are unusually plain; Pocket, coordinating server, browser speech, and ElevenLabs still assume prior knowledge. |
| 3 | User Control and Freedom | 2 | Valid submission removes the form and starts an uncancellable three-second external redirect. |
| 4 | Consistency and Standards | 3 | The visual system is cohesive, but a persuasive page inherits documentation-shell behavior and conversion leakage. |
| 5 | Error Prevention | 3 | Email semantics and disclosure are sound; the external handoff is explained before commitment. |
| 6 | Recognition Rather Than Recall | 3 | Services and caveats remain visible, but the action is below the first viewport and unfamiliar terms lack inline context. |
| 7 | Flexibility and Efficiency | n/a | No expert accelerator is meaningful for this prelaunch landing-page task. |
| 8 | Aesthetic and Minimalist Design | 2 | Repeated unavailable messaging, generic cards, weak proof, and docs navigation dilute the offer. |
| 9 | Error Recovery | 3 | Native email validation is clear and retains input; the external transition is fragile. |
| 10 | Help and Documentation | 2 | Self-hosting help is present, but current security evidence is not linked where trust is highest-stakes. |
| **Total** |  | **24/36** | **Acceptable — substantial persuasion and accessibility work remains.** |

## Technical Audit Health Score

| # | Dimension | Score | Key finding |
|---|---|---:|---|
| 1 | Accessibility | 2/4 | Theme-relative opacity pushes substantial body and consent copy below WCAG AA; redirect feedback is not a live status message. |
| 2 | Performance | 3/4 | Baseline payload is reasonable, but the offscreen phone image is preloaded and has no intrinsic dimensions. |
| 3 | Theming | 2/4 | The token architecture is thoughtful, but persisted themes cause a live hydration mismatch and browser theme-color stays black on light themes. |
| 4 | Responsive Design | 2/4 | The Hosted layout reflows, but the shared theme control becomes a 16px target and its unbounded menu overflows a 320x480 viewport. |
| 5 | Implementation Integrity | 2/4 | Product-specific structure is present, but SSR theme state and cross-package utility ownership fail in the integrated build. |
| **Total** |  | **11/20** | **Acceptable — significant work needed.** |

Technical severity count: **P0 0 · P1 4 · P2 4 · P3 1**.

## Design Specificity Verdict

**Partially authored, but too interchangeable at the page level.** The writing is distinctly Dormouse: terminals remain local, the computer must stay awake, browser speech remains, and self-hosting stays free. The phone mockup is authentic product evidence. The composition—title, notice, three rounded icon cards, newsletter form—is generic developer-tool marketing. It never turns the product into a memorable computer → coordinator → Pocket → alert story, and the voice offer has no product proof.

The required detector returned `[]` for `website/src/pages/Hosted.tsx` (exit 0). That clean result is a false-negative boundary, not proof of integrated quality: it does not follow the page into `DocsLayout`, `NotifySignupForm`, or the raw library `ThemePicker`. Browser/source verification found contrast failures, hydration divergence, missing compiled utilities, short-viewport overflow, and keyboard-semantic gaps.

No reliable user-visible overlay is available. Browser mutation/injection was unavailable, so no detector live server was started. Internal desktop/mobile screenshots and live computed styles were used instead.

## Overall Impression

Dormouse earns trust better than most prelaunch pages, but it spends the opening proving that nothing is available instead of creating desire for the future state. The strongest opportunity is to turn the existing honesty into a benefit-led, product-specific narrative with an early commitment point, then remove the accessibility and theme-integration defects that currently weaken that trust.

## What’s Working

1. **Exceptionally honest boundaries.** The page says what Hosted does not do, keeps local terminals local, and preserves free self-hosting and browser speech.
2. **Sound form fundamentals.** The email field is labeled, required, autocomplete-enabled, and preserves invalid input. Mobile form controls exceed 44px.
3. **Transparent third-party disclosure.** “Continue to nedshed.dev” and the Substack/devlog explanation prevent a bait-and-switch.

## Priority Issues

### [P1] The first viewport sells nonavailability, not the outcome

On mobile, signup begins about 2,640px down a 3,409px page. Before any action, the copy repeats “planned,” “neither is available,” “Coming soon,” “nothing to buy,” and “not available yet.” Make “Use Dormouse Pocket without running a server” the primary proposition, keep one concise availability marker, show authentic product proof, and surface a “Follow the hosted launch” action in the first viewport. Keep caveats directly below as proof. Suggested command: `$impeccable shape`.

### [P1] Theme-relative opacity makes core copy fail WCAG AA

In the live Solarized Light theme, meaningful text measured 3.40:1 at 80% opacity, 3.09:1 at 75%, 2.82:1 at 70%, and 2.01:1 at 50%. This affects product constraints, the email label/value, and the devlog disclosure. Replace element opacity with opaque, contrast-checked semantic docs tokens derived per applied background, and test every bundled theme. Suggested command: `$impeccable colorize`.

### [P1] Theme state and picker styling fail at integration boundaries

A returning-reader path rendered Solarized Light while the trigger still announced “Theme: Dark (Visual Studio),” with React reporting an unpatched hydration mismatch. Separately, raw lib Tailwind classes were not fully emitted into the website CSS: the trigger computed to 16px high and the menu lost its width, max-height, and z-index, making footer actions unreachable at 320x480. Make selected-theme markup SSR-stable, add a real-picker hydration test, and give the cross-package picker owned/compiled styles with complete keyboard behavior and bounded geometry. Suggested commands: `$impeccable harden`, then `$impeccable adapt`.

### [P1] Critical security reassurance is postponed

“Security details for the paid service will be published before launch” creates the page’s sharpest emotional valley for a managed terminal relay. Add a compact, spec-backed “What the relay can and cannot see” block, link current remote-security documentation, and distinguish established architecture from paid-service policy that remains TBD. Do not invent claims. Suggested command: `$impeccable clarify`.

### [P1] The signup handoff breaks commitment momentum and accessibility

Submission removes the form, starts a fixed three-second external redirect, offers no cancel action, and renders the transition without `role=status` or `aria-live`; the spinner also ignores reduced motion. Prefer a Dormouse-specific first-party waitlist. If Substack is fixed, say “One more step on Substack” before submission, redirect immediately, provide a cancel/back path, expose a polite live status, hide the spinner from assistive technology, and preserve email across interruption. Suggested commands: `$impeccable onboard`, `$impeccable harden`.

### [P2] Product proof is too small and asymmetric

The phone mockup is 128px wide on mobile and 160px on desktop, so its content is unreadable; voice receives only a generic speaker icon. Give remote control primary visual weight with a legible Pocket/laptop flow and make hosted voice a supporting enhancement unless evidence says both offers deserve equal emphasis. Suggested command: `$impeccable bolder`.

## Additional Technical Findings

- **[P2] Menu semantics:** `role=menu` lacks Arrow/Home/End behavior, focus-on-open, and reliable focus return. Implement the WAI-ARIA menu-button pattern or choose disclosure/listbox semantics that match Tab behavior.
- **[P2] Landmark structure:** `DocsLayout` places the h1 and essential intro outside `<main>`, so landmark navigation can skip page identity and availability context.
- **[P2] Image loading:** add the mockup’s 941x1672 intrinsic dimensions, `loading=lazy`, and `decoding=async`; confirm prerender no longer preloads an image far below the mobile fold.
- **[P2] Browser chrome:** synchronize `<meta name=theme-color>` with the active docs background instead of leaving it black on light themes.
- **[P3] Card spacing:** `AnchoredHeading` contributes a document-flow `mt-12` inside cards, visually detaching each icon from its heading and lengthening the mobile funnel.

## Cognitive Load and Emotional Journey

Cognitive load is **moderate: 3/8 checklist failures**—single focus, visual hierarchy, and minimal choices. Chunking, grouping, one-at-a-time reading, working memory, and progressive disclosure are sound. Desktop simultaneously exposes global navigation, the docs rail, theme controls, service links, and the funnel; mobile wisely collapses the rail.

The emotional path starts sober but flat, peaks at “Remote control, without running the server,” drops when security is deferred, then ends in a broader personal-devlog handoff. The page’s trust material is excellent; its desire and payoff are weak.

## Persona Red Flags

**Jordan — first-timer:** Pocket, coordinating server, browser speech, and FSL-1.1-MIT arrive before a simple job-to-be-done story. The first mobile viewport has neither action nor visible proof.

**Riley — stress tester:** Security is deferred, pricing/dates/launch order are unset, redirect has no cancel, refresh loses the email, and theme state can visibly disagree with its accessible name.

**Casey — distracted mobile user:** Signup is more than three phone viewports away. Product proof is too small to inspect. The form targets are good, but the theme picker is 16px high and its menu overflows a short viewport.

**Devon — Claude Code newcomer juggling agents:** The page never dramatizes the concrete job—step away while an agent runs, then check or hear that it needs attention. “Relays traffic” sounds risky without adjacent, plain-language security evidence.

## Minor Observations

- Only Remote control has an inline “Follow the launch” link; voice-interest users must infer that the distant form covers them.
- The phone image alt text is useful, but the black crop looks pasted rather than integrated.
- Native email validation is clear; the custom invalid-email branch is unlikely to run for browser-invalid syntax.
- The docs theme is strong for reading, but its controls add chrome to a conversion page without helping the purchase decision.

## Questions to Consider

- If a visitor sees only one viewport, should they remember “nothing is available” or “Pocket without running a server”?
- Is hosted voice truly a peer offer, or is it diluting the more urgent remote-control proposition?
- Why defer all security reassurance when the current architecture already has a documented security model?
- Is hosted demand important enough to deserve a Dormouse-only waitlist?
- How persuasive can this page become while preserving the required shared docs rail?
