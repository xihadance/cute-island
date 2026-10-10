import { useEffect, useState } from 'react'
import type { ActivityTask } from '../../shared/activity'
import { formatExecutionTime } from '../../shared/execution-time'

export function TaskExecutionTime({ task }: { task: ActivityTask }) {
  const { startedAt, endedAt, status } = task
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    setNow(Date.now())
    if (startedAt === undefined || endedAt !== undefined || status !== 'active') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt, endedAt, status])
  const end = endedAt ?? (status === 'active' ? now : undefined)
  const elapsed = startedAt !== undefined && end !== undefined ? formatExecutionTime(end - startedAt) : undefined
  const missing = startedAt === undefined ? '日志未记录任务开始时间' : '任务已结束，日志未记录结束时间'
  return (
    <span className="task-time" data-testid="task-execution-time" aria-label={`执行时间 ${elapsed ?? '未知'}`}
      title={elapsed ? `任务开始：${new Date(startedAt!).toLocaleString()}${status === 'active' ? '' : '\n任务已结束'}` : missing}>
      <span className="task-time-label">执行时间</span>
      <span data-testid="task-execution-duration">{elapsed ?? '未记录'}</span>
    </span>
  )
}
