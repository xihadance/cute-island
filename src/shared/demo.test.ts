import { describe, expect, it } from 'vitest'
import { demoFrames, playDemoFrames } from './demo'

describe('playDemoFrames', () => {
  it('applies frames in order and stops when cancelled', async () => {
    const applied: string[] = []
    const sleeps: number[] = []
    let cancelled = false
    await playDemoFrames(
      demoFrames,
      (frame) => {
        applied.push(frame.upsert?.state ?? frame.end?.result ?? '')
        if (applied.length === 2) cancelled = true
      },
      () => cancelled,
      async (ms) => {
        sleeps.push(ms)
      }
    )
    expect(applied).toEqual(['thinking', 'running'])
    expect(sleeps).toEqual([1400, 1500])
  })
})
