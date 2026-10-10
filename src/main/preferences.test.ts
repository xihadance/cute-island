import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { readIslandMode, saveIslandMode } from './preferences'

it('defaults to focus and restores a valid mode independently of window position', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'island-mode-'))
  try {
    const file = path.join(directory, 'preferences.json')
    expect(readIslandMode(file)).toBe('focus')
    saveIslandMode(file, 'managed')
    expect(readIslandMode(file)).toBe('managed')
    saveIslandMode(file, 'focus')
    expect(readIslandMode(file)).toBe('focus')
    for (const invalid of ['{broken', 'null', '{"mode":"unknown"}', '{}']) {
      writeFileSync(file, invalid)
      expect(readIslandMode(file)).toBe('focus')
    }
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('island-mode-')) throw new Error('Unexpected temporary path')
    rmSync(directory, { recursive: true, force: true })
  }
})
