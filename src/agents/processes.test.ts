import { describe, expect, it } from 'vitest'
import { clientForProcess, processSnapshotFrom, type ProcessInfo } from './processes'

const proc = (pid: number, parentPid: number, name: string, commandLine = ''): ProcessInfo => ({ pid, parentPid, name, commandLine })

describe('session client process evidence', () => {
  it('keeps simultaneous hosts of the same agent separate and prefers the host over its shell', () => {
    const processes = [proc(1, 2, 'claude.exe'), proc(2, 3, 'pwsh.exe'), proc(3, 0, 'WindowsTerminal.exe'),
      proc(4, 5, 'claude.exe'), proc(5, 0, 'Code.exe'), proc(6, 7, 'claude.exe'), proc(7, 0, 'Cursor.exe'),
      proc(8, 9, 'codex.exe'), proc(9, 0, 'powershell.exe'), proc(10, 0, 'claude.exe')]
    expect([1, 4, 6, 8, 10].map((pid) => clientForProcess(pid, processes)))
      .toEqual(['Windows Terminal', 'VS Code', 'Cursor', 'PowerShell', undefined])
    expect(clientForProcess(999, processes)).toBeUndefined()
  })

  it('rejects recycled parent PIDs and terminates cyclic ancestry', () => {
    expect(clientForProcess(1, [{ ...proc(1, 2, 'claude.exe'), createdAt: 100 }, { ...proc(2, 0, 'Code.exe'), createdAt: 200 }])).toBeUndefined()
    expect(clientForProcess(1, [proc(1, 2, 'claude.exe'), proc(2, 1, 'unknown.exe')])).toBeUndefined()
  })

  it('reads Windows CIM snapshots and preserves executable fallback when command lines are unavailable', () => {
    const rows = [proc(1, 2, 'claude.exe'), proc(2, 0, 'Code.exe'),
      proc(3, 0, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"')]
    const snapshot = processSnapshotFrom('\uFEFF' + JSON.stringify(rows), 'win32')
    expect([...snapshot.running].sort()).toEqual(['claude', 'codex'])
    expect(clientForProcess(1, snapshot.processes)).toBe('VS Code')
    expect(processSnapshotFrom(JSON.stringify(rows[0]), 'win32').processes).toHaveLength(1)
    expect(processSnapshotFrom('null', 'win32').processes).toEqual([])
  })

  it('reads Unix process ancestry without using command arguments as client names', () => {
    const snapshot = processSnapshotFrom('  10 20 /usr/bin/claude\n 20 30 /bin/bash\n 30 1 /usr/bin/konsole\n 40 1 node unrelated.js Code.exe\n', 'linux')
    expect([...snapshot.running]).toEqual(['claude'])
    expect(clientForProcess(10, snapshot.processes)).toBe('Konsole')
    expect(clientForProcess(40, snapshot.processes)).toBeUndefined()
  })
})
