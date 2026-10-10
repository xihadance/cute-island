import { useEffect, useState } from 'react'
import type { Activity } from '../../shared/activity'
import { formatExecutionTime } from '../../shared/execution-time'

export function ExecutionTime({ activity, compact = false }: { activity: Activity; compact?: boolean }) {
  const { startedAt, endedAt } = activity
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    setNow(Date.now())
    if (endedAt !== undefined) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt, endedAt])
  const elapsed = formatExecutionTime((endedAt ?? now) - startedAt)
  return (
    <span className={`execution-time${compact ? ' execution-time-compact' : ''}`} data-testid="execution-time"
      aria-label={`执行时间 ${elapsed}`} title={`本轮开始：${new Date(startedAt).toLocaleString()}${endedAt === undefined ? '' : '\n本轮已结束'}`}>
      {compact ? <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 4v4l2.5 1.5" /></svg> : <span className="execution-time-label">执行时间</span>}
      <span data-testid="execution-duration">{elapsed}</span>
    </span>
  )
}
