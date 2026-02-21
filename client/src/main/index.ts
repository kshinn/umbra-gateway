import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { importKey, loadKey, hasKey, clearKey, generateAccount, importFromMnemonic } from './keystore'
import { initHelios, shutdownHelios, getHeliosStatus } from './helios'
import { rpcCall, getBalances, sendToken, setGateway, clearGateway, getGatewayUrl, getX402UsdcBalance } from './rpc'
import { setLogWindow, log } from './logger'
import { createMainController } from './mainController'
import { startTor, stopTor, getArtiSocksPort, getTorStatus, getTorBootstrapPercent } from './torProcess'
import { setSocksPort } from './gatewayFetch'
import { stringify } from '@ambire-common/libs/richJson/richJson'
import type { MainController } from '@ambire-common/controllers/main/main'

// ---------------------------------------------------------------------------
// WASM crash guard
// ---------------------------------------------------------------------------
// Helios runs as a WASM module. A Rust panic inside WASM surfaces as a
// RuntimeError with message "unreachable", which Node normally treats as a
// fatal uncaught exception and crashes Electron. We catch it here, shut
// Helios down gracefully, and let the app keep running with direct RPC
// fallback. All other uncaught exceptions are re-thrown as normal.
process.on('uncaughtException', (err) => {
  const isWasmPanic =
    err.name === 'RuntimeError' ||
    (err instanceof Error && err.message === 'unreachable') ||
    err.stack?.includes('wasm://')

  if (isWasmPanic) {
    log('error', `helios: WASM panic — shutting down light client, falling back to direct RPC`)
    console.error('[helios] WASM uncaught exception:', err)
    shutdownHelios().catch(() => {})
    return
  }

  // Not a WASM error — let Electron handle it normally.
  throw err
})

let mainWindow: BrowserWindow | null = null
let ambireCtrl: MainController | null = null

// ---------------------------------------------------------------------------
// Helpers: forward controller state to renderer
// ---------------------------------------------------------------------------

function sendControllerState(name: string, controller: { toJSON?: () => unknown }): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const state = controller.toJSON ? controller.toJSON() : controller
  try {
    mainWindow.webContents.send('controller:update', name, stringify(state))
  } catch {
    // Renderer may not be ready yet — ignore
  }
}

