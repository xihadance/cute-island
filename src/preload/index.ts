import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Activity } from '../shared/activity'

const island = {
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
