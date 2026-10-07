import { NAV_LINKS } from "../lib/site-nav";
import { sitePath } from "../lib/site-meta";

/** The bar's height, and where the Wall's join band and the Wall begin. */
export const PLAYGROUND_HEADER_HEIGHT_PX = 30;

/**
 * The desktop playground's header, drawn as the app's own title bar rather than
 * the marketing site's: the app ground, the product's type, the Workspace strip
 * resting on its bottom edge, and the site's links receding at the end like
 * window controls — so the strip reads as the standalone AppBar it stands in
 * for (`docs/specs/tutorial.md` → Playground).
 */
export default function PlaygroundHeader({
  tabs,
  join,
}: {
  /** The Workspace strip, once the playground's modules have loaded. */
  tabs?: React.ReactNode;
  /** The band seating the active tab against the Wall below the bar. */
  join?: { backgroundImage: string; height: number };
}) {
  return (
    <header
      className="fixed inset-x-0 top-0 z-20 flex select-none items-end bg-app-bg font-mono text-xs text-app-fg"
      style={{ height: PLAYGROUND_HEADER_HEIGHT_PX }}
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
        {NAV_LINKS.filter(({ href }) => href !== sitePath("/playground")).map(({ href, label, external }) => (
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
      {join ? (
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-full" style={join} />
      ) : null}
    </header>
  );
}
