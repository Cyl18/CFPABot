export function StatBadge({
  label,
  value,
  color,
}: {
  label: string
  value: number
  color: 'green' | 'yellow' | 'red' | 'slate'
}) {
  const colorClasses: Record<string, string> = {
    green: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
    yellow: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300',
    red: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
    slate: 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400',
  }

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${colorClasses[color] ?? colorClasses.slate}`}>
      <span className="text-xs font-medium">{label}</span>
      <span className="text-lg font-bold">{value}</span>
    </div>
  )
}
