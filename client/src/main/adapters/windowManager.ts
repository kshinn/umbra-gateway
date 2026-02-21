/**
 * windowManager.ts — Electron adapter for the ambire-common WindowManager interface.
 *
 * For MVP, all signing/confirmation UI is embedded in the main window.
 * The manager handles toast messages and UI signals via IPC.
 */

import { EventEmitter } from 'events'
import type { BrowserWindow } from 'electron'
import type { WindowManager, WindowProps } from '@ambire-common/interfaces/window'

export function createElectronWindowManager(mainWindow: BrowserWindow): WindowManager {
  const event = new EventEmitter()

  return {
    event,

    open: async (_options?: {
      route?: string
      customSize?: { width: number; height: number }
      baseWindowId?: number
    }): Promise<WindowProps> => {
      // For MVP: focus the main window rather than opening a popup.
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
      return {
        id: mainWindow.id,
        top: 0,
        left: 0,
        width: mainWindow.getBounds().width,
        height: mainWindow.getBounds().height,
        focused: true,
      }
    },

    focus: async (windowProps: WindowProps): Promise<WindowProps> => {
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
      return windowProps
    },

    closePopupWithUrl: async (_url: string): Promise<void> => {
      // No popup support in MVP — no-op.
    },

    remove: async (_winId: number | 'popup'): Promise<void> => {
      // No popup support in MVP — no-op.
    },

    sendWindowToastMessage: (
      message: string,
      options?: { timeout?: number; type?: string; sticky?: boolean },
    ): void => {
      if (mainWindow.isDestroyed()) return
      mainWindow.webContents.send('toast', { message, options })
    },

    sendWindowUiMessage: (params: object): void => {
      if (mainWindow.isDestroyed()) return
      mainWindow.webContents.send('ui-message', params)
    },
  }
}
