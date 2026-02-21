/**
 * notification.ts — Electron adapter for the ambire-common NotificationManager interface.
 */

import { Notification } from 'electron'
import type { NotificationManager } from '@ambire-common/interfaces/notification'

export const electronNotificationManager: NotificationManager = {
  async create({ title, message }: { title: string; message: string; icon?: string }): Promise<void> {
    if (Notification.isSupported()) {
      new Notification({ title, body: message }).show()
    }
  },
}