function subscribeController(name: string, controller: { onUpdate: (cb: () => void) => void; toJSON?: () => unknown }): void {
  controller.onUpdate(() => sendControllerState(name, controller))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#0a0a0f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  setLogWindow(mainWindow)

  // Bootstrap ambire-common MainController
  try {
    ambireCtrl = createMainController(mainWindow)

    // Subscribe key sub-controllers to forward state updates to renderer
    const ctrl = ambireCtrl
    subscribeController('main', ctrl)
    subscribeController('keystore', ctrl.keystore)
    subscribeController('accounts', ctrl.accounts)
    subscribeController('networks', ctrl.networks)
    subscribeController('selectedAccount', ctrl.selectedAccount)
    subscribeController('portfolio', ctrl.portfolio)
    subscribeController('activity', ctrl.activity)
    subscribeController('transfer', ctrl.transfer)
    subscribeController('accountPicker', ctrl.accountPicker)

    log('info', 'ambire-common MainController initialized')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('error', `MainController init failed: ${msg}`)
    console.error('[ambire] MainController init error:', err)
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---------------------------------------------------------------------------
// IPC: wallet handlers
// ---------------------------------------------------------------------------

ipcMain.handle('wallet:hasKey', () => {
  return hasKey()
})

ipcMain.handle('wallet:importKey', async (_event, input: string) => {
  const trimmed = input.trim()
  // Detect mnemonic (contains spaces) vs raw hex key
  if (trimmed.includes(' ')) {
    importFromMnemonic(trimmed)
  } else {
    importKey(trimmed)
  }
  return { ok: true }
})

ipcMain.handle('wallet:generateAccount', () => {
  return generateAccount()
})

ipcMain.handle('wallet:getAddress', () => {
  const account = loadKey()
  return account.address
})

ipcMain.handle('wallet:clearKey', () => {
  clearKey()
  return { ok: true }
})

// ---------------------------------------------------------------------------
// IPC: RPC handlers
// ---------------------------------------------------------------------------

// Cached USDC balance for x402:getStatus. Avoids an eth_call on every 3-second
// poll from PrivacyStatusBar. Invalidated when the gateway URL changes or after
// a send so the display stays roughly fresh without constant RPC traffic.
let cachedUsdcBalance: string | null = null
// Guard against concurrent fetches: the Helios proof chain through Tor can take
// 5-10 seconds. Without this, every poll that arrives while the first
// eth_call is in-flight stacks another eth_call into the queue.
let usdcBalanceFetching = false

function invalidateUsdcBalance(): void {
  cachedUsdcBalance = null
  usdcBalanceFetching = false
  mainWindow?.webContents.send('x402:refresh')
}

ipcMain.handle('rpc:setGateway', async (_event, url: string) => {
  setGateway(url)
  invalidateUsdcBalance()
  log('info', `gateway set to ${url}`)

  // Initialize Helios in background (non-blocking for UI)
  initHelios(url).catch((err) => {
    log('error', `helios init error: ${err.message}`)
  })

  return { ok: true }
})

ipcMain.handle('rpc:disconnectGateway', async () => {
  clearGateway()
  invalidateUsdcBalance()
  await shutdownHelios()
  log('info', 'gateway disconnected')
  return { ok: true }
})

ipcMain.handle('rpc:call', async (_event, method: string, params: unknown[]) => {
  return rpcCall(method, params ?? [])
})

ipcMain.handle('rpc:getBalances', async () => {
  return getBalances()
})

ipcMain.handle('rpc:sendToken', async (_event, symbol: string, to: string, amount: string) => {
  const txHash = await sendToken(symbol, to, amount)
  invalidateUsdcBalance()
  return { txHash }
})

// ---------------------------------------------------------------------------
// IPC: ambire-common controller bridge
// ---------------------------------------------------------------------------

ipcMain.handle('controller:getState', (_event, name: string) => {
  if (!ambireCtrl) return null
  const map: Record<string, unknown> = {
    main: ambireCtrl,
    keystore: ambireCtrl.keystore,
    accounts: ambireCtrl.accounts,
    networks: ambireCtrl.networks,
    selectedAccount: ambireCtrl.selectedAccount,
    portfolio: ambireCtrl.portfolio,
    activity: ambireCtrl.activity,
    transfer: ambireCtrl.transfer,
    accountPicker: ambireCtrl.accountPicker,
  }
  const ctrl = map[name] as { toJSON?: () => unknown } | undefined
  if (!ctrl) return null
  const state = ctrl.toJSON ? ctrl.toJSON() : ctrl
  return stringify(state)
})

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  // Start Tor (arti or external) before opening the window so the SOCKS port
  // is ready by the time the user connects to a gateway.
  console.log('[tor] starting...')
  try {
    const socksPort = await startTor()
    setSocksPort(socksPort)
    console.log(`[tor] ready on SOCKS port ${socksPort}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[tor] failed to start: ${msg}`)
    log('error', `[tor] failed to start: ${msg} — .onion gateways will not work`)
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  await shutdownHelios()
  await stopTor()
  if (process.platform !== 'darwin') app.quit()
})

// ---------------------------------------------------------------------------
// IPC: Tor status
// ---------------------------------------------------------------------------

ipcMain.handle('tor:getStatus', () => {
  const url = getGatewayUrl()
  const usingOnion = url !== null && new URL(url.endsWith('/') ? url : `${url}/`).hostname.endsWith('.onion')
  return {
    status: getTorStatus(),
    socksPort: getArtiSocksPort(),
    bootstrapPercent: getTorBootstrapPercent(),
    usingOnion,
  }
})

ipcMain.handle('helios:getStatus', () => ({
  status: getHeliosStatus(),
}))

ipcMain.handle('x402:getStatus', async () => {
  const url = getGatewayUrl()
  if (!url) return { connected: false, usdcBalance: null }
  if (!hasKey()) return { connected: true, usdcBalance: null }
  if (cachedUsdcBalance !== null) return { connected: true, usdcBalance: cachedUsdcBalance }
  // A fetch is already in-flight — return null for now rather than stacking
  // another eth_call into the queue. The next poll will pick up the cached value.
  if (usdcBalanceFetching) return { connected: true, usdcBalance: null }
  usdcBalanceFetching = true
  try {
    const account = loadKey()
    const balance = await getX402UsdcBalance(account.address as `0x${string}`)
    cachedUsdcBalance = balance
    return { connected: true, usdcBalance: balance }
  } catch {
    return { connected: true, usdcBalance: null }
  } finally {
    usdcBalanceFetching = false
  }
})

ipcMain.handle('network:getInfo', () => ({
  name: 'Base Sepolia',
  heliosStatus: getHeliosStatus(),
}))

// ---------------------------------------------------------------------------
// IPC: WalletConnect signing (signing stays in main; WalletKit runs in renderer)
// ---------------------------------------------------------------------------

ipcMain.handle('wc:signMessage', async (_, message: string) => {
  const account = loadKey()
  return account.signMessage({ message: { raw: message as `0x${string}` } })
})

ipcMain.handle('wc:signTypedData', async (_, raw: string) => {
  const account = loadKey()
  const { domain, types, primaryType, message } = JSON.parse(raw) as {
    domain: Record<string, unknown>
    types: Record<string, { name: string; type: string }[]>
    primaryType: string
    message: Record<string, unknown>
  }
  // viem's signTypedData rejects if EIP712Domain is included in types
  const { EIP712Domain: _eip712Domain, ...filteredTypes } = types
  return account.signTypedData({ domain, types: filteredTypes, primaryType, message })
})

ipcMain.handle('wc:sendTransaction', async (_, txParams: Record<string, string>) => {
  const account = loadKey()
  const [nonceRes, gasPriceRes, gasRes] = await Promise.all([
    txParams.nonce    ? Promise.resolve(null) : rpcCall('eth_getTransactionCount', [account.address, 'pending']),
    txParams.gasPrice ? Promise.resolve(null) : rpcCall('eth_gasPrice', []),
    txParams.gas      ? Promise.resolve(null) : rpcCall('eth_estimateGas', [txParams]),
  ])
  const pick = (provided: string | undefined, fetched: unknown): bigint =>
    BigInt(provided ?? (fetched as { result: string }).result)
  const signedTx = await account.signTransaction({
    type: 'legacy',
    chainId: 84532,
    to: txParams.to as `0x${string}`,
    value: BigInt(txParams.value ?? '0x0'),
    data: (txParams.data ?? '0x') as `0x${string}`,
    nonce:    txParams.nonce    ? parseInt(txParams.nonce, 16)   : Number((nonceRes as { result: string }).result),
    gasPrice: pick(txParams.gasPrice, gasPriceRes),
    gas:      pick(txParams.gas,      gasRes),
  })
  const result = await rpcCall('eth_sendRawTransaction', [signedTx]) as { result?: string; error?: { message: string } }
  if (result.error) throw new Error(result.error.message)
  return result.result as string
})
