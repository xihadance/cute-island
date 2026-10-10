import { safeId } from './events'
import { BUILTIN_PLUGINS, pluginFor } from './plugins'
import { presentTasks, reduceEvents } from './reduce'
import type { AgentKind, AgentPlugin, SessionView } from './types'

export type { AgentKind, SessionView } from './types'

export const AGENT_LABEL = Object.fromEntries(BUILTIN_PLUGINS.map((plugin) => [plugin.kind, plugin.label])) as Record<AgentKind, string>

/** The turn as recorded, before background tasks or sub-agent transcripts are applied. */
export function parseSession(plugin: AgentPlugin, sessionId: string, text: string): SessionView | null {
  const parsed = plugin.parse(text)
  if (parsed.events.length === 0) return null
  return {
    id: activityId(plugin.kind, parsed.sessionId || sessionId),
    sessionId: parsed.sessionId || sessionId,
    client: parsed.client,
    agent: plugin.label,
    kind: plugin.kind,
    ...reduceEvents(parsed.events)
  }
}

export function parseTranscript(kind: string, sessionId: string, text: string): SessionView | null {
  const plugin = pluginFor(kind)
  const view = plugin ? parseSession(plugin, sessionId, text) : null
  return view && presentTasks(view)
}

export function activityId(kind: string, sessionId: string): string {
  return `${kind}-${safeId(sessionId) || 'session'}`.slice(0, 80)
}
