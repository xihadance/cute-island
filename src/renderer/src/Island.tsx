import { useEffect, useId, useState } from 'react'
import { AnimatePresence, motion, type Transition } from 'framer-motion'
import { expandedHeight, operationHeight, priorityRank, tasksHeight, type Activity, type ActivityState } from '../../shared/activity'
import { agentAppearance } from './agent-appearance'
import { ClaudeIcon, CodexIcon, CursorIcon, GeminiIcon } from './agent-icons'
import { OperationDetails, Status, Steps, TaskBadge, Tasks } from './ActivityDetails'
import { useIslandDrag } from './useIslandDrag'
import { ExecutionTime } from './ExecutionTime'
import { attentionKind, type IslandMode } from '../../shared/island-behavior'

interface IslandProps {
  drag: ReturnType<typeof useIslandDrag>
  behaviorMode: IslandMode
  passive: boolean
  attention: boolean
  onAcknowledge?: (id: string) => void
  hovered: boolean
  onHover: (value: boolean) => void
  activities: Activity[]
  expanded: boolean
  selectedId: string | null
  resting: boolean
  onToggle: () => void
  onSelect: (id: string | null) => void
  onDismiss: (id: string) => void
}

const SPRING: Transition = { type: 'spring', stiffness: 520, damping: 38, mass: 0.72 }

export function Island({ drag, behaviorMode, passive, attention, onAcknowledge, hovered, onHover, activities, expanded, selectedId, resting, onToggle, onSelect, onDismiss }: IslandProps) {
  const reduced = useReducedMotion()
  const [focused, setFocused] = useState(false)
  const collapsed = drag.dock.collapsed && !attention
  const solid = !passive && (attention || hovered || focused || drag.dragging || (!collapsed && (expanded || selectedId !== null)))
  const activity = activities[0]
  const stacked = activities.length > 1
  const mode = collapsed ? 'docked' : !activity ? (resting ? 'rest' : 'idle') : stacked ? 'stack' : expanded ? 'expanded' : 'compact'
  const vertical = drag.dock.edge === 'left' || drag.dock.edge === 'right'
  const baseMetrics = mode === 'docked' ? { width: vertical ? 16 : 72, height: vertical ? 72 : 16, radius: 8 } : metricsFor(mode, activity, activities, selectedId)
  const openActivity = activities.find(item => item.id === selectedId) ?? activity
  const attentionHeight = attention ? 64 - (openActivity?.state === 'approval' ? 70 : 0) : 0
  const metrics = { ...baseMetrics, height: Math.min(520, baseMetrics.height + attentionHeight) }
  const contentKey = collapsed ? 'docked' : stacked ? 'stack' : activity ? `${mode}:${activity.agent}:${activity.state}` : mode

  return (
    <motion.div
      tabIndex={passive || (stacked && !collapsed) ? -1 : 0}
      inert={passive}
      role={collapsed ? 'button' : undefined}
      data-testid="island"
      data-mode={mode}
      data-behavior={behaviorMode}
      data-passive={passive}
      data-attention={attention}
      data-attention-kind={attention && activity ? attentionKind(activity) : undefined}
      data-dock-edge={drag.dock.edge ?? undefined}
      data-state={activity?.state ?? 'idle'}
      data-agent={activity ? agentAppearance(activity.agent).key : 'idle'}
      data-solid={solid}
      data-dragging={drag.dragging}
      style={{ left: drag.offset.x, top: drag.offset.y }}
      onPointerDownCapture={drag.onPointerDownCapture}
      onClickCapture={drag.onClickCapture}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
      className={`island ${activity ? `island-${activity.state}` : 'island-idle'}`}
      aria-expanded={collapsed ? false : stacked ? selectedId !== null : expanded}
      title={collapsed ? '点击展开灵动岛，拖离边缘取消收纳' : undefined}
      aria-label={
        collapsed ? '展开灵动岛' : stacked
          ? activities.map((item) => `${item.agent}，${item.client ?? '未知客户端'}，${item.title}`).join('，')
          : activity
            ? `${activity.agent}，${activity.client ?? '未知客户端'}，${activity.title}`
            : '灵动岛'
      }
      initial={{ width: 86, height: 10, borderRadius: 5, opacity: 0 }}
      animate={{
        width: metrics.width,
        height: metrics.height,
        borderRadius: metrics.radius,
        opacity: passive ? (mode === 'rest' ? 0.16 : 0.28) : solid ? 1 : mode === 'rest' ? 0.35 : 0.64
      }}
      transition={{ ...(reduced ? { duration: 0.01 } : SPRING), opacity: { duration: reduced ? 0.01 : 0.18 } }}
      onClick={() => {
        if (behaviorMode === 'managed') return
        if (drag.dock.edge) { onToggle(); return }
        if (stacked) {
          onSelect(null)
          return
        }
        onToggle()
      }}
      onKeyDown={(event) => {
        if (passive) return
        if (attention && event.key === 'Escape') {
          event.preventDefault()
          onAcknowledge?.(selectedId ?? activity.id)
          return
        }
        if (event.key === 'Escape' && drag.dock.edge) {
          event.preventDefault()
          drag.setDockExpanded(false)
          event.currentTarget.focus()
          return
        }
        if (event.target !== event.currentTarget || (stacked && !collapsed)) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onToggle()
      }}
    >
      {collapsed ? <span className="dock-mark" aria-hidden="true" /> : <AnimatePresence key={`${behaviorMode}:${attention}`} initial={false}>
        <motion.div
          key={contentKey}
          className="island-content"
          initial={reduced ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? undefined : { opacity: 0, y: -4 }}
          transition={{ duration: reduced ? 0.01 : 0.16 }}
        >
          {mode === 'stack' && (
            <SessionStack
              activities={orderedSessions(activities)}
              selectedId={selectedId}
              onSelect={onSelect}
              onDismiss={onDismiss}
              onAcknowledge={onAcknowledge}
            />
          )}
          {mode === 'expanded' && activity && <Expanded activity={activity} onDismiss={() => onDismiss(activity.id)} onAcknowledge={onAcknowledge} />}
          {mode === 'compact' && activity && <Compact activity={activity} />}
          {mode === 'idle' && <span className="idle-mark" />}
        </motion.div>
      </AnimatePresence>}
    </motion.div>
  )
}

