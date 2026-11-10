import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import Home from "./Home";

describe("Home prerender", () => {
  it("stays readable when no script runs", () => {
    const markup = renderToString(<MemoryRouter><Home /></MemoryRouter>);
    // Only a script may hide the page, so a visit without JavaScript (or whose
    // bundle fails) still sees it.
    expect(markup).not.toMatch(/style="[^"]*visibility:\s*hidden/);
    expect(markup).toContain("data-hero-gate");
  });

  it("fetches no feature video until it nears the viewport", () => {
    const markup = renderToString(<MemoryRouter><Home /></MemoryRouter>);
    const videos = [...markup.matchAll(/<video[^>]*>/g)].map(([tag]) => tag).filter((tag) => / src="/.test(tag));
    expect(videos.length).toBeGreaterThan(0);
    for (const tag of videos) {
      expect(tag).not.toMatch(/autoplay/i);
      expect(tag).toContain('preload="none"');
    }
  });
});
