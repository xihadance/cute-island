import type { AgentPlugin } from '../types'
import { claudePlugin } from './claude'
import { codexPlugin } from './codex'
import { cursorPlugin } from './cursor'
import { geminiPlugin } from './gemini'

/**
 * Built-in watchers. Adding an agent means writing one `AgentPlugin` and
 * listing it here, or passing a custom list to `SessionWatcher`.
 */
export const BUILTIN_PLUGINS: readonly AgentPlugin[] = [claudePlugin, codexPlugin, geminiPlugin, cursorPlugin]

export function pluginFor(kind: string, plugins: readonly AgentPlugin[] = BUILTIN_PLUGINS): AgentPlugin | undefined {
  return plugins.find((plugin) => plugin.kind === kind)
}

export { claudePlugin, codexPlugin, cursorPlugin, geminiPlugin }
