import type { ActivityOperation, ActivityState, ActivityStep, ActivityTask, TaskStatus } from '../shared/activity'
import { clip } from './events'
import type { AgentEvent, ChildLink, SessionView } from './types'

export type TurnView = Omit<SessionView, 'id' | 'agent' | 'kind'>

const MAX_TASKS = 8
const GENERIC_TITLES = new Set(['正在处理', '等待回复', '正在处理结果'])

/**
 * Fold normalized events into the latest turn. Tasks are tracked alongside
 * the turn but never change its state here; see `presentTasks`.
 */
export function reduceEvents(events: AgentEvent[]): TurnView {
  const reducer = createReducer()
  reducer.push(events)
  return reducer.snapshot()
}

/** Per-transcript state; old log text and consumed events need not stay in memory. */
export function createReducer() {
  const steps: ActivityStep[] = []
  const calls = new Map<string, ActivityStep>()
  const stepEvents = new Map<string, AgentEvent & { kind: 'tool' | 'approval' }>()
  const tasks = new Map<string, ActivityTask>()
  let stepSequence = 0
  let title = '正在处理'
  let detail: string | undefined
  let operation: ActivityOperation | undefined
  let taskDetail: string | undefined
  let state: ActivityState = 'thinking'
  let terminal = false
  let turn = 0
  let startedAt: number | undefined
  let endedAt: number | undefined

  function push(events: readonly AgentEvent[]): void {
    for (const event of events) {
      if (event.kind === 'user' || event.kind === 'turn_start') {
        turn += 1
        startedAt = event.at
        endedAt = undefined
      } else if (event.kind !== 'task_drop') {
        if (!turn) turn = 1
        startedAt ??= event.at
      }
      if (event.kind === 'turn_start') continue
      if (event.kind === 'task_start') {
        const existing = tasks.get(event.taskId)
        const taskStartedAt = existing?.status === 'active' ? existing.startedAt ?? event.at : event.at
        tasks.delete(event.taskId)
        tasks.set(event.taskId, {
          id: event.taskId,
          kind: event.task,
          label: clip(event.label, 80),
          status: 'active',
          ...(taskStartedAt !== undefined ? { startedAt: taskStartedAt } : {}),
          ...(event.detail ? { detail: clip(event.detail, 160) } : existing?.detail ? { detail: existing.detail } : {})
        })
        continue
      }
      if (event.kind === 'task_update') {
        const task = tasks.get(event.taskId)
        if (task) task.detail = clip(event.detail, 160)
        continue
      }
      if (event.kind === 'task_drop') {
        tasks.delete(event.taskId)
        continue
      }
      if (event.kind === 'task_end') {
        const targets = event.taskId === '*'
          ? [...tasks.values()].filter((task) => task.kind === 'agent')
          : [tasks.get(event.taskId)].filter((task) => !!task)
        for (const task of targets) {
          if (task.status !== 'active') continue
          if (terminal && state !== 'error') endedAt = event.at === undefined ? undefined : Math.max(endedAt ?? 0, event.at)
          task.status = event.status
          if (event.at !== undefined) task.endedAt = Math.max(task.startedAt ?? event.at, event.at)
          if (event.detail) task.detail = clip(event.detail, 160)
        }
        continue
      }
      if (event.kind === 'user') {
        steps.length = 0
        calls.clear()
        stepEvents.clear()
        // Background work keeps running across turns; finished work belongs to the old turn.
        for (const [id, task] of tasks) if (task.status !== 'active') tasks.delete(id)
        detail = clip(event.title, 160)
        taskDetail = detail
        operation = undefined
        state = 'waiting'
        title = '等待回复'
        terminal = false
        continue
      }
      if (event.kind === 'thinking' || event.kind === 'text') {
        if (steps.some((step) => step.status === 'waiting')) continue
        state = 'thinking'
        operation = undefined
        detail = taskDetail
        title = clip(event.title, 80)
        terminal = false
        endedAt = undefined
        continue
      }
      if (event.kind === 'tool' || event.kind === 'approval') {
        const waiting = event.kind === 'approval'
        state = waiting ? 'approval' : 'running'
        title = clip(event.title, 80)
        operation = event.operation
        detail = waiting ? event.reason || taskDetail : taskDetail
        const existing = event.callId ? calls.get(event.callId) : undefined
        const step: ActivityStep = existing ?? { id: `s${++stepSequence}`, label: title, status: 'active' }
        step.status = waiting ? 'waiting' : 'active'
        step.kind = operation?.kind
        if (!existing) steps.push(step)
        stepEvents.set(step.id, event)
        if (event.callId) calls.set(event.callId, step)
        const blocked = steps.find((item) => item.status === 'waiting')
        if (blocked) {
          const pending = stepEvents.get(blocked.id)!
          state = 'approval'
          title = blocked.label
          operation = pending.operation
          detail = pending.reason || taskDetail
        }
        terminal = false
        endedAt = undefined
        continue
      }
      if (event.kind === 'tool_result') {
        let open = event.callId ? calls.get(event.callId) : undefined
        if (!event.callId) {
          for (let index = steps.length - 1; index >= 0; index -= 1) {
            if (steps[index].status === 'active' || steps[index].status === 'waiting') { open = steps[index]; break }
          }
        }
        if (open) open.status = event.ok === false ? 'error' : 'done'
        if (event.callId) calls.delete(event.callId)
        if (event.ok === false) {
          state = 'error'
          title = '工具执行失败'
          terminal = true
          endedAt ??= event.at
        } else if (state !== 'error') {
          state = steps.some((step) => step.status === 'waiting') ? 'approval' : steps.some((step) => step.status === 'active') ? 'running' : 'thinking'
          const pending = steps.find((step) => step.status === 'waiting') || steps.find((step) => step.status === 'active')
          if (pending) {
            const pendingEvent = stepEvents.get(pending.id)
            title = pending.label
            operation = pendingEvent?.operation
            detail = state === 'approval' ? pendingEvent?.reason || taskDetail : taskDetail
          } else detail = taskDetail
          if (state === 'thinking') { title = '正在处理结果'; operation = undefined }
          terminal = false
          endedAt = undefined
        }
        continue
      }
      if (event.kind === 'done') {
        state = 'success'
        title = event.title && event.title !== '已完成' ? clip(event.title, 80) : title === '等待回复' ? '已完成' : clip(title, 80)
        for (const step of steps) if (step.status === 'active' || step.status === 'waiting') step.status = 'done'
        operation = undefined
        detail = taskDetail
        terminal = true
        endedAt ??= event.at
        continue
      }
      state = 'error'
      title = clip(event.title, 80)
      for (const step of steps) if (step.status === 'active' || step.status === 'waiting') step.status = 'error'
      terminal = true
      endedAt ??= event.at
    }
    // Retain unresolved steps, but do not accumulate every completed call in a long turn.
    const recent = new Set(steps.slice(-4))
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index]
      if (step.status === 'active' || step.status === 'waiting' || recent.has(step)) continue
      steps.splice(index, 1)
      stepEvents.delete(step.id)
    }
    const settled = [...tasks.values()].filter((task) => task.status !== 'active')
    for (const task of settled.slice(0, Math.max(0, settled.length - MAX_TASKS))) tasks.delete(task.id)
  }

  function snapshot(): TurnView {
    return {
      state,
      title: state === 'success' && title === '等待回复' ? '已完成' : title,
      detail,
      operation,
      steps: steps.slice(-4).map((step) => ({ ...step })),
      tasks: capTasks([...tasks.values()]).map((task) => ({ ...task })),
      turn,
      startedAt,
      endedAt: terminal && (state === 'error' || ![...tasks.values()].some((task) => task.status === 'active')) ? endedAt : undefined,
      terminal
    }
  }
  return { push, snapshot }
}

