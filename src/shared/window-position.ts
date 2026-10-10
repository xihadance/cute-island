export interface Point { x: number; y: number }
export interface Rectangle extends Point { width: number; height: number }
export type DockEdge = 'top' | 'right' | 'bottom' | 'left'
export interface EdgeDock extends Point { edge: DockEdge }
export interface WindowPosition extends Point { dock?: EdgeDock }
export interface DockState { edge: DockEdge | null; collapsed: boolean }

export const DRAG_THRESHOLD = 5
export const DOCK_THRESHOLD = 24

// Electron's integer argument conversion rejects JavaScript -0. Fractional
// animation bounds just above an edge can round to it, so normalize the sign.
function pixel(value: number): number { return Math.round(value) + 0 }

export function isEdgeDock(value: unknown): value is EdgeDock {
  return isPoint(value) && 'edge' in value &&
    ['top', 'right', 'bottom', 'left'].includes(String(value.edge))
}

/** Dock only after an intentional drop, never just because content grew near an edge. */
export function dockAfterDrag(position: Point, content: Rectangle, area: Rectangle): EdgeDock | undefined {
  const left = position.x + content.x
  const top = position.y + content.y
  const distances: [DockEdge, number][] = [
    ['top', Math.abs(top - area.y)],
    ['left', Math.abs(left - area.x)],
    ['right', Math.abs(area.x + area.width - left - content.width)],
    ['bottom', Math.abs(area.y + area.height - top - content.height)]
  ]
  const [edge, distance] = distances.sort((a, b) => a[1] - b[1])[0]
  if (distance > DOCK_THRESHOLD) return undefined
  return { edge, x: pixel(left + content.width / 2), y: pixel(top + content.height / 2) }
}

/** Pin the handle to the edge, and open inward without moving its along-edge anchor. */
export function dockedPosition(dock: EdgeDock, content: Rectangle, area: Rectangle, collapsed: boolean): Point {
  const gap = collapsed ? 0 : 8
  let left = dock.x - content.width / 2
  let top = dock.y - content.height / 2
  if (dock.edge === 'top') top = area.y + gap
  if (dock.edge === 'bottom') top = area.y + area.height - gap - content.height
  if (dock.edge === 'left') left = area.x + gap
  if (dock.edge === 'right') left = area.x + area.width - gap - content.width
  left = Math.min(Math.max(area.x, left), Math.max(area.x, area.x + area.width - content.width))
  top = Math.min(Math.max(area.y, top), Math.max(area.y, area.y + area.height - content.height))
  return { x: pixel(left - content.x), y: pixel(top - content.y) }
}

export function isPoint(value: unknown): value is Point {
  if (!value || typeof value !== 'object') return false
  const point = value as Partial<Point>
  return typeof point.x === 'number' && Number.isFinite(point.x) &&
    typeof point.y === 'number' && Number.isFinite(point.y)
}

/** Keep the visible capsule on screen; transparent window margins may extend beyond it. */
export function constrainPosition(position: Point, content: Rectangle, area: Rectangle): Point {
  const minX = area.x + 8 - content.x
  const minY = area.y + 8 - content.y
  const maxX = Math.max(minX, area.x + area.width - 8 - content.x - content.width)
  const maxY = Math.max(minY, area.y + area.height - 8 - content.y - content.height)
  return {
    x: pixel(Math.min(maxX, Math.max(minX, position.x))),
    y: pixel(Math.min(maxY, Math.max(minY, position.y)))
  }
}

export function positionAfterDrag(origin: Point, start: Point, cursor: Point): Point {
  return { x: origin.x + cursor.x - start.x, y: origin.y + cursor.y - start.y }
}
