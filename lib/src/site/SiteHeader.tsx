import { forwardRef, type CSSProperties, type ReactNode, type Ref } from "react";

export interface SiteNavLink {
  href: string;
  label: string;
  external?: boolean;
  hideOnMobile?: boolean;
  /** Paths this entry highlights for, when the href itself is never a page. */
  covers?: readonly string[];
}

interface SiteHeaderProps {
  /** The site's top-level links, in order. */
  links: readonly SiteNavLink[];
  /** Current path — highlights matching nav link */
  activePath?: string;
  /** Where the wordmark goes. */
  brandHref?: string;
  /** A product name set beside the wordmark, linking to `titleHref`. */
  title?: string;
  titleHref?: string;
  /** Ref for the brand link (used by Home scroll animation) */
  brandRef?: Ref<HTMLAnchorElement>;
  /** Whether brand is on a non-home page (visible + grey) vs home (hidden, animated in) */
  brandVisible?: boolean;
  /** Optional header control, used by the Pocket playground's theme picker. */
  controls?: ReactNode;
  /** Extra inline styles for the header element (background, blur, etc.) */
  style?: CSSProperties;
  /** A strip above the nav row, sharing the header's fixed height. */
  notice?: ReactNode;
}

/**
 * The dormouse.sh header: the caramel wordmark and the site's links, fixed
 * at h-16 / md:h-20, which every page offsets its content by. On Home the
 * brand fades in via scroll; on other pages it's always visible.
 * Background/blur are controlled via inline styles on the root element (Home
 * animates them; other pages set them statically).
 */
const SiteHeader = forwardRef<HTMLElement, SiteHeaderProps>(
  function SiteHeader({
    links,
    activePath,
    brandHref = "/",
    title,
    titleHref = "/",
    brandRef,
    brandVisible = true,
    controls,
    style,
    notice,
  }, ref) {
    const headerStyle: CSSProperties = { color: "var(--color-text)", ...style };

    return (
      <>
        {/* The strip shares the header's fixed height rather than adding to
            it, so every offset keyed to h-16 / md:h-20 (page padding, sticky
            rails, scroll-padding-top) stays right. On a phone the notice
            wraps to two lines, taking its height from the nav row. */}
        <header
          ref={ref}
          className="fixed top-0 left-0 right-0 z-20 flex h-16 flex-col font-display text-lg md:h-20"
          style={headerStyle}
        >
          {notice ? (
            <p
              role="note"
              className="flex min-h-6 shrink-0 items-center justify-center px-4 py-0.5 text-center font-body text-xs leading-tight sm:text-sm sm:leading-none"
              style={{ background: "var(--color-prelaunch-bg)", color: "var(--color-prelaunch-fg)" }}
            >
              {notice}
            </p>
          ) : null}
          <div className="flex min-h-0 flex-1 items-center justify-between gap-3 px-4 md:px-8">
            <div className="flex shrink-0 items-baseline gap-2.5">
              <a
                ref={brandRef}
                href={brandHref}
                className={`text-xl text-[var(--color-caramel)]${brandVisible ? " cursor-pointer" : ""}`}
                style={brandVisible ? undefined : { opacity: 0 }}
              >
                Dormouse
              </a>
              {title ? <a href={titleHref} className="text-xl">{title}</a> : null}
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-3 md:gap-8">
              {controls ? <div className="min-w-0">{controls}</div> : null}
              <nav className="flex shrink-0 items-center gap-3 text-sm min-[360px]:gap-4 min-[360px]:text-base sm:gap-5 sm:text-lg md:gap-10">
                {links.map(({ href, label, external, hideOnMobile, covers }) => {
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
          </div>
        </header>
      </>
    );
  },
);

export default SiteHeader;
