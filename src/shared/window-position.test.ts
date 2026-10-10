import { describe, expect, it } from 'vitest'
import { constrainPosition, dockAfterDrag, dockedPosition, isEdgeDock, isPoint, positionAfterDrag, type DockEdge } from './window-position'

describe('window positioning', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 }
  const compact = { x: 60, y: 8, width: 340, height: 40 }

  it('normalizes negative zero from fractional animation bounds before native window positioning', () => {
    const fractional = { x: 8.25, y: 8.25, width: 380.5, height: 400.5 }
    const positions = [
      constrainPosition({ x: -1, y: -1 }, fractional, area),
      dockedPosition({ edge: 'top', x: 198.25, y: 240 }, fractional, area, false),
      dockedPosition({ edge: 'left', x: 240, y: 208.25 }, fractional, area, false)
    ]
    expect(positions).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }])
    for (const point of positions) {
      expect(Object.is(point.x, -0)).toBe(false)
      expect(Object.is(point.y, -0)).toBe(false)
    }
  })

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

  it('docks near each edge, prefers the nearest edge at corners, and leaves the center floating', () => {
    expect(dockAfterDrag({ x: 500, y: 0 }, compact, area)?.edge).toBe('top')
    expect(dockAfterDrag({ x: -52, y: 400 }, compact, area)?.edge).toBe('left')
    expect(dockAfterDrag({ x: 1512, y: 400 }, compact, area)?.edge).toBe('right')
    expect(dockAfterDrag({ x: 500, y: 984 }, compact, area)?.edge).toBe('bottom')
    expect(dockAfterDrag({ x: -36, y: 0 }, compact, area)?.edge).toBe('top')
    expect(dockAfterDrag({ x: 500, y: 400 }, compact, area)).toBeUndefined()
    expect(dockAfterDrag({ x: 500, y: 17 }, compact, area)).toBeUndefined()
  })

  it.each<DockEdge>(['top', 'right', 'bottom', 'left'])('keeps the %s handle reachable and expanded content inside a negative-coordinate monitor', edge => {
    const monitor = { x: -1280, y: -100, width: 1280, height: 1024 }
    const dock = { edge, x: -700, y: 300 }
    const handle = { x: 222, y: 8, width: 16, height: 72 }
    const point = dockedPosition(dock, handle, monitor, true)
    const visible = { x: point.x + handle.x, y: point.y + handle.y }
    if (edge === 'left') expect(visible.x).toBe(monitor.x)
    if (edge === 'right') expect(visible.x + handle.width).toBe(0)
    if (edge === 'top') expect(visible.y).toBe(monitor.y)
    if (edge === 'bottom') expect(visible.y + handle.height).toBe(924)
    const expanded = { x: 40, y: 8, width: 380, height: 400 }
    const open = dockedPosition(dock, expanded, monitor, false)
    expect(open.x + expanded.x).toBeGreaterThanOrEqual(monitor.x)
    expect(open.x + expanded.x + expanded.width).toBeLessThanOrEqual(0)
    expect(open.y + expanded.y).toBeGreaterThanOrEqual(monitor.y)
    expect(open.y + expanded.y + expanded.height).toBeLessThanOrEqual(924)
    expect(dockedPosition(dock, handle, area, true).x + handle.x).toBeGreaterThanOrEqual(0)
  })

  it('clamps oversized content and rejects malformed dock preferences', () => {
    expect(dockedPosition({ edge: 'bottom', x: -900, y: 1000 }, { x: 0, y: 8, width: 400, height: 520 },
      { x: 0, y: 0, width: 320, height: 240 }, false)).toEqual({ x: 0, y: -8 })
    expect(isEdgeDock({ edge: 'left', x: -100, y: 10 })).toBe(true)
    for (const value of [null, {}, { edge: 'unknown', x: 0, y: 0 }, { edge: 'top', x: Infinity, y: 0 }]) {
      expect(isEdgeDock(value)).toBe(false)
    }
  })

  it.each([null, {}, { x: 1 }, { x: '1', y: 1 }, { x: Infinity, y: 0 }, { x: 1, y: NaN }])('rejects an invalid saved point %j', value => {
    expect(isPoint(value)).toBe(false)
  })
})
