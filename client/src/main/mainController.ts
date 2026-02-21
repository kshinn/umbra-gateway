/**
 * mainController.ts — Bootstrap for ambire-common MainController in Electron.
 *
 * Creates and configures the MainController with Electron-specific adapters.
 * The relayer is stubbed (empty string) — we use hardcoded network configs.
 */

import { MainController } from '@ambire-common/controllers/main/main'
import { KeystoreSigner } from '@ambire-common/libs/keystoreSigner/keystoreSigner'
import type { BrowserWindow } from 'electron'
import { electronStorage } from './adapters/storage'
import { createElectronWindowManager } from './adapters/windowManager'
import { electronNotificationManager } from './adapters/notification'

export let mainCtrl: MainController | null = null

export function createMainController(mainWindow: BrowserWindow): MainController {
  const windowManager = createElectronWindowManager(mainWindow)

  const ctrl = new MainController({
    platform: 'default',
    storageAPI: electronStorage,
    fetch: globalThis.fetch as any,
    // Relayer stubbed — controllers handle missing relayer gracefully.
    relayerUrl: '',
    velcroUrl: '',
    privacyPoolsAspUrl: '',
    privacyPoolsRelayerUrl: '',
    railgunRelayerUrl: '',
    alchemyApiKey: process.env.ALCHEMY_API_KEY || '',
    infuraApiKey: process.env.INFURA_API_KEY || '',
    hypersyncApiKey: '',
    featureFlags: {},
    swapApiKey: '',
    keystoreSigners: { internal: KeystoreSigner },
    externalSignerControllers: {},
    windowManager,
    notificationManager: electronNotificationManager,
  })

  mainCtrl = ctrl
  return ctrl
}
