import { ActivityStore } from '../../shared/activity'
import { DEMO_ID, demoFrames, playDemoFrames } from '../../shared/demo'
import type { IslandApi } from './env'
import { AttentionTracker, isIslandMode, type IslandBehavior, type IslandMode } from '../../shared/island-behavior'

let mock: IslandApi | undefined

export function getBridge(): IslandApi {
  if (window.island) return window.island
  mock ??= createMockBridge()
  return mock
}

function createMockBridge(): IslandApi {
  const store = new ActivityStore()
  const attention = new AttentionTracker()
  let mode: IslandMode = 'focus'
  try {
    const saved = localStorage.getItem('cute-island-mode')
    if (isIslandMode(saved)) mode = saved
  } catch { /* Storage may be unavailable in previews. */ }
  const behaviorListeners = new Set<(behavior: IslandBehavior) => void>()
  const behavior = (): IslandBehavior => ({ mode, attentionIds: attention.pendingIds() })
  const notifyBehavior = (): void => {
    const next = behavior()
    for (const listener of behaviorListeners) listener(next)
  }
  let demoToken = 0
  const listeners = new Set<(activities: ReturnType<ActivityStore['list']>) => void>()
  store.subscribe((activities) => {
    attention.update(activities)
    notifyBehavior()
    for (const listener of listeners) listener(activities)
  })
  return {
    getBehavior: async () => behavior(),
    onBehavior(callback) {
      behaviorListeners.add(callback)
      return () => { behaviorListeners.delete(callback) }
    },
    setMode(next) {
      if (!isIslandMode(next)) return
      mode = next
      try { localStorage.setItem('cute-island-mode', mode) } catch { /* Optional preview persistence. */ }
      notifyBehavior()
    },
    acknowledge(id) { attention.acknowledge(id); notifyBehavior() },
    setIgnoreMouse() {},
    getActivities: async () => store.list(),
    dismiss: async (id) => {
      store.dismiss(id)
    },
    playDemo: async () => {
      const token = ++demoToken
      store.dismiss(DEMO_ID)
      await playDemoFrames(
        demoFrames,
        (frame) => {
          if (frame.upsert) store.upsert(frame.upsert)
          if (frame.end) {
            try {
              store.end(frame.end.id, frame.end)
            } catch {
              // A newer demo can dismiss the activity before this frame lands.
            }
          }
        },
        () => token !== demoToken
      )
    },
    onActivities(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    simulateError() {
      store.upsert({
        id: 'error-demo',
        agent: 'Cursor',
        state: 'error',
        title: '无法写入文件',
        detail: '目标文件被占用',
        steps: [
          { id: 'edit', label: '修改登录页', status: 'done' },
          { id: 'write', label: '写回文件', status: 'error' }
        ]
      })
    },
    simulateAgents() {
      store.upsert({
        id: 'pair-claude',
        agent: 'Claude Code',
        state: 'running',
        title: '补上表单校验',
        detail: '修好登录页'
      })
      store.upsert({
        id: 'pair-codex',
        agent: 'Codex',
        state: 'thinking',
        title: '正在看测试'
      })
      store.upsert({
        id: 'pair-gemini',
        agent: 'Gemini',
        state: 'waiting',
        title: '等待确认'
      })
      store.upsert({
        id: 'pair-cursor',
        agent: 'Cursor',
        state: 'running',
        title: '正在改灵动岛'
      })
    },
    simulateSessions() {
      store.upsert({
        id: 'claude-login',
        agent: 'Claude Code',
        state: 'running',
        title: '补上表单校验',
        detail: '修好登录页',
        steps: [{ id: 'edit', label: '修改登录页', status: 'active' }]
      })
      store.upsert({
        id: 'claude-tests',
        agent: 'Claude Code',
        state: 'thinking',
        title: '正在看测试',
        detail: '核对空密码提示'
      })
      store.upsert({
        id: 'claude-review',
        agent: 'Claude Code',
        state: 'waiting',
        title: '等待确认修改'
      })
    },
    simulateCapabilities() {
      demoToken += 1
      store.clear()
      store.upsert({ id: 'cap-command', agent: 'Codex', client: 'Windows Terminal', state: 'running', title: '运行类型检查',
        operation: { kind: 'command', name: 'exec_command', shell: 'cmd', command: 'cmd /c npm run typecheck', cwd: 'D:\\projects\\cute-island' },
        steps: [{ id: 'read', label: '读取项目配置', kind: 'read', status: 'done' }, { id: 'check', label: '检查 TypeScript 类型', kind: 'command', status: 'active' }] })
      store.upsert({ id: 'cap-mcp', agent: 'Claude Code', client: 'VS Code', state: 'running', title: '获取组件文档',
        operation: { kind: 'mcp', name: 'context7 / query_docs' } })
      store.upsert({ id: 'cap-skill', agent: 'Gemini', state: 'running', title: '读取界面设计技能',
        operation: { kind: 'skill', name: 'frontend-design' } })
      store.upsert({ id: 'cap-agent', agent: 'Cursor', client: 'Cursor', state: 'running', title: '子 Agent 正在检查测试',
        operation: { kind: 'agent', name: 'review_tests' } })
    },
    simulateTasks() {
      demoToken += 1
      store.clear()
      const startedAt = Date.now() - 75_000
      store.upsert({ id: 'tasks-codex', agent: 'Codex', state: 'running', title: '2 个子 Agent 进行中', detail: '并行校订 EP04-EP06',
        steps: [{ id: 'spawn', label: '派生子 Agent', kind: 'agent', status: 'done' }, { id: 'wait', label: '等待子 Agent', kind: 'agent', status: 'done' }],
        tasks: [
          { id: 'dirac', kind: 'agent', label: 'Dirac', status: 'done', detail: 'EP04 已校订', startedAt, endedAt: startedAt + 42_000 },
          { id: 'newton', kind: 'agent', label: 'Newton', status: 'active', state: 'running', detail: '读取 EP05 连续性上下文', startedAt },
          { id: 'helmholtz', kind: 'agent', label: 'Helmholtz', status: 'active', state: 'thinking', detail: '校订 EP06 结尾', startedAt: startedAt + 25_000 },
          { id: 'cell-3', kind: 'command', label: 'npm test', status: 'error', detail: 'Exit code 1', startedAt, endedAt: startedAt + 21_000 }
        ] })
      store.upsert({ id: 'tasks-claude', agent: 'Claude Code', state: 'thinking', title: '整理调研结果',
        tasks: [{ id: 'bash-1', kind: 'command', label: '构建项目', status: 'active' }] })
    },
    simulateApproval() {
      demoToken += 1
      store.clear()
      store.upsert({ id: 'approval-demo', agent: 'Codex', state: 'approval', title: '安装项目依赖',
        detail: '此命令请求访问网络，需要你确认',
        operation: { kind: 'command', name: 'exec_command', shell: 'PowerShell', command: 'npm install', cwd: 'D:\\projects\\cute-island' },
        steps: [{ id: 'read', label: '读取 package.json', kind: 'read', status: 'done' }, { id: 'install', label: '安装项目依赖', kind: 'command', status: 'waiting' }] })
    },
    clear() {
      demoToken += 1
      store.clear()
    }
  }
}
