export interface Point { x: number; y: number }
export interface Rectangle extends Point { width: number; height: number }

export const DRAG_THRESHOLD = 5

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
    x: Math.round(Math.min(maxX, Math.max(minX, position.x))),
    y: Math.round(Math.min(maxY, Math.max(minY, position.y)))
  }
}

export function positionAfterDrag(origin: Point, start: Point, cursor: Point): Point {
  return { x: origin.x + cursor.x - start.x, y: origin.y + cursor.y - start.y }
}
