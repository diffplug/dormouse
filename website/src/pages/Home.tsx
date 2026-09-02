import {
  AppleLogoIcon,
  CheckCircleIcon,
  CubeIcon,
  DesktopIcon,
  DotsThreeOutlineIcon,
  LinuxLogoIcon,
  StorefrontIcon,
  TerminalIcon,
  WindowsLogoIcon,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEventHandler, type ReactNode } from "react";
import SiteHeader from "../components/SiteHeader";
import posterUrl from "../assets/video-climb-blink-and-stare.webp";
import videoUrl from "../assets/video-climb-blink-and-stare.mp4";
import copyPasteVideoUrl from "../assets/video-copy-paste.mp4";
import tmuxVideoUrl from "../assets/video-tmux.mp4";
import visualStudioIconUrl from "../assets/visual-studio-icon.svg";
import tinyIconUrl from "../assets/icon-tiny-dark.png";
import phoneMockupUrl from "../assets/phone-mockup.webp";
import standaloneLatest from "@standalone-latest";
import { prefersReducedMotion } from "dormouse-lib/lib/ui-geometry";

/** Multiplier on scroll required to drive the hero animation.
 *  1 = baseline, 2 = half as sensitive, 0.5 = twice as sensitive. */
const HERO_SLOMO_FACTOR = 2;

/** Scroll runway length in viewport heights. Larger = slower reveal. */
const RUNWAY_VH = 300 * HERO_SLOMO_FACTOR;

/** Scroll thresholds within the pinned runway (0–1) */
const ICON_INITIAL_HIDE_FRAC = 0.67; // Fraction of icon's rendered height hidden at load — leaves top third visible
const HOOK_CROSSFADE_START = 0.05;
const HOOK_CROSSFADE_DURATION = 0.08;
const WORD_THRESHOLDS = [0.25, 0.40, 0.55] as const;
const FOOTNOTE_THRESHOLD = 0.65;
const HEADER_REVEAL_LEAD = 0.04;
/** Runway fractions over which the dormouse line fades out. The dormouse
 *  line fades IN crossfaded with lines 1+2 (shared hookFadeProgress),
 *  then keeps carrying the brand alone until "Multitasking" pops in at
 *  WORD_THRESHOLDS[0] — this range governs that final exit. */
const DORMOUSE_LINE_FADE_OUT_START = 0.17;
const DORMOUSE_LINE_FADE_OUT_END = WORD_THRESHOLDS[0];

/** Fraction of runway where the hero text unpins and scrolls away (0–1).
 *  The video keeps scrubbing underneath. */
const UNPIN_THRESHOLD = 0.8;
const HERO_VIDEO_FPS = 120;

/** Critically-damped smoothing for the scroll value driving the hero animation.
 *  Half-life is the time for the displayed value to close half the gap to the
 *  scroll target — short enough to feel responsive, long enough to absorb the
 *  discrete jumps from clicky mouse wheels (Windows especially). */
const HERO_SCROLL_HALFLIFE_S = 0.06;
const HERO_SCROLL_SETTLE_PX = 0.5;

/** Vertical padding applied to all content sections after the hero. */
const SECTION_PY = "py-8";

/** Clamp a value to 0–1. */
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Snap a 0..1 progress to crisp 0/1 endpoints when within `eps`. The scroll
 *  smoother settles asymptotically, so opacity values can land at e.g. 0.004
 *  near a threshold — visually a ghost, and worse, it disables the browser's
 *  `opacity: 0` compositor fast-path. Snapping makes the endpoints exact. */
const snapProgress = (p: number, eps = 0.005): number =>
  p < eps ? 0 : p > 1 - eps ? 1 : p;
const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const downloadAccentStyle = {
  "--download-accent": "oklch(72% 0.15 72)",
  "--download-accent-strong": "oklch(77% 0.16 72)",
  "--download-border": "color-mix(in oklch, var(--download-accent) 58%, transparent)",
  "--download-primary": "color-mix(in oklch, var(--download-accent) 72%, var(--color-bg))",
  "--download-primary-hover": "color-mix(in oklch, var(--download-accent-strong) 82%, var(--color-bg))",
  "--download-panel": "color-mix(in oklch, var(--color-surface) 82%, var(--color-bg))",
  "--download-panel-hover": "color-mix(in oklch, var(--download-accent) 12%, var(--download-panel))",
} as CSSProperties;

const DOWNLOAD_BUTTON_BASE =
  "relative z-10 inline-flex min-w-0 items-center justify-start rounded-md border font-display leading-none transition duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] will-change-transform motion-reduce:transition-none motion-reduce:group-hover:rotate-0 motion-reduce:group-focus-visible:rotate-0";

const DOWNLOAD_BUTTON_VARIANTS = {
  primary:
    "min-h-14 w-full gap-4 px-6 py-3 text-lg sm:w-auto border-[var(--download-accent)] bg-[var(--download-primary)] text-[var(--color-text)] shadow-[0_0_18px_color-mix(in_oklch,var(--download-accent)_18%,transparent)] hover:border-[var(--download-accent-strong)] hover:bg-[var(--download-primary-hover)]",
  wide:
    "min-h-12 w-full gap-3 px-5 py-3 text-base sm:w-auto sm:text-lg border-[var(--download-border)] bg-[var(--download-panel)] text-[var(--download-accent)] hover:border-[var(--download-accent)] hover:bg-[var(--download-panel-hover)]",
  compact:
    "min-h-12 w-full gap-3 px-5 py-3 text-base sm:w-auto sm:text-lg border-[var(--download-border)] bg-[var(--download-panel)] text-[var(--download-accent)] hover:border-[var(--download-accent)] hover:bg-[var(--download-panel-hover)]",
} as const;

const DOWNLOAD_MOUSE_BASE =
  "pointer-events-none absolute z-0 size-6 transition-transform duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0 motion-reduce:group-focus-visible:translate-y-0";

