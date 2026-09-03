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
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#000000" />

        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />

        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Ubuntu+Mono&family=Ubuntu+Sans+Mono&display=swap" rel="stylesheet" />
        <Meta />
        <Links />
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
