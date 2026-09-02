/**
 * Pocket's chrome vocabulary — the class names every Pocket screen draws from,
 * and the one failure presentation they share.
 *
 * Everything here is one of theme.md's three list pairs (app / header-active /
 * header-inactive) plus alpha-on-fg for secondary text
 * (`docs/specs/pocket-app.md` → Design system and theming). It lives beside the
 * screens rather than inside `App.tsx` so a screen in its own file — the
 * scanner — draws from the same vocabulary without importing the app shell.
 */

import { tv } from 'tailwind-variants';
// Side-effecting, and load-bearing for Storybook: importing any Pocket screen
// has to bring Tailwind's utilities with it.
import '../../index.css';

/**
 * Buttons.
 *  - primary  = the active header pair (caramel): the one strong action.
 *  - secondary = recessed to the page bg; reads as a button when it sits on an
 *    inactive-header row via the guaranteed app↔inactive delta.
 *  - outline = the subordinate action *on* the page, where secondary would be
 *    bg-on-bg: an alpha-on-fg hairline, because panel-border is transparent in
 *    many themes. Drawn as an inset shadow rather than a border (DESIGN.md,
 *    the Inset-Over-Border Rule), and at /25 rather than `PK.divided`'s /15 —
 *    a tappable affordance has to hold its edge, where a divider only has to
 *    separate.
 *  - ghost = transparent, inherits the surrounding band fg (header actions).
 */
export const pkButton = tv({
  base: 'inline-flex items-center justify-center rounded-lg font-medium transition-colors active:brightness-110 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
  variants: {
    tone: {
      primary: 'bg-header-active-bg text-header-active-fg',
      secondary: 'bg-app-bg text-app-fg',
      outline: 'shadow-[inset_0_0_0_1px] shadow-app-fg/25 text-app-fg',
      ghost: 'text-inherit hover:bg-current/10',
    },
    size: {
      lg: 'min-h-[44px] px-4 text-[13px]',
      sm: 'min-h-9 px-3 text-[12px]',
    },
    block: { true: 'w-full', false: '' },
  },
  defaultVariants: { tone: 'primary', size: 'lg', block: false },
});

export const PK = {
  app: 'flex h-full min-h-0 flex-col bg-app-bg text-app-fg',
  // Header band = the ACTIVE header pair (the "titlebar").
  header:
    'flex shrink-0 items-center gap-2 bg-header-active-bg px-4 pb-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] text-header-active-fg',
  headerTitle: 'm-0 min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[0.01em]',
  body:
    'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]',
  // Safe centering: the first-run screen (install notice + the scan action + the
  // sign-in alternative) can outgrow a small phone, and plain `justify-center`
  // in a scroll container puts the overflow above the scrollable area,
  // unreachable. WebKit before Safari/iOS 17.6 does not parse the `safe` keyword
  // and drops the declaration, so those devices render top-aligned — usable and
  // scrollable, and accepted, because a plain `justify-center` fallback would
  // reintroduce the unreachable overflow on exactly the devices that lack it.
  bodyCenter: 'justify-center-safe',
  wallHost: 'flex min-h-0 flex-1 flex-col',
  // Host row = the INACTIVE header pair (a list item lifted off the page).
  row: 'flex w-full items-center gap-3 rounded-lg bg-header-inactive-bg px-3.5 py-3 text-left text-header-inactive-fg',
  rowOffline: 'opacity-55', // presence = intensity, no extra color
  rowMain: 'min-w-0 flex-1',
  rowTitle: 'truncate text-[13px] font-semibold',
  rowSecondary: 'mt-0.5 truncate text-[11px] text-header-inactive-fg/70',
  rowActions: 'flex shrink-0 items-center gap-2',
  // An actionable notice: the inactive-header pair, so it reads as a raised
  // block like a host row rather than as an error (which owns `text-error`).
  notice: 'flex flex-col gap-2 rounded-lg bg-header-inactive-bg px-3.5 py-3 text-header-inactive-fg',
  noticeTitle: 'text-[13px] font-semibold',
  noticeBody: 'm-0 text-[12px] leading-relaxed text-header-inactive-fg/70',
  field: 'flex flex-col gap-1.5',
  fieldLabel: 'text-[11px] text-app-fg/60',
  input:
    'w-full rounded-lg bg-input-bg px-3.5 py-3 text-[16px] text-app-fg outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-focus-ring',
  title: 'm-0 text-[20px] font-semibold',
  lead: 'm-0 text-[13px] leading-relaxed text-app-fg/70',
  // Error sits on the darker page bg (best red contrast) and is delineated by a
  // reliable red inset hairline — panel-border is transparent in many themes.
  error: 'rounded-lg px-3.5 py-2.5 text-[13px] text-error shadow-[inset_0_0_0_1px_var(--color-error)]',
  empty: 'px-4 py-10 text-center text-[13px] text-app-fg/70',
  // A settled fact about this browser, captioned rather than carded: push, once
  // every paired Host can reach it.
  deviceLine: 'px-4 pt-1 text-[11px] text-app-fg/60',
  // A group of form controls; `divided` sets one off from the action above it.
  setup: 'flex flex-col gap-3',
  divided: 'border-t border-app-fg/15 pt-4',
  // The camera preview. Square, because a QR is, and clipped so the video's own
  // aspect ratio cannot letterbox the page.
  viewfinder: 'aspect-square w-full overflow-hidden rounded-lg bg-header-inactive-bg',
  viewfinderVideo: 'h-full w-full object-cover',
  // The two digits the laptop has to be told: the whole content of its screen.
  code: 'm-0 text-center font-mono text-[64px] font-semibold leading-none tracking-[0.15em]',
} as const;

/**
 * The one failure presentation, on every screen. Announced everywhere, because
 * on each of them a failure is the only thing that changed.
 */
export function ErrorRow({ message }: { message: string }): React.ReactElement {
  return (
    <div className={PK.error} role="alert">
      {message}
    </div>
  );
}
