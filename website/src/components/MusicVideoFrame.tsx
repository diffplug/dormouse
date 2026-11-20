import { useEffect, useRef } from "react";
import { IFRAME_ALLOW, IFRAME_SANDBOX } from "dormouse-lib/lib/iframe-policy";
import { YOUTUBE_MUSIC_VIDEO, pauseYoutube, youtubeEmbedUrl } from "../lib/youtube";

/** The music video, kept mounted while hidden so it resumes where it left off,
 *  and paused on hiding so it never plays unseen. */
export function MusicVideoFrame({ visible }: { visible: boolean }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!visible && frameRef.current) pauseYoutube(frameRef.current);
  }, [visible]);
  // 16:9 so a portrait screen letterboxes the poster rather than cropping it;
  // a short landscape one clamps the height and YouTube pillarboxes inside.
  return (
    <div className="flex h-full items-center bg-black">
      <iframe
        ref={frameRef}
        className="block aspect-video max-h-full w-full border-0"
        src={youtubeEmbedUrl(YOUTUBE_MUSIC_VIDEO)}
        title="Dormouse music video"
        allow={IFRAME_ALLOW}
        sandbox={IFRAME_SANDBOX}
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  );
}
