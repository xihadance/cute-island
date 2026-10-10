import { MAX_VISIBLE_TASKS, OPERATION_LABEL, STATE_LABEL, TASK_STATUS_LABEL, type Activity, type ActivityTask } from '../../shared/activity'
import { ActivityIcon } from './activity-icons'
import { TaskExecutionTime } from './TaskExecutionTime'

/** Count of sub-agents and background commands still running, for compact rows. */
export function TaskBadge({ activity }: { activity: Activity }) {
  const active = activity.tasks?.filter((task) => task.status === 'active') ?? []
  if (!active.length) return null
  const agents = active.filter((task) => task.kind === 'agent').length
  const label = agents === active.length ? `${agents} 个子 Agent 运行中` : `${active.length} 个后台任务运行中`
  return (
    <span className="task-badge" title={label} aria-label={label} data-testid="task-badge">
      <ActivityIcon kind={agents ? 'agent' : 'command'} />
      <span aria-hidden="true">{active.length}</span>
    </span>
  )
}

export function Tasks({ activity }: { activity: Activity }) {
  const tasks = activity.tasks ?? []
  if (!tasks.length) return null
  // Keep actionable children visible even when there are many running tasks.
  const visible = [
    ...tasks.filter(task => task.status === 'active' && task.state === 'approval'),
    ...tasks.filter(task => task.status === 'error').reverse(),
    ...tasks.filter(task => task.status === 'active' && task.state !== 'approval'),
    ...tasks.filter(task => task.status === 'done' || task.status === 'stopped').reverse()
  ]
    .slice(0, MAX_VISIBLE_TASKS)
  const active = tasks.filter((task) => task.status === 'active').length
  return (
    <section className="tasks" aria-label="子 Agent 与后台任务" data-testid="tasks">
      <div className="tasks-heading">
        <span>子 Agent 与后台任务</span>
        <span>{active ? `${active} 个进行中` : '全部结束'}{tasks.length > visible.length ? ` · 共 ${tasks.length} 个` : ''}</span>
      </div>
      <ul>
        {visible.map((task) => <TaskRow key={task.id} task={task} />)}
      </ul>
    </section>
  )
}

function TaskRow({ task }: { task: ActivityTask }) {
  const state = task.status === 'active' ? task.state : undefined
  const icon = task.status === 'active' ? state ?? task.kind : task.status
  return (
    <li data-task={task.id} data-status={task.status} data-state={state} data-kind={task.kind} title={task.detail ? `${task.label}\n${task.detail}` : task.label}>
      <ActivityIcon kind={icon} animated={task.status === 'active' && state !== 'approval' && state !== 'waiting'} />
      <span className="task-copy">
        <span className="task-label">{task.label}</span>
        {task.detail && <span className="task-detail">{task.detail}</span>}
      </span>
      <span className="task-meta">
        <span className="task-state" data-testid="task-status">{state ? STATE_LABEL[state] : TASK_STATUS_LABEL[task.status]}</span>
        <TaskExecutionTime task={task} />
      </span>
      <span className="sr-only">{task.kind === 'agent' ? '子 Agent' : '后台命令'}</span>
    </li>
  )
}

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

export function OperationDetails({ activity, showApprovalNotice = true }: { activity: Activity; showApprovalNotice?: boolean }) {
  const operation = activity.operation
  return (
    <>
      {activity.state === 'approval' && showApprovalNotice && (
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
