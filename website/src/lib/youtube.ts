/** The Dormouse music video, shown and linked across the site: change it here. */
export const YOUTUBE_MUSIC_VIDEO = "https://youtu.be/9X6AlJ1tUWg";

const EMBED_ORIGIN = "https://www.youtube-nocookie.com";
const EMBED_FRAMES = `iframe[src^="${EMBED_ORIGIN}/embed/"]`;
/** The embed API's `playerState` while a video plays. */
const PLAYING = 1;

/** The privacy-enhanced embed of a `youtu.be` share link, with the embed API
 *  on for {@link hideYoutubeCaptions}. */
export function youtubeEmbedUrl(shareUrl: string): string {
  return `${EMBED_ORIGIN}/embed${new URL(shareUrl).pathname}?enablejsapi=1`;
}

/** Keeps YouTube's own captions off every embed in the document, for videos
 *  that burn theirs in. YouTube ignores `cc_load_policy=0` and reloads its
 *  captions each time playback starts, so this subscribes to each player over
 *  the embed API and unloads them whenever one starts playing. */
export function hideYoutubeCaptions(): () => void {
  const post = (frame: HTMLIFrameElement, message: Record<string, unknown>) =>
    frame.contentWindow?.postMessage(JSON.stringify({ ...message, id: 1, channel: "widget" }), EMBED_ORIGIN);
  const subscribed = new WeakSet<HTMLIFrameElement>();
  const subscribe = () => {
    for (const frame of document.querySelectorAll<HTMLIFrameElement>(EMBED_FRAMES)) {
      if (subscribed.has(frame)) continue;
      subscribed.add(frame);
      // Each load is a new player; one already loaded hears this first post.
      frame.addEventListener("load", () => post(frame, { event: "listening" }));
      post(frame, { event: "listening" });
    }
  };
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== EMBED_ORIGIN || typeof event.data !== "string") return;
    const frame = [...document.querySelectorAll<HTMLIFrameElement>(EMBED_FRAMES)]
      .find((candidate) => candidate.contentWindow === event.source);
    if (!frame) return;
    let data: { info?: { playerState?: unknown } };
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data.info?.playerState === PLAYING) post(frame, { event: "command", func: "unloadModule", args: ["captions"] });
  };
  const observer = new MutationObserver(subscribe);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  addEventListener("message", onMessage);
  subscribe();
  return () => {
    observer.disconnect();
    removeEventListener("message", onMessage);
  };
}
