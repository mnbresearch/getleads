import { useState } from "react";

/**
 * The 90-second explainer, embedded as a click-to-play facade.
 *
 * Nothing from YouTube loads until someone actually presses play. A bare <iframe> pulls in
 * several hundred kilobytes of player JavaScript and sets cookies on every single page
 * view, including the ones that never watch it - which costs the page its load time and
 * costs the visitor their privacy for a video most of them will scroll past. The facade is
 * one thumbnail; the real player is swapped in on the click that asks for it.
 *
 * The thumbnail comes from YouTube's own image host, so there is no asset to keep in sync
 * with the video.
 */

/**
 * The YouTube video id - the part after `v=` in the watch URL.
 *
 * Leave it empty and this whole section does not render, which is deliberate: a landing
 * page with a broken player on it is worse than one with no player. Set it the moment the
 * upload finishes and redeploy.
 */
const DEMO_VIDEO_ID = (import.meta.env.VITE_DEMO_VIDEO_ID as string | undefined) ?? "";

/** Unlisted videos work exactly the same way here - they just do not surface in search. */
export function DemoVideo() {
  const [playing, setPlaying] = useState(false);
  if (!DEMO_VIDEO_ID) return null;

  return (
    <section id="demo" className="scroll-mt-24 pb-24">
      <div className="mx-auto max-w-2xl text-center">
        <span className="badge border border-black/10 bg-black/5 text-ink-300">Watch first</span>
        <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">Ninety seconds, end to end</h2>
        <p className="mt-3 text-ink-300">
          What Scout does to a list, what it refuses to send, and what the AI engines say about you when your buyer goes
          looking.
        </p>
      </div>

      <div className="card relative mt-10 overflow-hidden p-0">
        <div className="relative aspect-video w-full bg-ink-50">
          {playing ? (
            <iframe
              className="absolute inset-0 h-full w-full"
              /* nocookie host, and no related videos from other channels when it ends. */
              src={`https://www.youtube-nocookie.com/embed/${DEMO_VIDEO_ID}?autoplay=1&rel=0&modestbranding=1`}
              title="Scout in ninety seconds"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          ) : (
            <button
              type="button"
              onClick={() => setPlaying(true)}
              className="group absolute inset-0 h-full w-full cursor-pointer"
              aria-label="Play the Scout explainer video"
            >
              <img
                src={`https://i.ytimg.com/vi/${DEMO_VIDEO_ID}/maxresdefault.jpg`}
                alt=""
                loading="eager"
                decoding="async"
                className="absolute inset-0 h-full w-full object-cover"
                /* maxres does not exist for every upload; hqdefault always does. */
                onError={(e) => {
                  e.currentTarget.src = `https://i.ytimg.com/vi/${DEMO_VIDEO_ID}/hqdefault.jpg`;
                }}
              />
              <span className="absolute inset-0 bg-ink-50/30 transition group-hover:bg-ink-50/20" aria-hidden />
              <span
                className="absolute left-1/2 top-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-brand-600 shadow-glow transition group-hover:scale-105"
                aria-hidden
              >
                <svg viewBox="0 0 24 24" className="ml-1 h-8 w-8 fill-white">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </span>
            </button>
          )}
        </div>
      </div>
      <p className="mt-4 text-center text-xs text-ink-500">
        Nothing loads from YouTube until you press play.
      </p>
    </section>
  );
}
