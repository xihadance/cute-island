import { describe, expect, it } from 'vitest'
import { constrainPosition, isPoint, positionAfterDrag } from './window-position'

describe('window positioning', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 }
  const compact = { x: 60, y: 8, width: 340, height: 40 }

  it('allows a compact capsule near the bottom, despite transparent window margins', () => {
    expect(constrainPosition({ x: 500, y: 980 }, compact, area)).toEqual({ x: 500, y: 980 })
    expect(constrainPosition({ x: 2000, y: 1500 }, compact, area)).toEqual({ x: 1512, y: 984 })
  })

  it('keeps expanded content on screen and can restore the original anchor on collapse', () => {
    const anchor = { x: 1500, y: 980 }
    expect(constrainPosition(anchor, { x: 40, y: 8, width: 380, height: 400 }, area)).toEqual({ x: 1492, y: 624 })
    expect(constrainPosition(anchor, compact, area)).toEqual(anchor)
  })

  it('supports a monitor to the left and recovers a position after unplugging it', () => {
    const left = { x: -1280, y: -100, width: 1280, height: 1024 }
    expect(constrainPosition({ x: -1200, y: 0 }, compact, left)).toEqual({ x: -1200, y: 0 })
    const recovered = constrainPosition({ x: -1200, y: 0 }, compact, area)
    expect(recovered.x + compact.x).toBe(8)
    expect(recovered.y + compact.y).toBe(8)
  })

  it('uses the original global cursor position so moving the window cannot compound the delta', () => {
    const origin = { x: 100, y: 200 }
    expect(positionAfterDrag(origin, { x: 300, y: 220 }, { x: 450, y: 320 })).toEqual({ x: 250, y: 300 })
    expect(positionAfterDrag(origin, { x: 300, y: 220 }, { x: 350, y: 250 })).toEqual({ x: 150, y: 230 })
  })

  it.each([null, {}, { x: 1 }, { x: '1', y: 1 }, { x: Infinity, y: 0 }, { x: 1, y: NaN }])('rejects an invalid saved point %j', value => {
    expect(isPoint(value)).toBe(false)
  })
})