function Compact({ activity }: { activity: Activity }) {
  return (
    <div className="compact">
      <AgentBadge agent={activity.agent} state={activity.state} />
      <SessionIdentity activity={activity} />
      <span className="compact-title" data-testid="island-title">
        {activity.title}
      </span>
      <TaskBadge activity={activity} />
      <span className="session-status"><Status activity={activity} compact /><ExecutionTime activity={activity} compact /></span>
    </div>
  )
}

function ClientLabel({ client }: { client?: string }) {
  const label = client ?? '未知客户端'
  return <span className="client-label" data-testid="session-client" title={`来源客户端：${label}`}>{label}</span>
}

function SessionIdentity({ activity }: { activity: Activity }) {
  const appearance = agentAppearance(activity.agent)
  return (
    <span className="session-identity">
      <span className="compact-agent" data-testid="island-agent" style={{ color: appearance.color }}>{appearance.short}</span>
      <ClientLabel client={activity.client} />
    </span>
  )
}

function SessionStack({
  activities,
  selectedId,
  onSelect,
  onDismiss,
  onAcknowledge
}: {
  activities: Activity[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onDismiss: (id: string) => void
  onAcknowledge?: (id: string) => void
}) {
  return (
    <div className="session-stack" data-testid="session-stack">
      {activities.map((activity) => (
        <SessionRow
          key={activity.id}
          activity={activity}
          open={selectedId === activity.id}
          onSelect={() => onSelect(selectedId === activity.id ? null : activity.id)}
          onDismiss={() => onDismiss(activity.id)}
          onAcknowledge={onAcknowledge}
        />
      ))}
    </div>
  )
}

function SessionRow({
  activity,
  open,
  onSelect,
  onDismiss,
  onAcknowledge
}: {
  activity: Activity
  open: boolean
  onSelect: () => void
  onDismiss: () => void
  onAcknowledge?: (id: string) => void
}) {
  return (
    <div className={`session-row${open ? ' open' : ''}`} data-testid="session-row" data-session={activity.id} data-state={activity.state}>
      <button
        type="button"
        className="session-line"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          onSelect()
        }}
      >
        <AgentBadge agent={activity.agent} state={activity.state} />
        <SessionIdentity activity={activity} />
        <span className="compact-title">{activity.title}</span>
        <TaskBadge activity={activity} />
        <span className="session-status"><Status activity={activity} compact /><ExecutionTime activity={activity} compact /></span>
      </button>
      {open && (
        <div className="session-detail" onClick={(event) => event.stopPropagation()}>
          {onAcknowledge && <AttentionNotice activity={activity} onAcknowledge={onAcknowledge} />}
          {activity.detail && <div className="detail">{activity.detail}</div>}
          <OperationDetails activity={activity} showApprovalNotice={!onAcknowledge} />
          {typeof activity.progress === 'number' && <Progress value={activity.progress} />}
          <Steps activity={activity} />
          <Tasks activity={activity} />
          {activity.state === 'error' && !onAcknowledge && (
            <button
              type="button"
              className="close"
              onClick={(event) => {
                event.stopPropagation()
                onDismiss()
              }}
            >
              关闭
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Expanded({ activity, onDismiss, onAcknowledge }: { activity: Activity; onDismiss: () => void; onAcknowledge?: (id: string) => void }) {
  const appearance = agentAppearance(activity.agent)
  return (
    <div className="expanded">
      <div className="expanded-head">
        <AgentBadge agent={activity.agent} state={activity.state} />
        <div className="head-copy">
          <div className="agent-heading">
            <span className="agent" style={{ color: appearance.color }}>{appearance.label}</span>
            <ClientLabel client={activity.client} />
          </div>
          <Status activity={activity} />
        </div>
        <ExecutionTime activity={activity} />
        {activity.state === 'error' && !onAcknowledge && (
          <button
            type="button"
            className="close"
            data-testid="close-activity"
            onClick={(event) => {
              event.stopPropagation()
              onDismiss()
            }}
          >
            关闭
          </button>
        )}
      </div>
      {onAcknowledge && <AttentionNotice activity={activity} onAcknowledge={onAcknowledge} />}
      <div className="expanded-title" data-testid="island-title">
        {activity.title}
      </div>
      {activity.detail && (
        <div className="detail" data-testid="island-detail">
          {activity.detail}
        </div>
      )}
      <OperationDetails activity={activity} showApprovalNotice={!onAcknowledge} />
      {typeof activity.progress === 'number' && <Progress value={activity.progress} />}
      <Steps activity={activity} />
      <Tasks activity={activity} />
    </div>
  )
}

function AttentionNotice({ activity, onAcknowledge }: { activity: Activity; onAcknowledge: (id: string) => void }) {
  const kind = attentionKind(activity)
  const label = kind === 'approval' ? '需要审批' : kind === 'input' ? '需要你回复' : kind === 'task-approval' ? '子 Agent 需要审批' : kind === 'task-error' ? '后台任务异常' : '会话异常'
  return (
    <div className="managed-notice" data-testid="managed-notice" data-kind={kind}>
      <div><strong>{label}</strong><span>请在 {activity.agent} 中查看处理</span></div>
      <button type="button" className="close" data-testid="acknowledge-attention" onClick={(event) => {
        event.stopPropagation()
        onAcknowledge(activity.id)
      }}>知道了</button>
    </div>
  )
}

function orderedSessions(activities: Activity[]): Activity[] {
  return [...activities].sort((left, right) => {
    const byAgent = left.agent.localeCompare(right.agent, 'zh')
    if (byAgent !== 0) return byAgent
    const byRank = priorityRank(right.state) - priorityRank(left.state)
    if (byRank !== 0) return byRank
    return right.updatedAt - left.updatedAt
  })
}

function Progress({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  return (
    <div className="progress" role="progressbar" aria-label="任务进度" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="track">
        <div className="bar" style={{ width: `${pct}%` }} />
      </div>
      <span>{pct}%</span>
    </div>
  )
}

function AgentBadge({ agent, state }: { agent: string; state: ActivityState }) {
  const appearance = agentAppearance(agent)
  const gradientId = useId().replace(/:/g, '')
  return (
    <span className={`agent-badge badge-${state} agent-${appearance.key}`} title={appearance.label} aria-hidden="true">
      {appearance.key === 'claude' && <ClaudeIcon />}
      {appearance.key === 'codex' && <CodexIcon />}
      {appearance.key === 'gemini' && <GeminiIcon id={gradientId} />}
      {appearance.key === 'cursor' && <CursorIcon />}
      {appearance.key === 'custom' && appearance.mark}
    </span>
  )
}

function metricsFor(
  mode: 'rest' | 'idle' | 'compact' | 'expanded' | 'stack',
  activity: Activity | undefined,
  activities: Activity[],
  selectedId: string | null
): { width: number; height: number; radius: number } {
  if (mode === 'rest') return { width: 92, height: 12, radius: 6 }
  if (mode === 'idle') return { width: 126, height: 36, radius: 18 }
  if (mode === 'compact') return { width: 340, height: 40, radius: 20 }
  if (mode === 'stack') return { width: 400, height: stackHeight(activities, selectedId), radius: 28 }
  return {
    width: 380,
    height: activity ? expandedHeight(activity, 0) : 168,
    radius: 40
  }
}

function stackHeight(activities: Activity[], selectedId: string | null): number {
  let height = 20 + activities.length * 42
  const selected = activities.find((item) => item.id === selectedId)
  if (selected) {
    height += 8
    if (selected.detail) height += 24
    if (selected.operation) height += operationHeight(selected.operation)
    if (selected.state === 'approval') height += 70
    if (typeof selected.progress === 'number') height += 28
    if (selected.steps.length) height += 4 + Math.min(selected.steps.length, 4) * 26
    height += tasksHeight(selected.tasks)
    if (selected.state === 'error') height += 40
  }
  return Math.min(Math.max(height, 56), 520)
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (): void => setReduced(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return reduced
}
