import { forwardRef } from "react";

const NAV_LINKS: readonly { href: string; label: string; external?: boolean; hideOnMobile?: boolean }[] = [
  { href: "/playground", label: "Playground", hideOnMobile: true },
  { href: "/#download", label: "Download", hideOnMobile: true },
  { href: "https://github.com/diffplug/mouseterm", label: "GitHub", external: true },
];

const CHROME_INACTIVE_BG = "var(--color-header-inactive-bg)";
const CHROME_INACTIVE_FG = "var(--color-header-inactive-fg)";

const THEME_AWARE_LINK_CLASS =
  "cursor-pointer opacity-100 hover:underline focus-visible:underline underline-offset-4 decoration-[var(--color-header-inactive-fg)]";

interface SiteHeaderProps {
  /** Current path — highlights matching nav link */
  activePath?: string;
  /** Ref for the brand link (used by Home scroll animation) */
  brandRef?: React.Ref<HTMLAnchorElement>;
  /** Whether brand is on a non-home page (visible + grey) vs home (hidden, animated in) */
  brandVisible?: boolean;
  /** Optional header control, used by the playground theme picker. */
  controls?: React.ReactNode;
  /** Use VSCode theme variables instead of the marketing site's palette. */
  themeAware?: boolean;
  /** Extra inline styles for the header element (background, blur, etc.) */
  style?: React.CSSProperties;
}

/**
 * Shared site header. On Home the brand fades in via scroll; on other pages
 * it's always visible. Background/blur are controlled via inline styles on
 * the root element (Home animates them; other pages set them statically).
 */
const SiteHeader = forwardRef<HTMLElement, SiteHeaderProps>(
  function SiteHeader({
    activePath,
    brandRef,
    brandVisible = true,
    controls,
    themeAware = false,
    style,
  }, ref) {
    const navLinks = activePath === "/playground"
      ? NAV_LINKS.filter(({ href }) => href !== "/playground")
      : NAV_LINKS;

    const headerStyle: React.CSSProperties = themeAware
        ? {
          color: CHROME_INACTIVE_FG,
          backgroundColor: CHROME_INACTIVE_BG,
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          ...style,
        }
      : { color: "var(--color-text)", ...style };

    return (
      <>
        <header
          ref={ref}
          className="fixed top-0 left-0 right-0 z-20 flex h-16 items-center justify-between gap-3 px-4 py-0 font-display text-lg md:h-20 md:px-8"
          style={headerStyle}
        >
          <a
            ref={brandRef}
            href="/"
            className={
              brandVisible
                ? `cursor-pointer text-xl ${
                    themeAware
                      ? THEME_AWARE_LINK_CLASS
                      : "text-[var(--color-caramel)]"
                  }`
                : `text-xl ${
                    themeAware ? "" : "text-[var(--color-caramel)]"
                  }`
            }
            style={
              brandVisible ? undefined : {
                    color: themeAware
                      ? CHROME_INACTIVE_FG
                      : undefined,
                    opacity: 0,
                  }
            }
          >
            MouseTerm
          </a>
          <div className="ml-auto flex min-w-0 items-center gap-3 md:gap-8">
            {controls ? <div className="min-w-0">{controls}</div> : null}
            <nav className="flex shrink-0 items-center gap-5 md:gap-10">
              {navLinks.map(({ href, label, external, hideOnMobile }) => {
                const isActive = activePath === href;
                return (
                  <a
                    key={href}
                    href={href}
                    className={`cursor-pointer transition-colors ${
                      hideOnMobile ? "hidden md:block " : ""
                    }${
                      themeAware
                        ? THEME_AWARE_LINK_CLASS
                        : isActive
                          ? "text-[var(--color-caramel)]"
                          : "hover:text-[var(--color-caramel)]"
                    }`}
                    {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  >
                    {label}
                  </a>
                );
              })}
            </nav>
          </div>
        </header>
      </>
    );
  },
);

export default SiteHeader;
