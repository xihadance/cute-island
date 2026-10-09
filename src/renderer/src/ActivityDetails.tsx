import { OPERATION_LABEL, STATE_LABEL, type Activity } from '../../shared/activity'
import { ActivityIcon } from './activity-icons'

export function Status({ activity, compact = false }: { activity: Activity; compact?: boolean }) {
  const kind = activity.state === 'running' ? activity.operation?.kind ?? 'running' : activity.state
  const label = compact && activity.state === 'running' && activity.operation ? OPERATION_LABEL[activity.operation.kind] : STATE_LABEL[activity.state]
  return (
    <span className={`activity-status state-${activity.state}${compact ? ' status-compact' : ''}`} title={`${STATE_LABEL[activity.state]}${activity.operation ? ` · ${OPERATION_LABEL[activity.operation.kind]}` : ''}`}>
      <ActivityIcon kind={kind} animated={activity.state === 'running' || activity.state === 'thinking' || activity.state === 'success'} />
      <span>{label}</span>
    </span>
  )
}

export function OperationDetails({ activity }: { activity: Activity }) {
  const operation = activity.operation
  return (
    <>
      {activity.state === 'approval' && (
        <div className="approval-notice" data-testid="approval-notice">
          <ActivityIcon kind="approval" />
          <div><strong>需要审批</strong><span>请在 {activity.agent} 中查看并审批</span></div>
        </div>
      )}
      {operation && (
        <div className={`operation-detail operation-${operation.kind}`} data-testid="operation-detail" onClick={(event) => event.stopPropagation()}>
          <div className="operation-heading">
            <ActivityIcon kind={operation.kind} animated={activity.state === 'running'} />
            <span>{OPERATION_LABEL[operation.kind]}</span>
            <span className="operation-name" title={operation.name}>{operation.shell || (operation.kind === 'command' ? 'Shell' : operation.name)}</span>
          </div>
          {operation.command && <pre className="command-code" tabIndex={0} aria-label="执行命令"><code>{operation.command}</code></pre>}
          {operation.cwd && <div className="command-cwd" title={operation.cwd}><span>目录</span><span>{operation.cwd}</span></div>}
        </div>
      )}
    </>
  )
}

export function Steps({ activity }: { activity: Activity }) {
  if (!activity.steps.length) return null
  return (
    <ol className="steps" aria-label="最近步骤">
      {activity.steps.slice(-4).map((step) => (
        <li key={step.id} data-status={step.status}>
          <ActivityIcon kind={step.status === 'active' ? step.kind ?? 'active' : step.status === 'waiting' ? 'approval' : step.status} animated={step.status === 'active'} />
          <span className="step-label" title={step.label}>{step.label}</span>
          <span className="sr-only">{({ active: '执行中', pending: '未开始', waiting: '需要审批', done: '已完成', error: '失败' })[step.status]}</span>
        </li>
      ))}
    </ol>
  )
}
