export const BRAND_NAME = "Prospex";
export const BRAND_TAGLINE = "Lead intelligence for sales teams and AI agents";

/**
 * Logo mark: a signal/ping locking onto a target, rising along a growth
 * vector — prospecting read as "find the target, close the distance".
 */
export function LogoMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <rect width="28" height="28" rx="8" fill="url(#px-grad)" />
      <path d="M7.5 18.5L13 13L16.3 16.3L20.5 12.1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.55" />
      <path d="M16.5 12.1H20.5V16.1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.55" />
      <circle cx="20.5" cy="12.1" r="2.6" fill="white" />
      <circle cx="20.5" cy="12.1" r="5" stroke="white" strokeOpacity="0.5" strokeWidth="1.2" />
      <defs>
        <linearGradient id="px-grad" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7c5cfc" />
          <stop offset="1" stopColor="#22d3ee" />
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
