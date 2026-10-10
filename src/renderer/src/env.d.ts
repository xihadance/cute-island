/// <reference types="vite/client" />

import type { Activity } from '../../shared/activity'
import type { DockState } from '../../shared/window-position'
import type { IslandBehavior, IslandMode } from '../../shared/island-behavior'

export interface PointerSample {
  x: number
  y: number
  overWindow: boolean
  overIsland: boolean
}

export interface IslandHit {
  expanded: boolean
  x: number
  y: number
  width: number
  height: number
}

export interface IslandApi {
  getBehavior: () => Promise<IslandBehavior>
  onBehavior: (callback: (behavior: IslandBehavior) => void) => () => void
  setMode: (mode: IslandMode) => void
  acknowledge: (id: string) => void
  getDock?: () => Promise<DockState>
  onDock?: (callback: (dock: DockState) => void) => () => void
  setDockExpanded?: (expanded: boolean) => void
  dragWindow?: (phase: 'start' | 'move' | 'end') => void
  setIgnoreMouse: (ignore: boolean) => void
  getActivities: () => Promise<Activity[]>
  dismiss: (id: string) => Promise<void>
  playDemo: () => Promise<void>
  onActivities: (callback: (activities: Activity[]) => void) => () => void
  setInteraction?: (hit: IslandHit) => void
  onPointer?: (callback: (sample: PointerSample) => void) => () => void
  simulateError?: () => void
  simulateAgents?: () => void
  simulateSessions?: () => void
  simulateCapabilities?: () => void
  simulateTasks?: () => void
  simulateApproval?: () => void
  clear?: () => void
}

declare global {
  interface Window {
    island?: IslandApi
  }
}

export {}