const PEEK_ROTATION_DEGREES = {
  playground: -1.5,
  marketplace: 2.0,
  openVsx: 2.5,
  mac: 3.75,
  windows: -3.75,
  linux: -3.75,
  other: 3.75,
} as const;

const PEEK_MOTIONS = {
  playground: {
    faceClass: "origin-top-right",
    mouseClass: "left-3 top-1.5 -rotate-6 group-hover:-translate-y-4 group-hover:-rotate-12 group-focus-visible:-translate-y-4 group-focus-visible:-rotate-12 motion-reduce:group-hover:-rotate-6 motion-reduce:group-focus-visible:-rotate-6",
  },
  marketplace: {
    faceClass: "origin-top-left",
    mouseClass: "right-3 top-1.5 rotate-6 group-hover:-translate-y-4 group-hover:rotate-12 group-focus-visible:-translate-y-4 group-focus-visible:rotate-12 motion-reduce:group-hover:rotate-6 motion-reduce:group-focus-visible:rotate-6",
  },
  openVsx: {
    faceClass: "origin-bottom-right",
    mouseClass: "bottom-1.5 left-3 rotate-180 group-hover:translate-y-4 group-focus-visible:translate-y-4",
  },
  mac: {
    faceClass: "origin-top-left",
    mouseClass: "right-3 top-1.5 rotate-6 group-hover:-translate-y-4 group-hover:rotate-12 group-focus-visible:-translate-y-4 group-focus-visible:rotate-12 motion-reduce:group-hover:rotate-6 motion-reduce:group-focus-visible:rotate-6",
  },
  windows: {
    faceClass: "origin-top-right",
    mouseClass: "left-3 top-1.5 -rotate-6 group-hover:-translate-y-4 group-hover:-rotate-12 group-focus-visible:-translate-y-4 group-focus-visible:-rotate-12 motion-reduce:group-hover:-rotate-6 motion-reduce:group-focus-visible:-rotate-6",
  },
  linux: {
    faceClass: "origin-bottom-left",
    mouseClass: "bottom-1.5 right-3 rotate-180 group-hover:translate-y-4 group-focus-visible:translate-y-4",
  },
  other: {
    faceClass: "origin-bottom-right",
    mouseClass: "bottom-1.5 left-3 rotate-180 group-hover:translate-y-4 group-focus-visible:translate-y-4",
  },
} satisfies Record<keyof typeof PEEK_ROTATION_DEGREES, { faceClass: string; mouseClass: string }>;

const INSTALL_STEPS: Record<string, { pill: string; title: string; steps: string[] }> = {
  "darwin-aarch64": {
    pill: "Mac Silicon",
    title: "Installing on Mac",
    steps: [
      "Double-click the downloaded .tar.gz to extract Dormouse Terminal.app",
      "Drag Dormouse Terminal.app to Applications",
    ],
  },
  "windows-x86_64": {
    pill: "Windows x64",
    title: "Installing on Windows",
    steps: [
      "Double-click the downloaded Dormouse-windows-x64-setup.exe",
      "If SmartScreen appears: More info \u2192 Run anyway",
    ],
  },
  "linux-x86_64": {
    pill: "Linux x64",
    title: "Installing on Linux",
    steps: [
      "Make executable: chmod +x Dormouse-linux-x86_64.AppImage",
      "Run from terminal or double-click to launch",
    ],
  },
};

const FEATURE_VIDEO_BASE =
  "-mx-4 md:mx-0 block w-[calc(100%+2rem)] max-w-none md:w-full md:max-w-full";

const FEATURE_VIDEO_VARIANTS = {
  cover: "aspect-video object-cover",
  intrinsic: "h-auto",
} as const;

function FeatureVideo({
  src,
  className = "",
  variant = "cover",
}: {
  src: string;
  className?: string;
  variant?: keyof typeof FEATURE_VIDEO_VARIANTS;
}) {
  return (
    <video
      src={src}
      autoPlay
      loop
      muted
      playsInline
      className={[
        FEATURE_VIDEO_BASE,
        FEATURE_VIDEO_VARIANTS[variant],
        className,
      ].filter(Boolean).join(" ")}
    />
  );
}

function DownloadButton({
  href,
  children,
  icon,
  className = "",
  onClick,
  peek,
  variant = "primary",
}: {
  href: string;
  children: ReactNode;
  icon: ReactNode;
  className?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  peek: keyof typeof PEEK_MOTIONS;
  variant?: "primary" | "wide" | "compact";
}) {
  const motion = PEEK_MOTIONS[peek];
  const peekStyle = { "--peek-rotate": `${PEEK_ROTATION_DEGREES[peek]}deg` } as CSSProperties;

  return (
    <a
      href={href}
      onClick={onClick}
      className="group relative isolate inline-block overflow-visible focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-[var(--download-accent)]"
      style={peekStyle}
    >
      <img
        src={tinyIconUrl}
        alt=""
        aria-hidden="true"
        className={`${DOWNLOAD_MOUSE_BASE} ${motion.mouseClass}`}
      />
      <span className={`${DOWNLOAD_BUTTON_BASE} ${motion.faceClass} group-hover:rotate-[var(--peek-rotate)] group-focus-visible:rotate-[var(--peek-rotate)] ${DOWNLOAD_BUTTON_VARIANTS[variant]} ${className}`}>
        <span
          aria-hidden="true"
          className="flex size-6 shrink-0 items-center justify-center"
        >
          {icon}
        </span>
        <span className="min-w-0 truncate">{children}</span>
      </span>
    </a>
  );
}

