import type { ReactNode } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  type MetaArgs,
} from "react-router";
import { siteMeta } from "./lib/site-meta";
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
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  return <Outlet />;
}