export interface ChildSession {
  link: ChildLink
  view: SessionView
  /** False when neither the file nor the agent process shows recent life. */
  live: boolean
}

/** Overlay sub-agent transcripts onto the tasks their parent spawned. */
export function mergeChildTasks<T extends TurnView>(view: T, children: readonly ChildSession[]): T {
  if (!children.length) return view
  const tasks = view.tasks.map((task) => ({ ...task }))
  for (const child of children) {
    const childView = presentTasks(child.view)
    const status: TaskStatus | undefined = childView.terminal
      ? childView.state === 'error' ? 'error' : 'done'
      : child.live ? 'active' : undefined
    const detail = GENERIC_TITLES.has(childView.title) ? undefined : childView.title
    const existing = tasks.find((task) => task.id === child.link.taskId)
    if (childView.terminal && childView.endedAt !== undefined) {
      // A reused task can start before its child transcript has appended the new turn.
      if (existing?.startedAt !== undefined && existing.startedAt > childView.endedAt) continue
      // Child completion is overlaid, not written back into the parent's reducer.
      // Retire the old round here as well, so its cached "active" spawn cannot
      // bring an already finished child (and its alert) into every new user turn.
      if (view.startedAt !== undefined && childView.endedAt < view.startedAt) {
        if (existing) tasks.splice(tasks.indexOf(existing), 1)
        continue
      }
    }
    if (existing) {
      if (existing.startedAt === undefined && childView.startedAt !== undefined
        && (existing.endedAt === undefined || childView.startedAt <= existing.endedAt)) {
        existing.startedAt = childView.startedAt
      }
      if (existing.status !== 'active' && status === existing.status && existing.endedAt === undefined && childView.endedAt !== undefined) {
        existing.endedAt = Math.max(existing.startedAt ?? childView.endedAt, childView.endedAt)
      }
      // The parent's own completion notice is authoritative once it arrives.
      if (existing.status === 'active') {
        existing.state = childView.state
        if (status && status !== 'active') {
          existing.status = status
          if (childView.endedAt !== undefined) existing.endedAt = Math.max(existing.startedAt ?? childView.endedAt, childView.endedAt)
        }
        if (detail) existing.detail = clip(detail, 160)
      } else if (!existing.detail && detail) existing.detail = clip(detail, 160)
      continue
    }
    if (status !== 'active') continue
    tasks.push({ id: child.link.taskId, kind: 'agent', label: clip(child.link.label, 80), status, state: childView.state,
      ...(detail ? { detail: clip(detail, 160) } : {}), ...(childView.startedAt !== undefined ? { startedAt: childView.startedAt } : {}) })
  }
  const ends = [view.endedAt, ...children.map((child) => child.view.endedAt)].filter((at): at is number => at !== undefined)
  return { ...view, tasks: capTasks(tasks), endedAt: view.terminal && view.state !== 'error' && ends.length ? Math.max(...ends) : view.endedAt }
}

