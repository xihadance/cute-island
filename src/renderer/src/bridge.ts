import { ActivityStore } from '../../shared/activity'
import { DEMO_ID, demoFrames, playDemoFrames } from '../../shared/demo'
import type { IslandApi } from './env'

let mock: IslandApi | undefined

export function getBridge(): IslandApi {
  if (window.island) return window.island
  mock ??= createMockBridge()
  return mock
}

function createMockBridge(): IslandApi {
  const store = new ActivityStore()
  let demoToken = 0
  const listeners = new Set<(activities: ReturnType<ActivityStore['list']>) => void>()
  store.subscribe((activities) => {
    for (const listener of listeners) listener(activities)
  })
  return {
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
    clear() {
      demoToken += 1
      store.clear()
    }
  }
}
