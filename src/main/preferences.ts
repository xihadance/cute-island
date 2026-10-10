import { readFileSync, writeFileSync } from 'node:fs'
import { isIslandMode, type IslandMode } from '../shared/island-behavior'

export function readIslandMode(file: string): IslandMode {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (value && typeof value === 'object' && 'mode' in value && isIslandMode(value.mode)) return value.mode
  } catch { /* First launch or a damaged preference: keep the existing focus behavior. */ }
  return 'focus'
}

export function saveIslandMode(file: string, mode: IslandMode): void {
  try { writeFileSync(file, JSON.stringify({ mode }), 'utf8') }
  catch (error) { console.error('无法保存灵动岛模式', error) }
}
