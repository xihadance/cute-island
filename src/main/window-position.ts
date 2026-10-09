import { readFileSync, writeFileSync } from 'node:fs'
import { isPoint, type Point } from '../shared/window-position'

export function readWindowPosition(file: string): Point | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (isPoint(value)) return { x: Math.round(value.x), y: Math.round(value.y) }
  } catch { /* First launch or an invalid preference: use the default position. */ }
  return undefined
}

export function saveWindowPosition(file: string, position: Point): void {
  // A tiny preference is written only on drop/reset, never on mouse movement.
  try { writeFileSync(file, JSON.stringify(position), 'utf8') }
  catch (error) { console.error('无法保存灵动岛位置', error) }
}
