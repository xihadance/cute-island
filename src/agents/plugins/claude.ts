import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { cleanText, isRecord, jsonlRows, messageEvents, outputText, parseMaybeRecord, safeId, textOf } from '../events'
import type { AgentEvent, AgentPlugin, ChildLink, ParsedTranscript } from '../types'

/**
 * Claude Code: `~/.claude/projects/<project>/<session>.jsonl`.
 * Sub-agents write `<session>/subagents/agent-<id>.jsonl` with a `.meta.json` sidecar.
 * Background work is announced in tool results and settled by `<task-notification>` rows.
 */
export const claudePlugin: AgentPlugin = {
  kind: 'claude',
  label: 'Claude Code',
  defaultRoot: (home, env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'),
  skipDirs: ['node_modules', '.git'],
  accepts: (file) => file.endsWith('.jsonl'),
  sessionIdFrom: (file) => path.basename(file).replace(/\.jsonl$/, ''),
  parse: (text) => createClaudeParser()(text),
  createParser: createClaudeParser,
  executables: ['claude'],
  scripts: [/\/@anthropic-ai\/claude-code\//i],
  child: claudeChild,
  liveSessions: (root) => activeClaudeSessions(path.join(root, '..', 'sessions'))
}

const SPAWNED = new Set(['async_launched', 'teammate_spawned'])

function createClaudeParser(): (text: string) => ParsedTranscript {
  const titles = new Map<string, string>()
  const agentCalls = new Set<string>()
  /** Background task ids and agent ids, mapped to the tool_use id that started them. */
  const owners = new Map<string, string>()
  return (text) => {
    const events: AgentEvent[] = []
    for (const row of jsonlRows(text)) {
      if (!isRecord(row) || row.isMeta === true) continue
      const notice = notificationEvents(row, owners)
      if (notice) {
        events.push(...notice)
        continue
      }
      if (row.type === 'attachment' || row.type === 'queue-operation') continue
      const rowEvents = messageEvents(row).filter((event) => !(event.kind === 'user' && /^<system-reminder>/.test(event.title)))
      for (const event of rowEvents) {
        events.push(event)
        if ((event.kind === 'tool' || event.kind === 'approval') && event.callId) {
          titles.set(event.callId, event.title)
          if (event.operation?.kind === 'agent' && isSpawn(row, event.callId)) {
            agentCalls.add(event.callId)
            events.push({ kind: 'task_start', taskId: safeId(event.callId), task: 'agent', label: event.title })
          }
        }
      }
      events.push(...launchEvents(row, titles, agentCalls, owners))
      for (const event of rowEvents) {
        if (event.kind === 'tool_result' && event.callId) {
          titles.delete(event.callId)
          agentCalls.delete(event.callId)
        }
      }
    }
    return { events }
  }
}

/** Agent and Task tool calls spawn sub-agents; SendMessage and friends only talk to them. */
function isSpawn(row: Record<string, unknown>, callId: string): boolean {
  const message = isRecord(row.message) ? row.message : row
  const content = Array.isArray(message.content) ? message.content : []
  const block = content.find((item) => isRecord(item) && item.id === callId)
  return isRecord(block) && /^(agent|task)$/i.test(textOf(block.name))
}

/** Tool results that launch background work, or finish a foreground sub-agent. */
function launchEvents(row: Record<string, unknown>, titles: Map<string, string>, agentCalls: Set<string>, owners: Map<string, string>): AgentEvent[] {
  const result = row.toolUseResult
  if (!isRecord(result)) return []
  const message = isRecord(row.message) ? row.message : {}
  const content = Array.isArray(message.content) ? message.content : []
  const block = content.find((item) => isRecord(item) && item.type === 'tool_result')
  const callId = isRecord(block) ? textOf(block.tool_use_id) : ''
  if (!callId) return []
  const taskId = safeId(callId)
  const background = textOf(result.backgroundTaskId)
  if (background) {
    owners.set(background, taskId)
    return [{ kind: 'task_start', taskId, task: 'command', label: titles.get(callId) || '后台命令' }]
  }
  if (!agentCalls.has(callId)) return []
  const agentId = textOf(result.agentId) || textOf(result.agent_id)
  if (agentId) owners.set(agentId, taskId)
  const status = textOf(result.status)
  if (SPAWNED.has(status)) return []
  const failed = status === 'failed' || status === 'error' || (isRecord(block) && block.is_error === true)
  return [{ kind: 'task_end', taskId, status: failed ? 'error' : 'done', detail: cleanText(outputText(result.content)).slice(0, 160) || undefined }]
}

/** Notifications arrive as user rows, queue entries, or queued-command attachments. */
function notificationText(row: Record<string, unknown>): string | null {
  // Enqueue and remove both carry the notice; either proves the task ended.
  if (row.type === 'queue-operation') return textOf(row.content)
  if (row.type === 'attachment') {
    const attachment = isRecord(row.attachment) ? row.attachment : {}
    return attachment.type === 'queued_command' ? textOf(attachment.prompt) : null
  }
  if (row.type !== 'user') return null
  const message = isRecord(row.message) ? row.message : {}
  const text = typeof message.content === 'string' ? message.content : outputText(message.content)
  const origin = isRecord(row.origin) ? textOf(row.origin.kind) : ''
  return origin === 'task-notification' || /^\s*<task-notification>/.test(text) ? text : null
}

function notificationEvents(row: Record<string, unknown>, owners: Map<string, string>): AgentEvent[] | null {
  const text = notificationText(row)
  if (text === null) return null
  if (!/<task-notification>|background agents? (?:was|were) stopped/i.test(text)) return row.type === 'user' ? null : []
  if (/background agents? (?:was|were) stopped/i.test(text) && !/<task-id>/.test(text)) {
    return [{ kind: 'task_end', taskId: '*', status: 'stopped' }]
  }
  const tag = (name: string): string => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? ''
  const native = tag('task-id')
  const owner = tag('tool-use-id') || owners.get(native) || native
  const status = taskStatus(tag('status'))
  if (!owner || !status) return []
  owners.delete(native)
  const summary = cleanText(tag('summary'))
  return [{ kind: 'task_end', taskId: safeId(owner), status, ...(summary ? { detail: summary } : {}) }]
}

function taskStatus(value: string): 'done' | 'error' | 'stopped' | undefined {
  if (value === 'completed' || value === 'success') return 'done'
  if (value === 'failed' || value === 'error') return 'error'
  if (value === 'stopped' || value === 'killed' || value === 'cancelled') return 'stopped'
  return undefined
}

async function claudeChild(file: string): Promise<ChildLink | null> {
  const folder = path.dirname(file)
  if (path.basename(folder) !== 'subagents') return null
  const parentSessionId = path.basename(path.dirname(folder))
  const agentId = path.basename(file, '.jsonl').replace(/^agent-/, '')
  // Throws until the sidecar exists, so the watcher retries instead of caching a guess.
  const parsed = JSON.parse(await readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as unknown
  const meta = isRecord(parsed) ? parsed : {}
  const toolUseId = textOf(meta.toolUseId)
  return {
    parentSessionId,
    // Spawned from the main thread: the parent's tool_use id. Nested teammates have none.
    taskId: safeId(toolUseId || `agent-${agentId}`),
    label: textOf(meta.name) || textOf(meta.description) || textOf(meta.agentType) || '子 Agent'
  }
}

/** Newer Claude versions register busy sessions by PID, including parked jobs. */
async function activeClaudeSessions(root: string): Promise<Set<string>> {
  const active = new Set<string>()
  try {
    const files = (await readdir(root)).filter((name) => /^\d+\.json$/.test(name))
    await Promise.all(files.map(async (name) => {
      try {
        const file = path.join(root, name)
        if ((await stat(file)).size > 64 * 1024) return
        const row = parseMaybeRecord(await readFile(file, 'utf8'))
        if (row.pid !== Number(path.basename(name, '.json'))) return
        if (row.status !== 'busy' && row.status !== 'waiting') return
        const pid = Number(row.pid)
        if (!Number.isSafeInteger(pid) || pid <= 0) return
        process.kill(pid, 0)
        for (const id of [row.sessionId, row.parkedJobId]) {
          if (typeof id === 'string' && /^[A-Za-z0-9-]{8,}$/.test(id)) active.add(id)
        }
      } catch { /* Stale registrations and partial writes are expected. */ }
    }))
  } catch { /* Older Claude versions do not have a session registry. */ }
  return active
}
