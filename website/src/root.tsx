import { useEffect, type ReactNode } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useMatches,
  useRouteError,
  type MetaArgs,
} from "react-router";
import SiteHeader from "./components/SiteHeader";
import { siteMeta, sitePath } from "./lib/site-meta";
import { trackPageview, type SiteRouteHandle } from "./lib/site-analytics";
import { FONT_READY_SCRIPT, FONT_READY_STYLE } from "./lib/font-ready";
import bodyFont from "@fontsource/ubuntu-mono/files/ubuntu-mono-latin-400-normal.woff2?url";
import displayFont from "@fontsource/ubuntu-sans-mono/files/ubuntu-sans-mono-latin-400-normal.woff2?url";

/**
 * Every page's title, description, canonical, and social cards.
 *
 * A page that wants its own overrides this by exporting `meta` and calling
 * `siteMeta` itself; one that does not inherits these, still with a canonical
 * pointing at its own path. None of it may move into `<head>` below — see
 * website/src/lib/site-meta.ts for what that broke.
 */
export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname);
}

export function Layout({ children }: { children: ReactNode }) {
  // The inline font gate can still own an html attribute when hydration starts.
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#000000" />

        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />

        <link rel="preload" href={bodyFont} as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href={displayFont} as="font" type="font/woff2" crossOrigin="anonymous" />
        <Meta />
        <Links />
        <style>{FONT_READY_STYLE}</style>
        <script dangerouslySetInnerHTML={{ __html: FONT_READY_SCRIPT }} />
      </head>
      {/* A docs page's theme boot tag paints <body> before hydration
          (DocsLayout). */}
      <body suppressHydrationWarning>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/** One pageview per path, unless the route sends its own (`SiteRouteHandle`). */
function usePageviews() {
  const { pathname } = useLocation();
  const ownPageview = useMatches().some((match) => (match.handle as SiteRouteHandle | undefined)?.ownPageview);
  useEffect(() => {
    if (!ownPageview) trackPageview();
  }, [pathname, ownPageview]);
}

export default function Root() {
  usePageviews();
  return <Outlet />;
}

/**
 * A path no route matches, or a page that failed: the site's header and a
 * way home, in place of the framework's bare error. Cloudflare Pages answers
 * an unknown path with the homepage's HTML, so this is what its reader sees
 * once the page hydrates.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <SiteHeader />
      <main className="mx-auto flex max-w-2xl flex-col gap-5 px-4 pt-32 pb-24 md:px-6">
        <h1 className="font-display text-[clamp(1.75rem,3vw+0.75rem,2.75rem)]">
          {notFound ? "There is no page here." : "This page failed to load."}
        </h1>
        <a href={sitePath("/")} className="text-lg text-[var(--color-caramel)] underline underline-offset-4">
          Go to the Dormouse home page
        </a>
      </main>
    </div>
  );
}
