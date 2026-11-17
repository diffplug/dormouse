// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { YOUTUBE_MUSIC_VIDEO, hideYoutubeCaptions, youtubeEmbedUrl } from "./youtube";

const ORIGIN = "https://www.youtube-nocookie.com";

function mountEmbed() {
  const frame = document.createElement("iframe");
  frame.src = youtubeEmbedUrl(YOUTUBE_MUSIC_VIDEO);
  document.body.append(frame);
  const posted: unknown[] = [];
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message: unknown) => { posted.push(JSON.parse(String(message))); });
  const fromPlayer = (data: unknown, origin = ORIGIN) =>
    window.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data), origin, source: frame.contentWindow }));
  return { frame, posted, fromPlayer };
}

describe("hideYoutubeCaptions", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("embeds the music video with the embed API on", () => {
    expect(youtubeEmbedUrl(YOUTUBE_MUSIC_VIDEO)).toBe(`${ORIGIN}/embed/9X6AlJ1tUWg?enablejsapi=1`);
  });

  it("subscribes to each player load and unloads captions every time playback starts", async () => {
    const stop = hideYoutubeCaptions();
    const { frame, posted, fromPlayer } = mountEmbed();
    try {
      await Promise.resolve();
      frame.dispatchEvent(new Event("load"));
      expect(posted).toContainEqual(expect.objectContaining({ event: "listening" }));
      posted.length = 0;

      fromPlayer({ event: "infoDelivery", info: { playerState: 3 } });
      fromPlayer({ event: "infoDelivery", info: { playerState: 1 } }, "https://example.com");
      expect(posted).toEqual([]);
      for (let start = 0; start < 2; start++) fromPlayer({ event: "infoDelivery", info: { playerState: 1 } });
      expect(posted).toEqual([
        { event: "command", func: "unloadModule", args: ["captions"], id: 1, channel: "widget" },
        { event: "command", func: "unloadModule", args: ["captions"], id: 1, channel: "widget" },
      ]);
    } finally {
      stop();
    }
  });
});
