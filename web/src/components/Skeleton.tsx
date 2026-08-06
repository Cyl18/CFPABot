import type { ReactNode } from 'react'

// ── Base ──────────────────────────────────────────────

interface SkeletonBlockProps {
  className?: string
  /** Pulse animation on/off (default true) */
  animate?: boolean
}

/** A generic pulsing rounded block — the atomic unit of all skeleton variants */
function SkeletonBlock({ className = '', animate = true }: SkeletonBlockProps) {
  return (
    <div
      className={`${animate ? 'animate-pulse' : ''} bg-slate-200 dark:bg-slate-700 rounded ${className}`}
    />
  )
}

// ── Stat card ─────────────────────────────────────────

interface SkeletonStatCardProps {
  className?: string
}

/** Mimics a stat card: label line + value line + icon square on the right */
function SkeletonStatCard({ className = '' }: SkeletonStatCardProps) {
  return (
    <div className={`card p-5 ${className}`}>
      <div className="flex items-center justify-between">
        <div className="space-y-3 flex-1 min-w-0">
          <SkeletonBlock className="h-4 w-16" />
          <SkeletonBlock className="h-8 w-12" />
        </div>
        <SkeletonBlock className="h-10 w-10 rounded-lg ml-4 shrink-0" />
      </div>
    </div>
  )
}

// ── Activity feed ─────────────────────────────────────

interface SkeletonActivityFeedProps {
  items?: number
  className?: string
}

/** Multiple activity-item placeholders: icon + text + time */
function SkeletonActivityFeed({ items = 5, className = '' }: SkeletonActivityFeedProps) {
  return (
    <div className={`${className}`}>
      {Array.from({ length: items }).map((_, i) => (
        <div key={i} className="activity-item !border-slate-100 dark:!border-slate-700/20">
          <SkeletonBlock className="h-4 w-4 shrink-0 mt-0.5 rounded" />
          <div className="flex-1 min-w-0 space-y-1.5">
            <SkeletonBlock className="h-3.5 w-full max-w-md" />
            <SkeletonBlock className="h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Table ─────────────────────────────────────────────

interface SkeletonTableRowsProps {
  rows?: number
  cols?: number
  /** Approximate widths per column for visual variety */
  colWidths?: string[]
  className?: string
}

/** Table-body skeleton: header row + data rows with consistent column widths */
function SkeletonTableRows({ rows = 5, cols = 5, colWidths, className = '' }: SkeletonTableRowsProps) {
  const widths = colWidths ?? ['w-16', 'w-48', 'w-20', 'w-16', 'w-24']

  return (
    <div className={className}>
      {/* header */}
      <div className="flex items-center gap-4 px-4 py-3 border-b border-slate-200 dark:border-slate-700">
        {Array.from({ length: cols }).map((_, c) => (
          <SkeletonBlock key={`h-${c}`} className={`h-3 ${widths[c % widths.length]}`} />
        ))}
      </div>
      {/* rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex items-center gap-4 px-4 py-3.5 border-b border-slate-50 dark:border-slate-700/40"
        >
          {Array.from({ length: cols }).map((_, c) => (
            <SkeletonBlock key={`r${r}-${c}`} className={`h-4 ${widths[c % widths.length]}`} />
          ))}
        </div>
      ))}
    </div>
  )
}

// ── Card wrapper ──────────────────────────────────────

interface SkeletonCardProps {
  children?: ReactNode
  className?: string
}

/** A card-shaped container for composing custom skeleton layouts */
function SkeletonCard({ children, className = '' }: SkeletonCardProps) {
  return <div className={`card p-6 ${className}`}>{children}</div>
}

// ── Named export + default export ─────────────────────

export {
  SkeletonBlock,
  SkeletonStatCard,
  SkeletonActivityFeed,
  SkeletonTableRows,
  SkeletonCard,
}

export type {
  SkeletonBlockProps,
  SkeletonStatCardProps,
  SkeletonActivityFeedProps,
  SkeletonTableRowsProps,
  SkeletonCardProps,
}

const Skeleton = {
  Block: SkeletonBlock,
  StatCard: SkeletonStatCard,
  ActivityFeed: SkeletonActivityFeed,
  TableRows: SkeletonTableRows,
  Card: SkeletonCard,
}

export default Skeleton
