export const BRAND_NAME = "Scout";
export const BRAND_TAGLINE = "Lead intelligence for sales teams and AI agents";

/**
 * Logo mark: a compass/spyglass needle pointing to a found target — scouting
 * read as "survey the field, lock onto the right lead."
 */
export function LogoMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <rect width="28" height="28" rx="8" fill="url(#sc-grad)" />
      <circle cx="13" cy="13" r="7.25" stroke="white" strokeWidth="1.8" opacity="0.9" />
      <path d="M10.4 15.6L12.6 11L17.2 8.8L15 13.4L10.4 15.6Z" fill="white" />
      <circle cx="20.5" cy="20.5" r="1.4" fill="white" opacity="0.9" />
      <path d="M18.6 18.6L16.9 16.9" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
      <defs>
        <linearGradient id="sc-grad" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#c15f37" />
          <stop offset="1" stopColor="#dc7f4d" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function Logo({ size = 28, textClassName = "text-lg", className = "" }: { size?: number; textClassName?: string; className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <LogoMark size={size} />
      <span className={`font-semibold tracking-tight text-ink-50 ${textClassName}`}>{BRAND_NAME}</span>
    </div>
  );
}
