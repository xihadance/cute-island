import { useEffect, useState } from 'react'
import { AnimatePresence, motion, type Transition } from 'framer-motion'
import { STATE_LABEL, expandedHeight, type Activity, type ActivityState } from '../../shared/activity'
import { agentAppearance } from './agent-appearance'

interface IslandProps {
  activity?: Activity
  others: Activity[]
  expanded: boolean
  resting: boolean
  onToggle: () => void
  onDismiss: () => void
}

const SPRING: Transition = { type: 'spring', stiffness: 520, damping: 38, mass: 0.72 }

export function Island({ activity, others, expanded, resting, onToggle, onDismiss }: IslandProps) {
  const reduced = useReducedMotion()
  const mode = !activity ? (resting ? 'rest' : 'idle') : expanded ? 'expanded' : 'compact'
  const metrics = metricsFor(mode, activity, others.length)
  const contentKey = activity ? `${mode}:${activity.agent}:${activity.state}` : mode

  return (
    <motion.div
      tabIndex={0}
      data-testid="island"
      data-mode={mode}
      data-state={activity?.state ?? 'idle'}
      data-agent={activity ? agentAppearance(activity.agent).key : 'idle'}
      className={`island ${activity ? `island-${activity.state}` : 'island-idle'}`}
      aria-expanded={expanded}
      aria-label={activity ? `${activity.agent} ${activity.title}` : '灵动岛'}
      initial={{ width: 86, height: 10, borderRadius: 5, opacity: 0 }}
      animate={{
        width: metrics.width,
        height: metrics.height,
        borderRadius: metrics.radius,
        opacity: mode === 'rest' ? 0.45 : 1
      }}
      transition={reduced ? { duration: 0.01 } : SPRING}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onToggle()
      }}
    >
      <AnimatePresence initial={false}>
        <motion.div
          key={contentKey}
          className="island-content"
          initial={reduced ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? undefined : { opacity: 0, y: -4 }}
          transition={{ duration: reduced ? 0.01 : 0.16 }}
        >
          {mode === 'expanded' && activity && (
            <Expanded activity={activity} others={others} onDismiss={onDismiss} />
          )}
          {mode === 'compact' && activity && <Compact activity={activity} others={others} />}
          {mode === 'idle' && <span className="idle-mark" />}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  )
}

function Compact({ activity, others }: { activity: Activity; others: Activity[] }) {
  const appearance = agentAppearance(activity.agent)
  const extra = others.slice(0, 3)
  return (
    <div className="compact">
      <AgentBadge agent={activity.agent} state={activity.state} />
      <span className="compact-agent" data-testid="island-agent" style={{ color: appearance.color }}>
        {appearance.short}
      </span>
      <span className="compact-title" data-testid="island-title">
        {activity.title}
      </span>
      {extra.length > 0 && (
        <span className="compact-others">
          {extra.map((item) => (
            <AgentBadge key={item.id} agent={item.agent} state={item.state} />
          ))}
          {others.length > extra.length && <span className="badge">+{others.length - extra.length}</span>}
        </span>
      )}
    </div>
  )
}

function Expanded({
  activity,
  others,
  onDismiss
}: {
  activity: Activity
  others: Activity[]
  onDismiss: () => void
}) {
  const elapsed = useElapsed(activity.startedAt)
  const steps = activity.steps.slice(-4)
  const appearance = agentAppearance(activity.agent)
  return (
    <div className="expanded">
      <div className="expanded-head">
        <AgentBadge agent={activity.agent} state={activity.state} />
        <div className="head-copy">
          <div className="agent" style={{ color: appearance.color }}>
            {appearance.label}
          </div>
          <div className="state-label">{STATE_LABEL[activity.state]}</div>
        </div>
        <div className="elapsed">{elapsed}</div>
        {activity.state === 'error' && (
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
      <div className="expanded-title" data-testid="island-title">
        {activity.title}
      </div>
      {activity.detail && (
        <div className="detail" data-testid="island-detail">
          {activity.detail}
        </div>
      )}
      {typeof activity.progress === 'number' && <Progress value={activity.progress} />}
      {steps.length > 0 && (
        <ol className="steps">
          {steps.map((step) => (
            <li key={step.id} data-status={step.status}>
              {step.label}
            </li>
          ))}
        </ol>
      )}
      {others.length > 0 && (
        <div className="others" data-testid="other-count">
          <div className="others-label">另外 {others.length} 个活动</div>
          {others.slice(0, 3).map((item) => {
            const appearance = agentAppearance(item.agent)
            return (
              <div key={item.id} className="other-row" data-agent={appearance.key}>
                <AgentBadge agent={item.agent} state={item.state} />
                <span className="other-agent" style={{ color: appearance.color }}>
                  {appearance.short}
                </span>
                <span className="other-title">{item.title}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Progress({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  return (
    <div className="progress">
      <div className="track">
        <div className="bar" style={{ width: `${pct}%` }} />
      </div>
      <span>{pct}%</span>
    </div>
  )
}

function AgentBadge({ agent, state }: { agent: string; state: ActivityState }) {
  const appearance = agentAppearance(agent)
  return (
    <span
      className={`agent-badge badge-${state} agent-${appearance.key}`}
      style={{ background: appearance.color }}
      title={appearance.label}
      aria-hidden="true"
    >
      {appearance.mark}
    </span>
  )
}

function metricsFor(
  mode: 'rest' | 'idle' | 'compact' | 'expanded',
  activity: Activity | undefined,
  otherCount: number
): { width: number; height: number; radius: number } {
  if (mode === 'rest') return { width: 92, height: 12, radius: 6 }
  if (mode === 'idle') return { width: 126, height: 36, radius: 18 }
  if (mode === 'compact') return { width: otherCount > 0 ? 390 : 340, height: 40, radius: 20 }
  return {
    width: 380,
    height: activity ? expandedHeight(activity, otherCount) : 168,
    radius: 40
  }
}

function useElapsed(startedAt: number): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return formatElapsed(now - startedAt)
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
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
