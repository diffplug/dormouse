import { APP_BAR_HEIGHT_PX } from "dormouse-lib/components/design";
import { NAV_LINKS_OFF_PLAYGROUND } from "../lib/site-nav";

/**
 * The desktop playground's header, drawn as the app's title bar (the standalone
 * AppBar) rather than the marketing site's (`docs/specs/tutorial.md`).
 */
export default function PlaygroundHeader({ tabs }: {
  /** `PlaygroundTabs`, once the playground's modules have loaded. */
  tabs?: React.ReactNode;
}) {
  return (
    <header
      className="fixed inset-x-0 top-0 z-20 flex select-none items-end bg-app-bg font-mono text-xs text-app-fg"
      style={{ height: APP_BAR_HEIGHT_PX }}
    >
      <a
        href="/"
        className="flex h-6 shrink-0 items-center px-3 text-sm font-semibold hover:underline focus-visible:underline underline-offset-4"
      >
        Dormouse
      </a>
      <div className="flex min-w-0 flex-1 items-end self-stretch">{tabs}</div>
      {/* On the tab row, as the wordmark is, so every label shares a line. */}
      <nav className="flex h-6 shrink-0 items-center gap-0.5 px-2">
        {NAV_LINKS_OFF_PLAYGROUND.map(({ href, label, external }) => (
          <a
            key={href}
            href={href}
            className="flex h-5 items-center rounded px-1.5 text-muted transition-colors hover:bg-current/10 hover:text-app-fg"
            {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            {label}
          </a>
        ))}
      </nav>
    </header>
  );
}
