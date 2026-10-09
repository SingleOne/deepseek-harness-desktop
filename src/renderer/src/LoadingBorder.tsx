import type { CSSProperties } from 'react'

interface LoadingBorderProps {
  active: boolean
  className?: string
  color?: string
  durationMs?: number
  radius?: number
}

// Place inside a positioned container and match radius to its rounded corners.
export function LoadingBorder({
  active,
  className = '',
  color = '#83adff',
  durationMs = 2600,
  radius = 0
}: LoadingBorderProps) {
  if (!active) return null

  return (
    <span
      className={`loading-border ${className}`}
      aria-hidden="true"
      style={
        {
          '--loading-border-color': color,
          '--loading-border-duration': `${durationMs}ms`
        } as CSSProperties
      }
    >
      <svg className="loading-border-svg" width="100%" height="100%">
        <rect className="loading-border-track" rx={radius} pathLength={100} />
        <rect className="loading-border-glow loading-border-segment" rx={radius} pathLength={100} />
        <rect className="loading-border-line loading-border-segment" rx={radius} pathLength={100} />
        <rect className="loading-border-head loading-border-segment" rx={radius} pathLength={100} />
      </svg>
    </span>
  )
}
