/**
 * logger.ts — shared log emitter for the main process.
 *
 * Holds a reference to the BrowserWindow so any main-process module can emit
 * structured log entries to the renderer's ActivityLog without importing
 * from each other (avoids circular dependencies).
 */

import { BrowserWindow } from 'electron'

export interface LogEntry {
  ts: number
  direction: 'out' | 'in' | 'info' | 'error'
  message: string
}

let win: BrowserWindow | null = null
const buffer: LogEntry[] = []

export function setLogWindow(window: BrowserWindow): void {
  win = window
  // Flush any log entries that arrived before the window was ready.
  // Wait for the renderer to finish loading before sending.
  if (buffer.length === 0) return
  const flush = (): void => {
    buffer.splice(0).forEach((entry) => win?.webContents.send('log', entry))
  }
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', flush)
  } else {
    flush()
  }
}

const DIRECTION_PREFIX: Record<LogEntry['direction'], string> = {
  out:   '→',
  in:    '←',
  info:  '·',
  error: '✗',
}

export function emitLog(entry: LogEntry): void {
  const prefix = DIRECTION_PREFIX[entry.direction] ?? '·'
  console.log(`[log] ${prefix} ${entry.message}`)
  if (win) {
    win.webContents.send('log', entry)
  } else {
    buffer.push(entry)
  }
}

export function log(direction: LogEntry['direction'], message: string): void {
  emitLog({ ts: Date.now(), direction, message })
}
