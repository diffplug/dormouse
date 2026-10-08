import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SiteHeader, { PRELAUNCH_NOTICE } from "./SiteHeader";

describe("SiteHeader", () => {
  it("shows the pre-launch strip only where a page asks for it", () => {
    expect(renderToStaticMarkup(<SiteHeader prelaunch />)).toContain(PRELAUNCH_NOTICE);
    // The playgrounds leave it off.
    expect(renderToStaticMarkup(<SiteHeader activePath="/playground" />)).not.toContain(PRELAUNCH_NOTICE);
  });
});
