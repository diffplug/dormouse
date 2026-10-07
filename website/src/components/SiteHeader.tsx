import { forwardRef } from "react";
import { NAV_LINKS, NAV_LINKS_OFF_PLAYGROUND } from "../lib/site-nav";

export const STATIC_PAGE_HEADER_STYLE: React.CSSProperties = {
  background: "rgba(10, 10, 10, 0.85)",
  backdropFilter: "blur(12px)",
};

interface SiteHeaderProps {
  /** Current path — highlights matching nav link */
  activePath?: string;
  /** Ref for the brand link (used by Home scroll animation) */
  brandRef?: React.Ref<HTMLAnchorElement>;
  /** Whether brand is on a non-home page (visible + grey) vs home (hidden, animated in) */
  brandVisible?: boolean;
  /** Optional header control, used by the Pocket playground's theme picker. */
  controls?: React.ReactNode;
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
    style,
  }, ref) {
    const navLinks = activePath === "/playground" ? NAV_LINKS_OFF_PLAYGROUND : NAV_LINKS;
    const headerStyle: React.CSSProperties = { color: "var(--color-text)", ...style };

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
            className={`text-xl text-[var(--color-caramel)]${brandVisible ? " cursor-pointer" : ""}`}
            style={brandVisible ? undefined : { opacity: 0 }}
          >
            Dormouse
          </a>
          <div className="ml-auto flex min-w-0 items-center gap-3 md:gap-8">
            {controls ? <div className="min-w-0">{controls}</div> : null}
            <nav className="flex shrink-0 items-center gap-5 md:gap-10">
              {navLinks.map(({ href, label, external, hideOnMobile, covers }) => {
                const isActive = activePath === href || (activePath !== undefined && (covers?.includes(activePath) ?? false));
                return (
                  <a
                    key={href}
                    href={href}
                    className={`cursor-pointer transition-colors ${
                      hideOnMobile ? "hidden md:block " : ""
                    }${isActive ? "text-[var(--color-caramel)]" : "hover:text-[var(--color-caramel)]"}`}
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
