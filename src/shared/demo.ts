import type { ActivityInput, EndInput } from './activity'

export const DEMO_ID = 'demo'

export interface DemoFrame {
  delay: number
  upsert?: ActivityInput
  end?: { id: string } & EndInput
}

export const demoFrames: DemoFrame[] = [
  {
    delay: 0,
    upsert: {
      id: DEMO_ID,
      agent: 'Cursor',
      state: 'thinking',
      title: '正在理解任务',
      detail: '查看仓库里的界面结构',
      steps: [
        { id: 'read', label: '阅读现有界面', status: 'active' },
        { id: 'edit', label: '修改登录页', status: 'pending' },
        { id: 'check', label: '核对校验逻辑', status: 'pending' }
      ]
    }
  },
  {
    delay: 1400,
    upsert: {
      id: DEMO_ID,
      state: 'running',
      title: '正在修改登录页',
      detail: '补上表单校验和错误提示',
      progress: 0.42,
      steps: [
        { id: 'read', label: '阅读现有界面', status: 'done' },
        { id: 'edit', label: '修改登录页', status: 'active' },
        { id: 'check', label: '核对校验逻辑', status: 'pending' }
      ]
    }
  },
  {
    delay: 1500,
    upsert: {
      id: DEMO_ID,
      state: 'running',
      title: '正在核对校验逻辑',
      detail: '检查空密码和错误提示',
      progress: 0.78,
      steps: [
        { id: 'read', label: '阅读现有界面', status: 'done' },
        { id: 'edit', label: '修改登录页', status: 'done' },
        { id: 'check', label: '核对校验逻辑', status: 'active' }
      ]
    }
  },
  {
    delay: 1400,
    end: { id: DEMO_ID, result: 'success', summary: '登录页已更新' }
  }
]

export async function playDemoFrames(
  frames: readonly DemoFrame[],
  apply: (frame: DemoFrame) => void | Promise<void>,
  isCancelled: () => boolean,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<void> {
  for (const frame of frames) {
    if (frame.delay > 0) await sleep(frame.delay)
    if (isCancelled()) return
    await apply(frame)
  }
}
