/**
 * Copy that both ends of the setup ceremony have to agree on.
 *
 * The laptop's setup-code panel tells the user which control to tap in Pocket,
 * and Pocket labels that control — two surfaces in different bundles naming one
 * button. A literal on each side rots silently: renaming the button would leave
 * the laptop directing people to a control that no longer exists, and nothing
 * would fail. A React-free leaf both can import is the cheapest place for it;
 * `remote-lib-common` is the wrong home, being the wire contract rather than UI
 * copy.
 */

/**
 * Pocket's one way in, named for the thing the laptop is actually showing — the
 * setup code under **Settings → Remote control → Set up a phone**.
 *
 * Mirrored, deliberately unpinned, in `scripts/pairing-walkthrough/steps.mjs`,
 * which is a Node harness that cannot import this file.
 */
export const SCAN_LABEL = 'Scan a setup code';

/**
 * What a Burrow *is*, for the two screens that have to introduce the noun: the
 * laptop naming one, and the phone listing them. Defined in
 * `docs/specs/glossary.md` → Roles; this is its one user-facing wording, shared
 * for the same reason as {@link SCAN_LABEL} — two bundles, one fact, and a
 * paraphrase on either side rots without failing.
 */
export const BURROW_IS_AN_APP =
  'A Burrow is one Dormouse app — Standalone, or a VS Code window.';
