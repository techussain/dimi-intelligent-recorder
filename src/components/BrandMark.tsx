import { useId } from 'react'

/**
 * The Dimi Intelligent Recorder logo mark: a teal squircle with a "D" that
 * holds a record dot, plus a spark. Same geometry as build/icon.svg.
 * Decorative by default; pass `title` when it is the only label.
 */
export function BrandMark({ size = 20, title }: { size?: number; title?: string }) {
  const id = useId()
  const g = `bm-g-${id}`
  const h = `bm-h-${id}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className="shrink-0"
    >
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#14928E" />
          <stop offset="0.55" stopColor="#0A6B6B" />
          <stop offset="1" stopColor="#064A4A" />
        </linearGradient>
        <radialGradient id={h} cx="0.5" cy="0" r="0.75">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1024" height="1024" rx="232" fill={`url(#${g})`} />
      <rect width="1024" height="1024" rx="232" fill={`url(#${h})`} />
      <path
        d="M494 302 H304 V766 H494 A232 232 0 0 0 494 302 Z"
        fill="none"
        stroke="#fff"
        strokeWidth="88"
        strokeLinejoin="round"
      />
      <circle cx="512" cy="534" r="84" fill="#fff" />
      <path
        d="M774 146 C774 190 842 258 886 258 C842 258 774 326 774 370 C774 326 706 258 662 258 C706 258 774 190 774 146 Z"
        fill="#fff"
      />
      <path
        d="M880 336 C880 354 908 382 926 382 C908 382 880 410 880 428 C880 410 852 382 834 382 C852 382 880 354 880 336 Z"
        fill="#fff"
        fillOpacity="0.86"
      />
    </svg>
  )
}
