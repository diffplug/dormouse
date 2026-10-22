import { forwardRef, type ComponentProps } from "react";
import SharedSiteHeader from "dormouse-lib/site/SiteHeader";
import { NAV_LINKS, NAV_LINKS_OFF_PLAYGROUND } from "../lib/site-nav";

export const STATIC_PAGE_HEADER_STYLE: React.CSSProperties = {
  background: "rgba(10, 10, 10, 0.85)",
  backdropFilter: "blur(12px)",
};

/**
 * Asks readers not to post the site anywhere big yet (Hacker News, mostly)
 * while Hosted rolls out. Delete it, and the `prelaunch` props, at launch.
 */
export const PRELAUNCH_NOTICE = "Pre-launch — word of mouth only, please. No top-level forum posts.";

type SiteHeaderProps = Omit<ComponentProps<typeof SharedSiteHeader>, "links" | "notice"> & {
  /** Show the pre-launch strip (Home and the reference pages). */
  prelaunch?: boolean;
};

/** The shared site header (`lib/src/site/SiteHeader.tsx`) with this site's links. */
const SiteHeader = forwardRef<HTMLElement, SiteHeaderProps>(function SiteHeader({ prelaunch = false, ...props }, ref) {
  const links = props.activePath === "/playground" ? NAV_LINKS_OFF_PLAYGROUND : NAV_LINKS;
  return <SharedSiteHeader ref={ref} links={links} notice={prelaunch ? PRELAUNCH_NOTICE : undefined} {...props} />;
});

export default SiteHeader;