/**
 * A turn that finished while sub-agents or background commands still run is
 * not done from the user's point of view: keep the island in a running state.
 */
export function presentTasks<T extends TurnView>(view: T): T {
  if (view.state !== 'success') return view
  const active = view.tasks.filter((task) => task.status === 'active')
  if (!active.length) return view
  return { ...view, state: 'running', title: backgroundTitle(active), operation: undefined, terminal: false, endedAt: undefined }
}

/** Forget active tasks with no sign of life, e.g. a background job killed without a record. */
export function dropActiveTasks<T extends TurnView>(view: T, keep: ReadonlySet<string>): T {
  const tasks = view.tasks.filter((task) => task.status !== 'active' || keep.has(task.id))
  return tasks.length === view.tasks.length ? view : { ...view, tasks }
}

function backgroundTitle(active: readonly ActivityTask[]): string {
  const agents = active.filter((task) => task.kind === 'agent').length
  const commands = active.length - agents
  if (agents && commands) return `${active.length} 个后台任务进行中`
  if (agents) return agents === 1 ? `子 Agent ${active[0].label} 进行中` : `${agents} 个子 Agent 进行中`
  return commands === 1 ? '后台命令运行中' : `${commands} 个后台命令运行中`
}

/** Keep every running task, then the most recently settled ones. */
function capTasks(tasks: ActivityTask[]): ActivityTask[] {
  if (tasks.length <= MAX_TASKS) return tasks
  const active = tasks.filter((task) => task.status === 'active')
  const settled = tasks.filter((task) => task.status !== 'active')
  const room = Math.max(0, MAX_TASKS - active.length)
  const keep = new Set([...active.slice(-MAX_TASKS), ...(room ? settled.slice(-room) : [])])
  return tasks.filter((task) => keep.has(task))
}