function VsCodeIcon({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 bg-[var(--color-caramel)] ${className}`}
      style={{
        mask: `url("${visualStudioIconUrl}") center / contain no-repeat`,
        WebkitMask: `url("${visualStudioIconUrl}") center / contain no-repeat`,
      }}
    />
  );
}

function DownloadGroupHeader({
  icon,
  children,
}: {
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center text-[var(--color-caramel)]">
        {icon}
      </span>
      <h3 className="font-display text-xl text-[var(--color-text)]">{children}</h3>
    </div>
  );
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const posterRef = useRef<HTMLImageElement>(null);
  const runwayRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const word0Ref = useRef<HTMLSpanElement>(null);
  const word1Ref = useRef<HTMLSpanElement>(null);
  const word2Ref = useRef<HTMLSpanElement>(null);
  const footnoteRef = useRef<HTMLParagraphElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const headerBrandRef = useRef<HTMLAnchorElement>(null);
  const hookRef = useRef<HTMLDivElement>(null);
  const dormouseLineRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [installGuide, setInstallGuide] = useState<string | null>(null);
  const [heroVideoSrc, setHeroVideoSrc] = useState<string | undefined>();
  const [heroPosterReady, setHeroPosterReady] = useState(false);
  const [heroLayoutReady, setHeroLayoutReady] = useState(false);
  const [showHeroPoster, setShowHeroPoster] = useState(true);
  const heroCanPaint = heroPosterReady && heroLayoutReady;

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    const markReady = () => {
      if (!cancelled) setHeroPosterReady(true);
    };

    image.src = posterUrl;
    if (image.complete && image.naturalWidth > 0) {
      markReady();
    } else if (image.decode) {
      image.decode().then(markReady, markReady);
    } else {
      image.onload = markReady;
      image.onerror = markReady;
    }

    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, []);

  useEffect(() => {
    let objectUrl: string | null = null;
    const abortController = new AbortController();

    fetch(videoUrl, { cache: "force-cache", signal: abortController.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load hero video: ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (abortController.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setShowHeroPoster(true);
        setHeroVideoSrc(objectUrl);
      })
      .catch(() => {
        if (!abortController.signal.aborted) {
          setShowHeroPoster(true);
          setHeroVideoSrc(videoUrl);
        }
      });

    return () => {
      abortController.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, []);

  useClientLayoutEffect(() => {
    const videoElement = videoRef.current;
    const posterElement = posterRef.current;
    const runwayElement = runwayRef.current;
    if (!videoElement || !posterElement || !runwayElement) return;
    const video: HTMLVideoElement = videoElement;
    const poster: HTMLImageElement = posterElement;
    const runway: HTMLDivElement = runwayElement;
    const videoWithFrameCallbacks = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };

    const wordRefs = [word0Ref, word1Ref, word2Ref];
    let smoothRafId = 0;
    let lastSmoothTimestamp = 0;
    let handoffAnimationFrameId = 0;
    let handoffTimeoutId = 0;
    let videoFrameCallbackId = 0;
    let posterHandoffPending = false;
    let initialVideoRevealPending = false;
    let posterIsVisible = true;
    let videoCanReplacePoster = false;
    let disposed = false;
    let lastSeekFrame = -1;

    // Mobile has native momentum scrolling; layering ours on top fights it
    // (especially on iOS Safari where transforms during scroll are sensitive).
    const isTouchDevice = typeof window.matchMedia === "function"
      && window.matchMedia("(pointer: coarse)").matches;
    const skipSmoothing = prefersReducedMotion() || isTouchDevice;

    const readRunwayScroll = () => -runway.getBoundingClientRect().top;
    let smoothScroll = readRunwayScroll();

    function setPosterVisible(visible: boolean) {
      if (posterIsVisible === visible) return;
      posterIsVisible = visible;
      setShowHeroPoster(visible);
    }

    function cancelPosterHandoff() {
      posterHandoffPending = false;
      if (videoFrameCallbackId && videoWithFrameCallbacks.cancelVideoFrameCallback) {
        videoWithFrameCallbacks.cancelVideoFrameCallback(videoFrameCallbackId);
      }
      videoFrameCallbackId = 0;
      if (handoffAnimationFrameId) cancelAnimationFrame(handoffAnimationFrameId);
      handoffAnimationFrameId = 0;
      if (handoffTimeoutId) window.clearTimeout(handoffTimeoutId);
      handoffTimeoutId = 0;
    }

    function completePosterHandoff() {
      if (disposed) return;
      cancelPosterHandoff();
      setPosterVisible(false);
    }

    function revealInitialVideoFrame() {
      if (disposed || videoCanReplacePoster) return;
      initialVideoRevealPending = false;
      videoCanReplacePoster = true;
      scheduleScrollSync();
    }

    function scheduleInitialVideoReveal() {
      if (videoCanReplacePoster || initialVideoRevealPending) return;
      initialVideoRevealPending = true;

      if (videoWithFrameCallbacks.requestVideoFrameCallback) {
        videoWithFrameCallbacks.requestVideoFrameCallback(revealInitialVideoFrame);
        window.setTimeout(revealInitialVideoFrame, 500);
        return;
      }

      requestAnimationFrame(() => requestAnimationFrame(revealInitialVideoFrame));
    }

    function schedulePosterHandoff() {
      if (!posterIsVisible || posterHandoffPending) return;
      posterHandoffPending = true;

      if (videoWithFrameCallbacks.requestVideoFrameCallback) {
        videoFrameCallbackId = videoWithFrameCallbacks.requestVideoFrameCallback(() => {
          videoFrameCallbackId = 0;
          completePosterHandoff();
        });
        handoffTimeoutId = window.setTimeout(completePosterHandoff, 500);
        return;
      }

      handoffAnimationFrameId = requestAnimationFrame(() => {
        handoffAnimationFrameId = requestAnimationFrame(() => {
          handoffAnimationFrameId = 0;
          completePosterHandoff();
        });
      });
    }

    function syncScrollState(runwayScroll: number, scrollLag: number) {
      if (disposed) return;

      const runwayHeight = runway.offsetHeight - window.innerHeight;
      const fraction = runwayHeight > 0
        ? clamp01(runwayScroll / runwayHeight)
        : 0;

      // Rendered icon height (object-contain preserves aspect ratio within container).
      const naturalAspect = video.videoWidth && video.videoHeight
        ? video.videoWidth / video.videoHeight
        : 1.22; // fallback before metadata loads
      const containerAspect = video.offsetWidth / video.offsetHeight;
      const iconHeight = naturalAspect > containerAspect
        ? video.offsetWidth / naturalAspect  // width-limited
        : video.offsetHeight;                 // height-limited
      // Slomo stretches scroll-px without changing the at-rest pixel offset.
      const iconHidePx = iconHeight * ICON_INITIAL_HIDE_FRAC;
      const iconRiseScroll = iconHidePx * HERO_SLOMO_FACTOR;

      // Scrub video: hold frame 0 during icon rise, then scrub remaining range.
      // Quantize to source frames and skip duplicate frame requests. This avoids
      // issuing repeated seeks while a previous frame seek is still resolving.
      let targetFrame = 0;
      if (video.duration && isFinite(video.duration)) {
        let target = 0;
        if (runwayScroll >= iconRiseScroll) {
          const videoProgress = (runwayHeight - iconRiseScroll) > 0
            ? clamp01((runwayScroll - iconRiseScroll) / (runwayHeight - iconRiseScroll))
            : 0;
          target = videoProgress * video.duration;
        }
        const maxFrame = Math.max(0, Math.round(video.duration * HERO_VIDEO_FPS) - 1);
        targetFrame = Math.min(maxFrame, Math.max(0, Math.round(target * HERO_VIDEO_FPS)));
        const targetTime = targetFrame / HERO_VIDEO_FPS;
        const frameDuration = 1 / HERO_VIDEO_FPS;
        const frameIsCurrent = Math.abs(video.currentTime - targetTime) <= frameDuration / 2;

        if (targetFrame === 0) {
          cancelPosterHandoff();
          if (!frameIsCurrent && !video.seeking) {
            video.currentTime = targetTime;
          }
          lastSeekFrame = 0;
          setPosterVisible(!(videoCanReplacePoster && frameIsCurrent && !video.seeking));
        } else if (targetFrame !== lastSeekFrame || (!video.seeking && !frameIsCurrent)) {
          const needsPosterHandoff = posterIsVisible;
          if (needsPosterHandoff) cancelPosterHandoff();
          lastSeekFrame = targetFrame;
          video.currentTime = targetTime;
          if (needsPosterHandoff) schedulePosterHandoff();
        } else if (!video.seeking) {
          schedulePosterHandoff();
        }
      } else {
        setPosterVisible(true);
      }

      // Reveal words
      for (let i = 0; i < WORD_THRESHOLDS.length; i++) {
        const el = wordRefs[i].current;
        if (!el) continue;
        const progress = clamp01(
          (fraction - WORD_THRESHOLDS[i]) / 0.08
        );
        el.style.opacity = String(snapProgress(progress));
        el.style.transform = `translateY(${(1 - progress) * 12}px)`;
      }

      // Footnote
      const footnoteProgress = snapProgress(clamp01(
        (fraction - FOOTNOTE_THRESHOLD) / 0.08
      ));
      if (footnoteRef.current) footnoteRef.current.style.opacity = String(footnoteProgress * 0.7);

      // Header: reveal brand + background just before the tmux-shortcuts
      // footnote appears, so it reads as dark once the line is visible.
      const headerProgress = snapProgress(clamp01(
        (fraction - (FOOTNOTE_THRESHOLD - HEADER_REVEAL_LEAD)) / HEADER_REVEAL_LEAD
      ));
      if (headerBrandRef.current) {
        headerBrandRef.current.style.opacity = String(headerProgress);
      }
      if (headerRef.current) {
        const headerBlur = headerProgress > 0 ? `blur(${headerProgress * 4}px)` : '';
        headerRef.current.style.backgroundColor = `rgba(0, 0, 0, ${headerProgress * 0.6})`;
        headerRef.current.style.backdropFilter = headerBlur;
        headerRef.current.style.setProperty("-webkit-backdrop-filter", headerBlur);
      }

      // Slide video + hero up once the content section enters the viewport.
      // Both start at the same scroll position so they move in lockstep.
      const contentEnterScroll = runway.offsetHeight * UNPIN_THRESHOLD - window.innerHeight;
      const slideAmount = Math.max(0, runwayScroll - contentEnterScroll);

      // Icon-rise (lifts at rate 1/SLOMO), then unpin slide takes over.
      const iconCurrentOffset = Math.max(0, iconHidePx - runwayScroll / HERO_SLOMO_FACTOR);
      const videoTranslateY = iconCurrentOffset > 0
        ? iconCurrentOffset
        : slideAmount > 0 ? -slideAmount : 0;
      const mediaTransform = `translate3d(0, ${videoTranslateY.toFixed(3)}px, 0)`;
      video.style.transform = mediaTransform;
      poster.style.transform = mediaTransform;

      // Hook text: visible on load, then fades out early in the runway.
      // hookFadeProgress: 0 = fully visible, 1 = fully gone. Shared with the
      // dormouse line so its fade-in crossfades exactly with this fade-out.
      const hookFadeProgress = clamp01(
        (fraction - HOOK_CROSSFADE_START) / HOOK_CROSSFADE_DURATION
      );
      if (hookRef.current) {
        hookRef.current.style.opacity = String(snapProgress(1 - hookFadeProgress));
        hookRef.current.style.transform = `translateY(${-hookFadeProgress * 24}px)`;
      }

      // Dormouse line ("A dormouse knows when to wake."): fades in exactly as
      // lines 1+2 are leaving (shared hookFadeProgress = a true crossfade),
      // holds while the icon settles, then fades out before "Multitasking" pops in.
      if (dormouseLineRef.current) {
        const fadeIn = hookFadeProgress;
        const fadeOut = clamp01(
          (fraction - DORMOUSE_LINE_FADE_OUT_START)
            / (DORMOUSE_LINE_FADE_OUT_END - DORMOUSE_LINE_FADE_OUT_START)
        );
        dormouseLineRef.current.style.opacity = String(snapProgress(fadeIn * (1 - fadeOut)));
        // (1-fadeIn) lifts it into place from below as it appears; fadeOut
        // lifts it further out as it leaves, matching the hook's exit motion.
        const translateY = (1 - fadeIn) * 8 + fadeOut * -20;
        dormouseLineRef.current.style.transform = `translateY(${translateY.toFixed(2)}px)`;
      }

      // Hero: cap so it stops at unstick (fraction = 1); natural scroll takes over.
      const maxHeroOffset = runway.offsetHeight * (1 - UNPIN_THRESHOLD);
      const heroOffset = Math.min(slideAmount, maxHeroOffset);
      if (heroRef.current) {
        heroRef.current.style.transform = heroOffset > 0
          ? `translate3d(0, -${heroOffset.toFixed(3)}px, 0)`
          : '';
      }

      // Counter-translate the (natively-scrolled) content section by the same
      // lag the smoother is closing, so its top edge tracks the smoothed video.
      // Done last to avoid forcing layout between the reads above.
      if (contentRef.current) {
        contentRef.current.style.transform = scrollLag !== 0
          ? `translate3d(0, ${scrollLag.toFixed(3)}px, 0)`
          : '';
      }
    }

    function smoothFrame(now: number) {
      if (disposed) {
        smoothRafId = 0;
        return;
      }
      // Clamp dt so a tab returning from background doesn't snap-jump.
      const dt = Math.min(0.1, (now - lastSmoothTimestamp) / 1000);
      lastSmoothTimestamp = now;

      const target = readRunwayScroll();

      if (skipSmoothing) {
        smoothScroll = target;
      } else {
        const decay = Math.exp(-Math.LN2 * dt / HERO_SCROLL_HALFLIFE_S);
        smoothScroll = target - (target - smoothScroll) * decay;
      }

      // Snap before paint so the final frame clears the lag transform exactly.
      const settled = Math.abs(target - smoothScroll) <= HERO_SCROLL_SETTLE_PX;
      if (settled) smoothScroll = target;

      syncScrollState(smoothScroll, target - smoothScroll);

      if (settled) {
        smoothRafId = 0;
        if (contentRef.current) contentRef.current.style.willChange = '';
      } else {
        smoothRafId = requestAnimationFrame(smoothFrame);
      }
    }

    function scheduleScrollSync() {
      if (smoothRafId) return;
      // Promote the content layer only while smoothing is active. Toggling
      // (vs. always-on) avoids holding a composited layer for the page
      // lifetime when no animation is in flight.
      if (contentRef.current) contentRef.current.style.willChange = 'transform';
      lastSmoothTimestamp = performance.now();
      smoothRafId = requestAnimationFrame(smoothFrame);
    }

    // Mobile unlock
    let unlocked = false;
    let unlockPending = false;
    function unlock() {
      if (unlocked || unlockPending) return;
      if (!video.currentSrc) return;
      unlockPending = true;
      video.play().then(() => {
        video.pause();
        unlocked = true;
        window.removeEventListener("touchstart", unlock);
        scheduleScrollSync();
      }).catch(() => {
        unlocked = false;
      }).finally(() => {
        unlockPending = false;
      });
    }
    window.addEventListener("touchstart", unlock, { passive: true });
    const handleCanPlayThrough = () => {
      unlocked = true;
      scheduleInitialVideoReveal();
      scheduleScrollSync();
    };
    const handleLoadedMetadata = () => {
      lastSeekFrame = -1;
      videoCanReplacePoster = false;
      initialVideoRevealPending = false;
      cancelPosterHandoff();
      setPosterVisible(true);
      scheduleScrollSync();
    };
    const handleLoadedData = () => {
      scheduleInitialVideoReveal();
      scheduleScrollSync();
    };
    video.addEventListener("canplaythrough", handleCanPlayThrough, { once: true });
    video.addEventListener("loadeddata", handleLoadedData);
    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("durationchange", scheduleScrollSync);
    video.addEventListener("seeked", scheduleScrollSync);

    function onScroll() {
      if (!unlocked) unlock();
      scheduleScrollSync();
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    syncScrollState(smoothScroll, 0); // initial position, before first paint
    setHeroLayoutReady(true);

    return () => {
      disposed = true;
      cancelPosterHandoff();
      if (smoothRafId) cancelAnimationFrame(smoothRafId);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("touchstart", unlock);
      video.removeEventListener("canplaythrough", handleCanPlayThrough);
      video.removeEventListener("loadeddata", handleLoadedData);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("durationchange", scheduleScrollSync);
      video.removeEventListener("seeked", scheduleScrollSync);
    };
  }, []);

  return (
    <div style={{ visibility: heroCanPaint ? "visible" : "hidden" }}>
      <SiteHeader ref={headerRef} brandRef={headerBrandRef} brandVisible={false} />

      {/* ── Fixed video layer — bottom-anchored, scrubs for the full runway ── */}
      <video
        ref={videoRef}
        src={heroVideoSrc}
        poster={posterUrl}
        muted
        playsInline
        preload="auto"
        className="fixed bottom-0 left-0 w-full object-contain object-bottom z-0 will-change-transform"
        style={{
          height: "min(500px, calc(100vh - 420px))",
        }}
      />
      <img
        ref={posterRef}
        src={posterUrl}
        alt=""
        aria-hidden="true"
        className="pointer-events-none fixed bottom-0 left-0 w-full object-contain object-bottom z-0 will-change-transform"
        style={{
          height: "min(500px, calc(100vh - 420px))",
          opacity: showHeroPoster ? 1 : 0,
        }}
      />

      {/* ── Pinned scroll runway: hero text overlay ── */}
      <div ref={runwayRef} style={{ height: `${RUNWAY_VH}vh` }}>
        <div ref={heroRef} className="sticky top-0 flex flex-col items-center z-[1] will-change-transform" style={{ height: "100vh" }}>
          {/* Hook copy — lines 1+2 visible on load and fade out as the icon
              nears the top. The dormouse line is a sibling, not a child of
              hookRef, so its opacity is driven independently and it can
              linger after lines 1+2 are gone. */}
          <div className="absolute top-20 md:top-24 left-0 right-0 flex flex-col items-center text-center px-6 font-display text-[clamp(2rem,4vw+0.5rem,3.5rem)] leading-tight gap-3">
            <div ref={hookRef} className="flex flex-col items-center gap-3 will-change-transform">
              <span>So many terminals.</span>
              <span>Which ones need attention?</span>
            </div>
            <span
              ref={dormouseLineRef}
              className="will-change-transform"
              style={{ opacity: 0, transform: "translateY(8px)" }}
            >
              A <span className="text-[var(--color-caramel)]">dormouse</span> knows when to wake.
            </span>
          </div>
          {/* Hero words — crossfade in place with the hook, just below the header */}
          <div className="absolute top-20 md:top-24 left-0 right-0 flex flex-col items-center text-center px-6 gap-1 font-display text-[clamp(2.5rem,5vw+0.5rem,4rem)]">
            <span ref={word0Ref} style={{ opacity: 0, transform: "translateY(12px)" }}>
              Multitasking
            </span>
            <span ref={word1Ref} style={{ opacity: 0, transform: "translateY(12px)" }}>
              terminal
            </span>
            <span ref={word2Ref} style={{ opacity: 0, transform: "translateY(12px)" }}>
              <span className="text-[var(--color-caramel)]">for mice and thumbs</span>
            </span>
            <p
              ref={footnoteRef}
              className="-mt-1 text-lg"
              style={{ opacity: 0 }}
            >
              (and hotkey wizards too)
            </p>
          </div>
        </div>
      </div>

      {/* ── Content sections — pulled up to appear as video starts scrolling ── */}
      <div ref={contentRef} className="relative z-10 bg-[var(--color-bg)]" style={{ marginTop: `-${(1 - UNPIN_THRESHOLD) * RUNWAY_VH}vh` }}>
        {/* 1. Distribution + layout — one terminal, two homes */}
        <section id="features" className={`mx-auto max-w-5xl px-4 md:px-6 ${SECTION_PY}`}>
          <div>
            <h2 className="font-display text-[clamp(1.5rem,2.5vw+0.5rem,2.25rem)] mb-6">Tmux with browsers, for VS Code and Standalone</h2>
            <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
              <p className="text-lg leading-relaxed opacity-70">
                Soft as a mouse, sharp as a tmux. A real tiling layout for
                terminals and browser embeds.
                Do it all with the mouse, or keep your hands on the keyboard with
                tmux keybinds.
              </p>
              <p className="text-lg leading-relaxed opacity-70">
                Inside VS Code it follows your theme exactly - hard to tell it isn't built in.
                Standalone, it's a Tauri app that starts in a blink. Same features in both places.
              </p>
            </div>
          </div>
          <FeatureVideo src={tmuxVideoUrl} variant="intrinsic" className="mt-8" />
        </section>
        {/* Section 2: image left, text right */}
        <section id="notify" className={`mx-auto max-w-5xl px-4 md:px-6 ${SECTION_PY} grid md:grid-cols-[2fr_3fr] gap-8 md:gap-12 items-start`}>
          <img
            src={phoneMockupUrl}
            alt="Dormouse Pocket running on a phone"
            className="order-2 md:order-1 block w-full max-w-[280px] mx-auto md:max-w-none"
          />
          <div className="order-1 md:order-2">
            <h2 className="font-display text-[clamp(1.5rem,2.5vw+0.5rem,2.25rem)] text-[var(--color-text)] mb-6">
              Push notifications you can self-host
            </h2>
            <p className="mb-4 text-lg leading-relaxed opacity-70">
              Your agent hits a permission prompt four minutes after you leave,
              then sits there until you get back. Dormouse already knows that
              pane is asking for a human — so it buzzes your phone. A real push
              notification, delivered by Apple or Google, to an app that's
              completely closed.
            </p>
            <p className="mb-4 text-lg leading-relaxed opacity-70">
              Then you answer it. Tap the terminal and a radial menu opens under
              your thumb: drag down-right for{" "}
              <code className="text-sm bg-[var(--color-text)]/20 px-1.5 py-0.5 rounded">y</code>,
              up-right for{" "}
              <code className="text-sm bg-[var(--color-text)]/20 px-1.5 py-0.5 rounded">n</code>,
              or out to Esc, Ctrl+C, and a quit menu. One drag and the agent's
              moving again. No keyboard, no squinting.
            </p>
            <p className="mb-4 text-lg leading-relaxed opacity-70">
              The relay is one Node process. No database — state is JSON on
              disk, and push keys mint themselves on first boot. Put{" "}
              <code className="text-sm bg-[var(--color-text)]/20 px-1.5 py-0.5 rounded">tailscale serve</code>{" "}
              in front of it and you're done: no account, no cloud dependency,
              nothing anyone can shut off. Your laptop decides which phones get
              notified — the server isn't allowed to choose for it. The{" "}
              <a href="/docs/self-host" className="text-[var(--color-caramel)] underline-offset-2 hover:underline">self-host runbook</a>{" "}
              walks the whole install.
            </p>
            <p className="text-lg leading-relaxed opacity-70">
              <a href="/playground/pocket" className="text-[var(--color-caramel)] underline-offset-2 hover:underline">Dormouse Pocket</a>{" "}
              is in development — try the phone interface in your browser, and
              sign up there to hear when it's ready.
            </p>
          </div>
        </section>

        {/* 3. Port awareness — text left, context-menu mock right */}
        <section className={`mx-auto max-w-5xl px-4 md:px-6 ${SECTION_PY} grid md:grid-cols-[2fr_3fr] gap-8 md:gap-12 items-center`}>
          <div>
            <h2 className="font-display text-xl mb-6">Terminals that know their ports</h2>
            <p className="text-lg leading-relaxed opacity-70 mb-4">
              Six panes running and something's serving{" "}
              <code className="text-sm bg-[var(--color-text)]/20 px-1.5 py-0.5 rounded">:3000</code>.
              Which one?
            </p>
            <p className="text-lg leading-relaxed opacity-70">
              Right-click a pane and Dormouse lists the ports that pane's
              process tree is actually listening on — hit a number to open one.
              No{" "}
              <code className="text-sm bg-[var(--color-text)]/20 px-1.5 py-0.5 rounded">lsof</code>,
              no scrolling back to find where Vite printed the URL.
            </p>
          </div>
          <div className="rounded-lg border border-[var(--color-text)]/15 bg-[var(--color-text)]/[0.04] p-4">
            <div className="mb-3 flex items-center gap-2 text-sm opacity-60">
              <TerminalIcon size={15} weight="bold" />
              <span className="font-mono">web — pnpm dev</span>
            </div>
            <div className="space-y-1 font-mono text-sm">
              {[
                { key: "1", port: "3000", label: "vite" },
                { key: "2", port: "24678", label: "vite hmr" },
                { key: "3", port: "5432", label: "postgres" },
              ].map(({ key, port, label }) => (
                <div
                  key={port}
                  className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-[var(--color-text)]/10"
                >
                  <span className="w-4 text-center opacity-40">{key}</span>
                  <span className="text-[var(--color-caramel)]">localhost:{port}</span>
                  <span className="ml-auto opacity-50">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 4. Browser surfaces — transcript + preview left, text right */}
        <section className={`mx-auto max-w-5xl px-4 md:px-6 ${SECTION_PY} grid md:grid-cols-[2fr_3fr] gap-8 md:gap-12 items-center`}>
          <div className="order-2 md:order-1 space-y-4">
          {/* Authored transcript. Command syntax tracks dor/test/snapshots/help/;
              the output lines are illustrative and not generated from a test. */}
          <div className="overflow-x-auto rounded-lg border border-[var(--color-text)]/15 bg-[var(--color-text)]/[0.04] p-4 font-mono text-sm leading-relaxed">
            <div><span className="opacity-40">$ </span>dor ensure -- pnpm dev</div>
            <div className="opacity-60">created surface:3&nbsp;&nbsp;&quot;pnpm dev&quot;</div>
            <div className="mt-3"><span className="opacity-40">$ </span>dor ab open surface:3</div>
            <div className="opacity-60">&#8594; <span className="text-[var(--color-caramel)]">http://localhost:5173/</span></div>
          </div>
          <div className="overflow-hidden rounded-lg border border-[var(--color-text)]/15 bg-[var(--color-text)]/[0.04]">
            <div className="flex items-center gap-2 border-b border-[var(--color-text)]/10 px-3 py-2">
              <span className="size-2.5 rounded-full bg-[var(--color-text)]/20" />
              <span className="size-2.5 rounded-full bg-[var(--color-text)]/20" />
              <div className="ml-1 flex-1 truncate rounded bg-[var(--color-text)]/10 px-2 py-1 font-mono text-xs opacity-70">
                localhost:5173
              </div>
              <span className="rounded border border-[var(--color-caramel)]/40 px-1.5 py-0.5 font-mono text-[0.65rem] text-[var(--color-caramel)]">
                screencast
              </span>
            </div>
            <div className="space-y-2.5 p-4">
              <div className="h-2.5 w-1/3 rounded bg-[var(--color-text)]/20" />
              <div className="h-2 w-full rounded bg-[var(--color-text)]/10" />
              <div className="h-2 w-11/12 rounded bg-[var(--color-text)]/10" />
              <div className="h-2 w-4/5 rounded bg-[var(--color-text)]/10" />
              <div className="mt-4 grid grid-cols-3 gap-2.5">
                <div className="h-12 rounded bg-[var(--color-text)]/10" />
                <div className="h-12 rounded bg-[var(--color-text)]/10" />
                <div className="h-12 rounded bg-[var(--color-text)]/10" />
              </div>
            </div>
          </div>
          </div>
          <div className="order-1 md:order-2">
            <h2 className="font-display text-xl mb-6">Browsers for you (and your agents)</h2>
            <p className="text-lg leading-relaxed opacity-70 mb-4">
              A browser is just another pane. Park your dev server next to the
              terminal that's running it — same tiling layout, same keybinds, no
              alt-tab and no second monitor.
            </p>
            <p className="text-lg leading-relaxed opacity-70 mb-4">
              <code className="text-sm bg-[var(--color-text)]/20 px-1.5 py-0.5 rounded">dor ab open surface:2</code>{" "}
              aims a browser at the port that terminal is serving — the one from
              the section above. Your agents run the same command, so when an
              agent wants to see what it just built, it opens a pane you're
              already watching. Pop it out to a real OS window when you need the
              real thing.
            </p>
            <p className="text-lg leading-relaxed opacity-70 mb-4">
              Dormouse drives the{" "}
              <code className="text-sm bg-[var(--color-text)]/20 px-1.5 py-0.5 rounded">agent-browser</code>{" "}
              you already have installed — it doesn't ship a browser of its own.
            </p>
            <p className="text-base leading-relaxed opacity-60">
              <a href="/docs/dor#agent-browser" className="text-[var(--color-caramel)] underline-offset-2 hover:underline">CLI reference</a>
              {" · "}
              <a href="/docs/agent-skill" className="text-[var(--color-caramel)] underline-offset-2 hover:underline">Agent skill</a>
            </p>
          </div>
        </section>

        {/* 5. Selection and copy/paste — text left, video right */}
        <section className={`mx-auto max-w-5xl px-4 md:px-6 ${SECTION_PY} grid md:grid-cols-[2fr_3fr] gap-8 md:gap-12 items-start`}>
          <div>
            <h2 className="font-display text-xl mb-6">Select and copy-paste like you meant</h2>
            <p className="text-lg leading-relaxed opacity-70 mb-4">
              Click and drag in a "mouse conformant" terminal doesn't select
              text; it fires escape code{" "}
              <code className="text-sm bg-[var(--color-text)]/20 px-1.5 py-0.5 rounded">{"\\e[<0;x;yM"}</code>{" "}
              at whatever's running. Dormouse notices when a TUI has grabbed the
              mouse and hands you a one-click override, so you can just — select
              the thing.
            </p>
            <p className="text-lg leading-relaxed opacity-70">
              Then copy it the way you meant it. <strong className="font-semibold opacity-100">Raw</strong> keeps
              the hard wraps; <strong className="font-semibold opacity-100">Rewrapped</strong> joins them back
              into the line the program actually printed. Tap{" "}
              <code className="text-sm bg-[var(--color-text)]/20 px-1.5 py-0.5 rounded">e</code>{" "}
              mid-drag to snap the selection out to the whole URL or file path.
            </p>
          </div>
          <FeatureVideo src={copyPasteVideoUrl} />
        </section>

        <section id="download" className={`mx-auto max-w-5xl px-4 md:px-6 ${SECTION_PY}`} style={downloadAccentStyle}>
          <h2 className="font-display text-[clamp(1.5rem,2.5vw+0.5rem,2.25rem)] text-[var(--color-text)]">Get Dormouse</h2>
          <p className="mb-4 text-lg leading-relaxed opacity-70">A dormouse knows when to wake up. Multitasking terminal for mice and thumbs.</p>
          <DownloadButton
            href="/playground"
            icon={<TerminalIcon size={26} weight="bold" />}
            peek="playground"
          >
            Try it in the Playground
          </DownloadButton>

          <div className="mt-10 space-y-8">
            <div>
              <DownloadGroupHeader icon={<VsCodeIcon className="size-6" />}>VS Code Extension</DownloadGroupHeader>
              <p className="mb-4 text-lg leading-relaxed opacity-70">Also works in Cursor, Windsurf, Antigravity, or any other VS Code fork.</p>
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-3">
                <DownloadButton
                  href="https://marketplace.visualstudio.com/items?itemName=diffplug.dormouse"
                  icon={<StorefrontIcon size={22} weight="bold" />}
                  peek="marketplace"
                  variant="wide"
                >
                  Visual Studio Marketplace
                </DownloadButton>
                <DownloadButton
                  href="https://open-vsx.org/extension/diffplug/dormouse"
                  icon={<CubeIcon size={22} weight="bold" />}
                  peek="openVsx"
                  variant="wide"
                >
                  Open VSX Registry
                </DownloadButton>
              </div>
            </div>
            <div>
              <DownloadGroupHeader icon={<DesktopIcon size={24} weight="bold" />}>Standalone App</DownloadGroupHeader>
              <p className="mb-4 text-lg leading-relaxed opacity-70">Don't settle for your operating system's built-in terminal. Get a nice one.</p>
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-3">
                <DownloadButton
                  href={standaloneLatest.platforms["darwin-aarch64"].url}
                  onClick={() => setInstallGuide("darwin-aarch64")}
                  icon={<AppleLogoIcon size={22} weight="fill" />}
                  peek="mac"
                  variant="compact"
                >
                  {INSTALL_STEPS["darwin-aarch64"].pill}
                </DownloadButton>
                <DownloadButton
                  href={standaloneLatest.platforms["windows-x86_64"].url}
                  onClick={() => setInstallGuide("windows-x86_64")}
                  icon={<WindowsLogoIcon size={22} weight="fill" />}
                  peek="windows"
                  variant="compact"
                >
                  {INSTALL_STEPS["windows-x86_64"].pill}
                </DownloadButton>
                <DownloadButton
                  href={standaloneLatest.platforms["linux-x86_64"].url}
                  onClick={() => setInstallGuide("linux-x86_64")}
                  icon={<LinuxLogoIcon size={22} weight="fill" />}
                  peek="linux"
                  variant="compact"
                >
                  {INSTALL_STEPS["linux-x86_64"].pill}
                </DownloadButton>
                <DownloadButton
                  href="https://github.com/diffplug/dormouse/issues/8"
                  icon={<DotsThreeOutlineIcon size={22} weight="fill" />}
                  peek="other"
                  variant="compact"
                >
                  Other
                </DownloadButton>
              </div>
              {installGuide && INSTALL_STEPS[installGuide] && (
                <div className="mt-8 rounded-lg border border-[var(--color-text)]/20 bg-[var(--color-text)]/5 px-5 py-5 sm:px-6">
                  <p className="mb-4 flex items-center gap-3 text-lg font-display text-[var(--color-text)]">
                    <CheckCircleIcon size={26} weight="bold" className="shrink-0 text-green-500" aria-hidden="true" />
                    <span>Download started!</span>
                  </p>
                  <p className="mb-3 border-b border-[var(--color-text)]/10 pb-3 font-display text-base uppercase text-[var(--download-accent)]">{INSTALL_STEPS[installGuide].title}</p>
                  <ol className="space-y-2 text-base">
                    {INSTALL_STEPS[installGuide].steps.map((step, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="shrink-0 text-[var(--download-accent)]">{i + 1}.</span>
                        <span className="opacity-70">{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          </div>
        </section>

        <footer className="border-t border-[var(--color-text)]/20 py-10">
          <div className="mx-auto max-w-5xl px-4 md:px-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-base text-center opacity-50">
            <a href="/docs/dor" className="underline hover:opacity-100">CLI reference</a>
            <a href="/docs/agent-skill" className="underline hover:opacity-100">Agent skill</a>
            <a href="/docs/self-host" className="underline hover:opacity-100">Self-host</a>
            <a href="/supply-chain" className="underline hover:opacity-100">Supply Chain</a>
            <a href="https://github.com/diffplug/dormouse/issues" className="underline hover:opacity-100">Report an issue</a>
            <p>
              Built by{" "}
              <a href="https://nedshed.dev" className="underline hover:opacity-100">nedshed.dev</a>{" "}
              <span className="whitespace-nowrap">
                (the labs division of{" "}
                <a href="https://diffplug.com" className="underline hover:opacity-100">DiffPlug LLC</a>)
              </span>
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
