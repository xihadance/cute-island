import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readWindowPosition, saveWindowPosition } from './window-position'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('island-position-')) throw new Error('Unexpected temporary path')
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('position preference', () => {
  it('restores a saved drop position and tolerates a missing or damaged file', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'island-position-'))
    directories.push(directory)
    const file = path.join(directory, 'window-position.json')
    expect(readWindowPosition(file)).toBeUndefined()
    saveWindowPosition(file, { x: -460, y: 800 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ x: -460, y: 800 })
    expect(readWindowPosition(file)).toEqual({ x: -460, y: 800 })
    const docked = { x: -460, y: 800, dock: { edge: 'left' as const, x: -240, y: 840 } }
    saveWindowPosition(file, docked)
    expect(readWindowPosition(file)).toEqual(docked)
    writeFileSync(file, '{"x":1,"y":2,"dock":{"edge":"unknown","x":0,"y":0}}')
    expect(readWindowPosition(file)).toEqual({ x: 1, y: 2 })
    writeFileSync(file, '{broken')
    expect(readWindowPosition(file)).toBeUndefined()
    writeFileSync(file, '{"x":"bad","y":0}')
    expect(readWindowPosition(file)).toBeUndefined()
  })
})
