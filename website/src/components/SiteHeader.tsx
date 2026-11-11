import type { ComponentProps } from "react";
import SharedSiteHeader from "dormouse-lib/site/SiteHeader";
import { NAV_LINKS, NAV_LINKS_OFF_PLAYGROUND } from "../lib/site-nav";

export const STATIC_PAGE_HEADER_STYLE: React.CSSProperties = {
  background: "rgba(10, 10, 10, 0.85)",
  backdropFilter: "blur(12px)",
};

type SiteHeaderProps = Omit<ComponentProps<typeof SharedSiteHeader>, "links">;

/** The shared site header (`lib/src/site/SiteHeader.tsx`) with this site's links. */
function SiteHeader(props: SiteHeaderProps) {
  const links = props.activePath === "/playground" ? NAV_LINKS_OFF_PLAYGROUND : NAV_LINKS;
  return <SharedSiteHeader links={links} {...props} />;
}

export default SiteHeader;
