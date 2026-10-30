import type { ReactNode } from "react";
import DocsThemeControl from "dormouse-lib/site/DocsThemeControl";
import SiteHeader, { type SiteNavLink } from "dormouse-lib/site/SiteHeader";
import { DOCS_HEADER_STYLE } from "dormouse-lib/site/docs-paint";
import { MUTED_ACCENT_LINK_CLASS, MUTED_TEXT_CLASS } from "dormouse-lib/site/docs-tokens";

/** The site header's own links (`NAV_LINKS` in website/src/lib/site-nav.ts),
 * absolute because this is another origin. Playground also gives way on a
 * phone, making room for the "Hosted" beside the wordmark. */
const SITE_LINKS: readonly SiteNavLink[] = [
  { href: "https://dormouse.sh/playground/", label: "Playground", hideOnMobile: true },
  { href: "https://dormouse.sh/#download", label: "Download", hideOnMobile: true },
  { href: "https://dormouse.sh/docs", label: "Docs" },
  { href: "https://github.com/diffplug/dormouse", label: "GitHub", external: true },
];

const FOOTER_LINKS = [
  ["https://dormouse.sh/security/", "Dormouse security"],
  ["https://dormouse.sh/privacy/", "Privacy"],
  ["https://dormouse.sh/terms/", "Terms"],
] as const;

/** Every Hosted page's header, main column, and footer. */
export function HostedShell({
  themeControl = false,
  mainWidth = "max-w-[33rem]",
  children,
}: {
  /** The docs pages' theme control. Off in story frames, whose theme the
   * control (which paints the top-level document) cannot reach. */
  themeControl?: boolean;
  /** The main column's `max-w-*` class. */
  mainWidth?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-svh flex-col pt-16 md:pt-20" data-hosted-shell>
      <SiteHeader
        links={SITE_LINKS}
        brandHref="https://dormouse.sh"
        title="Hosted"
        style={DOCS_HEADER_STYLE}
      />
      <main className={`mx-auto w-full ${mainWidth} flex-1 px-6 pt-12 pb-16`}>{children}</main>
      <footer className={`flex flex-wrap items-center gap-x-7 border-t border-[var(--color-text)]/15 px-4 pt-4 pb-6 text-sm md:px-8 ${MUTED_TEXT_CLASS}`}>
        <span className="mr-auto py-2">Optional services. Your terminals run on your own computer.</span>
        {FOOTER_LINKS.map(([href, label]) => (
          <a key={href} href={href} rel="noreferrer" className={`inline-flex min-h-11 items-center ${MUTED_ACCENT_LINK_CLASS}`}>{label}</a>
        ))}
        {themeControl ? (
          <div className="lg:hidden">
            <DocsThemeControl variant="inline" offerStore={false} />
          </div>
        ) : null}
      </footer>
      {themeControl ? <DocsThemeControl offerStore={false} /> : null}
    </div>
  );
}
