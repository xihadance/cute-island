import path from 'node:path'
import { ACTIVITY_STATES, type ActivityState } from './shared/activity'
import { demoFrames, playDemoFrames } from './shared/demo'

interface CliIo {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  stdout?: (line: string) => void
  stderr?: (line: string) => void
}

export function parseArgs(argv: readonly string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`无法识别参数 ${token}`)
    const body = token.slice(2)
    if (!body) throw new Error('无法识别参数 --')
    const eq = body.indexOf('=')
    if (eq >= 0) {
      args[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      args[body] = 'true'
      continue
    }
    args[body] = next
    index += 1
  }
  return args
}

export async function runCli(argv: readonly string[], io: CliIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((line: string) => console.log(line))
  const stderr = io.stderr ?? ((line: string) => console.error(line))
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    stdout(USAGE)
    return command ? 0 : 0
  }
  try {
    if (command === 'push') {
      await push(parseArgs(rest), io, stdout, stderr)
      return 0
    }
    if (command === 'end') {
      await endActivity(parseArgs(rest), io, stdout, stderr)
      return 0
    }
    if (command === 'demo') {
      await playRemoteDemo(io, stdout)
      return 0
    }
    stderr(`未知命令 ${command}`)
    stderr(USAGE)
    return 1
  } catch (error) {
    stderr(error instanceof Error ? error.message : '命令失败')
    return 1
  }
}

async function push(
  args: Record<string, string>,
  io: CliIo,
  stdout: (line: string) => void,
  stderr: (line: string) => void
): Promise<void> {
  if (!args.state && !args.title) throw new Error('push 至少需要 --state 或 --title')
  const body: Record<string, unknown> = { id: args.id ?? 'default' }
  if (args.agent) body.agent = args.agent
  if (args.state) body.state = parseState(args.state)
  if (args.title) body.title = args.title
  if ('detail' in args) body.detail = args.detail === 'null' ? null : args.detail
  if ('progress' in args) body.progress = parseProgress(args.progress)
  if ('steps' in args) body.steps = parseSteps(args.steps)
  const response = await request(io, '/v1/activities', body)
  if (!response.ok) {
    stderr(await readError(response))
    throw new Error('更新活动失败')
  }
  stdout(`已更新 ${String(body.id)}`)
}

async function endActivity(
  args: Record<string, string>,
  io: CliIo,
  stdout: (line: string) => void,
  stderr: (line: string) => void
): Promise<void> {
  const id = args.id ?? 'default'
  if (args.result !== 'success' && args.result !== 'error') {
    throw new Error('end 需要 --result success 或 --result error')
  }
  const body: Record<string, unknown> = { result: args.result }
  if (args.summary) body.summary = args.summary
  const response = await request(io, `/v1/activities/${encodeURIComponent(id)}/end`, body)
  if (!response.ok) {
    stderr(await readError(response))
    throw new Error('结束活动失败')
  }
  stdout(`已结束 ${id}`)
}

async function playRemoteDemo(io: CliIo, stdout: (line: string) => void): Promise<void> {
  stdout('正在播放演示')
  await playDemoFrames(demoFrames, (frame) => sendFrame(io, frame), () => false, io.sleep)
  stdout('演示已发送')
}

async function sendFrame(
  io: CliIo,
  frame: { upsert?: unknown; end?: { id: string; result: 'success' | 'error'; summary?: string } }
): Promise<void> {
  if (frame.upsert) {
    const response = await request(io, '/v1/activities', frame.upsert)
    if (!response.ok) throw new Error(await readError(response))
  }
  if (frame.end) {
    const response = await request(io, `/v1/activities/${encodeURIComponent(frame.end.id)}/end`, {
      result: frame.end.result,
      summary: frame.end.summary
    })
    if (!response.ok) throw new Error(await readError(response))
  }
}

async function request(io: CliIo, pathname: string, body: unknown): Promise<Response> {
  const env = io.env ?? process.env
  const fetchImpl = io.fetchImpl ?? fetch
  const port = env.CUTE_ISLAND_PORT ?? '17321'
  try {
    return await fetchImpl(`http://127.0.0.1:${port}${pathname}`, {
      method: 'POST',
      headers: headers(env),
      body: JSON.stringify(body)
    })
  } catch {
    throw new Error('连不上灵动岛。请先启动应用（默认 http://127.0.0.1:17321）。')
  }
}

function headers(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = { 'content-type': 'application/json' }
  if (env.CUTE_ISLAND_TOKEN) result.authorization = `Bearer ${env.CUTE_ISLAND_TOKEN}`
  return result
}

function parseState(value: string): ActivityState {
  if ((ACTIVITY_STATES as readonly string[]).includes(value)) return value as ActivityState
  throw new Error(`state 无效: ${value}`)
}

function parseProgress(value: string): number | null {
  if (value === 'null') return null
  const progress = Number(value)
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new Error('progress 必须在 0 到 1 之间')
  }
  return progress
}

function parseSteps(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error('steps 必须是 JSON 数组')
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string }
    return body.error ?? `请求失败（${response.status}）`
  } catch {
    return `请求失败（${response.status}）`
  }
}

const USAGE = `用法
  cute-island push --agent Cursor --state running --title "正在修改登录页"
  cute-island end --id default --result success --summary "已完成"
  cute-island demo

push 选项
  --id        活动 id，默认 default
  --agent     显示名称
  --state     thinking | running | waiting | success | error
  --title     一行标题
  --detail    补充说明，传 null 可清空
  --progress  0 到 1
  --steps     JSON 数组，例如 [{"id":"edit","label":"修改登录页","status":"active"}]

环境变量
  CUTE_ISLAND_PORT   默认 17321
  CUTE_ISLAND_TOKEN  与主进程使用同一个令牌
`

function shouldRunAsCli(): boolean {
  if (process.env.VITEST) return false
  if (process.env.CUTE_ISLAND_CLI === '1') return true
  const entry = process.argv[1] ?? ''
  return entry.endsWith(`${path.sep}cli.ts`) || entry.endsWith(`${path.sep}cli.cjs`)
}

if (shouldRunAsCli()) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code)
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
}
