import type { Activity } from './activity'

export type IslandMode = 'focus' | 'managed'
export interface IslandBehavior { mode: IslandMode; attentionIds: string[] }
export type AttentionKind = 'approval' | 'input' | 'error' | 'task-error' | 'task-approval'

export function isIslandMode(value: unknown): value is IslandMode {
  return value === 'focus' || value === 'managed'
}

export function isUserInputTool(name: string | undefined): boolean {
  const tool = name?.split(/[.:]/).pop()?.toLowerCase()
  return !!tool && ['askuserquestion', 'ask_user', 'request_user_input', 'request_user_input_async'].includes(tool)
}

export function attentionKind(activity: Activity): AttentionKind | undefined {
  if (activity.state === 'error') return 'error'
  if (activity.state === 'approval') return 'approval'
  // "waiting" also means waiting for an agent's response. Only recorded requests
  // for human input count, not elapsed time or natural-language guesses.
  if ((activity.state === 'running' || activity.state === 'waiting') && activity.operation?.kind === 'tool' &&
      isUserInputTool(activity.operation.name)) return 'input'
  if (activity.tasks?.some(task => task.status === 'active' && task.state === 'approval')) return 'task-approval'
  if (activity.tasks?.some(task => task.status === 'error')) return 'task-error'
  return undefined
}

function attentionKeys(activity: Activity): string[] {
  const kind = attentionKind(activity)
  if (!kind) return []
  if (kind === 'task-approval') return (activity.tasks ?? []).filter(task => task.status === 'active' && task.state === 'approval')
    .map(task => JSON.stringify([activity.startedAt, kind, task.id, task.startedAt, task.detail]))
  if (kind === 'task-error') return (activity.tasks ?? []).filter(task => task.status === 'error')
    .map(task => JSON.stringify([activity.startedAt, kind, task.id]))
  const issue = [activity.operation, activity.steps.filter(step => step.status === 'waiting' || step.status === 'error' ||
    (kind === 'input' && step.status === 'active')).map(step => step.id), kind === 'error' ? activity.title : null]
  return [JSON.stringify([activity.startedAt, kind, issue])]
}

/** Acknowledgments last for this occurrence; metadata refreshes never reopen it. */
export class AttentionTracker {
  private current = new Map<string, string[]>()
  private acknowledged = new Map<string, Set<string>>()

  update(activities: readonly Activity[]): void {
    this.current = new Map(activities.flatMap(activity => {
      const keys = attentionKeys(activity)
      return keys.length ? [[activity.id, keys] as const] : []
    }))
    for (const [id, keys] of this.acknowledged) {
      const live = this.current.get(id) ?? []
      for (const key of keys) if (!live.includes(key)) keys.delete(key)
      if (!keys.size) this.acknowledged.delete(id)
    }
  }

  acknowledge(id: string): void {
    const keys = this.current.get(id)
    if (keys) this.acknowledged.set(id, new Set(keys))
  }

  pendingIds(): string[] {
    return [...this.current].filter(([id, keys]) => keys.some(key => !this.acknowledged.get(id)?.has(key))).map(([id]) => id)
  }
}

export function managedAttention(behavior: IslandBehavior): boolean {
  return behavior.mode === 'managed' && behavior.attentionIds.length > 0
}

export function isPassive(behavior: IslandBehavior): boolean {
  return behavior.mode === 'managed' && !managedAttention(behavior)
}

/** Managed alerts capture only their visible surface; the rest of the desktop stays usable. */
export function shouldIgnoreMouse(behavior: IslandBehavior, overIsland: boolean, expanded: boolean, dragging: boolean): boolean {
  if (behavior.mode === 'managed') return isPassive(behavior) || (!dragging && !overIsland)
  return !dragging && !expanded && !overIsland
}
