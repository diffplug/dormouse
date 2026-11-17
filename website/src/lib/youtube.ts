/** The Dormouse music video, shown and linked across the site: change it here. */
export const YOUTUBE_MUSIC_VIDEO = "https://youtu.be/9X6AlJ1tUWg";

/** The privacy-enhanced embed of a `youtu.be` share link. */
export function youtubeEmbedUrl(shareUrl: string): string {
  return `https://www.youtube-nocookie.com/embed${new URL(shareUrl).pathname}`;
}
