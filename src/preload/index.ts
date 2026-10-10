import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Activity } from '../shared/activity'
import type { DockState } from '../shared/window-position'
import type { IslandBehavior, IslandMode } from '../shared/island-behavior'

const island = {
  getBehavior(): Promise<IslandBehavior> {
    return ipcRenderer.invoke('island:get-behavior')
  },
  setMode(mode: IslandMode): void {
    ipcRenderer.send('island:set-mode', mode)
  },
  acknowledge(id: string): void {
    ipcRenderer.send('island:acknowledge', id)
  },
  onBehavior(callback: (behavior: IslandBehavior) => void): () => void {
    const listener = (_event: IpcRendererEvent, behavior: IslandBehavior): void => callback(behavior)
    ipcRenderer.on('island:behavior', listener)
    return () => { ipcRenderer.removeListener('island:behavior', listener) }
  },
  getDock(): Promise<DockState> {
    return ipcRenderer.invoke('island:get-dock')
  },
  setDockExpanded(expanded: boolean): void {
    ipcRenderer.send('island:set-dock-expanded', expanded)
  },
  onDock(callback: (dock: DockState) => void): () => void {
    const listener = (_event: IpcRendererEvent, dock: DockState): void => callback(dock)
    ipcRenderer.on('island:dock', listener)
    return () => { ipcRenderer.removeListener('island:dock', listener) }
  },
  dragWindow(phase: 'start' | 'move' | 'end'): void {
    ipcRenderer.send('island:drag', phase)
  },
  setIgnoreMouse(ignore: boolean): void {
    ipcRenderer.send('island:set-ignore-mouse', ignore)
  },
  getActivities(): Promise<Activity[]> {
    return ipcRenderer.invoke('island:get-activities')
  },
  dismiss(id: string): Promise<void> {
    return ipcRenderer.invoke('island:dismiss', id)
  },
  playDemo(): Promise<void> {
    return ipcRenderer.invoke('island:play-demo')
  },
  onActivities(callback: (activities: Activity[]) => void): () => void {
    const listener = (_event: IpcRendererEvent, activities: Activity[]): void => {
      callback(activities)
    }
    ipcRenderer.on('island:activities', listener)
    return () => {
      ipcRenderer.removeListener('island:activities', listener)
    }
  },
  setInteraction(hit: { expanded: boolean; x: number; y: number; width: number; height: number }): void {
    ipcRenderer.send('island:interaction', hit)
  },
  onPointer(callback: (sample: { x: number; y: number; overWindow: boolean; overIsland: boolean }) => void): () => void {
    const listener = (_event: IpcRendererEvent, sample: { x: number; y: number; overWindow: boolean; overIsland: boolean }): void => {
      callback(sample)
    }
    ipcRenderer.on('island:pointer', listener)
    return () => {
      ipcRenderer.removeListener('island:pointer', listener)
    }
  }
}

contextBridge.exposeInMainWorld('island', island)
