/**
 * torProcess.ts — Manages a bundled arti SOCKS5 proxy child process.
 *
 * Arti is the Tor Project's Rust implementation of Tor. We ship a pre-built
 * arti binary in resources/tor/<platform>/ and spawn it as a child process
 * when the app starts. All .onion traffic from gatewayFetch routes through
 * the SOCKS5 port arti opens.
 *
 * Flow:
 *   1. Check if an external Tor/arti is already on SOCKS_EXTERNAL_PORT (9050).
 *      If yes, use it directly — no spawn needed.
 *   2. Otherwise spawn the bundled arti binary on SOCKS_MANAGED_PORT (9150).
 *   3. Parse stdout for "Bootstrapped 100%" to know when circuits are ready.
 *   4. Expose the active SOCKS port via getArtiSocksPort().
 *   5. On app quit, kill the child process cleanly.
 */

import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import net from 'net'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { log } from './logger'

function torLog(direction: 'info' | 'error', message: string): void {
  console.log(`[tor] ${message}`)
  log(direction, message)
}

// Port used when an external Tor daemon is already running (e.g. Tor Browser).
const SOCKS_EXTERNAL_PORT = 9050
// Port we ask arti to listen on when we manage the process ourselves.
const SOCKS_MANAGED_PORT = 9150
// How long to wait for arti to bootstrap before giving up (ms).
const BOOTSTRAP_TIMEOUT_MS = 120_000

type TorStatus = 'stopped' | 'bootstrapping' | 'ready' | 'error'

let artiProcess: ChildProcess | null = null
let activeSocksPort: number | null = null
let status: TorStatus = 'stopped'
let bootstrapPercent = 0

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Start Tor (arti or external). Resolves with the active SOCKS port. */
export async function startTor(): Promise<number> {
  // 1. Check for an existing Tor on 9050 — if found, reuse it.
  if (await isPortOpen(SOCKS_EXTERNAL_PORT)) {
    torLog('info', `external Tor detected on port ${SOCKS_EXTERNAL_PORT} — reusing`)
    activeSocksPort = SOCKS_EXTERNAL_PORT
    status = 'ready'
    return SOCKS_EXTERNAL_PORT
  }

  // 2. Spawn bundled arti.
  return spawnArti()
}

/** Stop the managed arti process (no-op if using external Tor). */
export async function stopTor(): Promise<void> {
  if (!artiProcess) return
  torLog('info', 'stopping arti')
  artiProcess.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 3000)
    artiProcess!.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
  })
  artiProcess = null
  activeSocksPort = null
  status = 'stopped'
  bootstrapPercent = 0
}

/** The SOCKS5 port to use, or null if Tor is not ready. */
export function getArtiSocksPort(): number | null {
  return status === 'ready' ? activeSocksPort : null
}

export function getTorStatus(): TorStatus {
  return status
}

export function getTorBootstrapPercent(): number {
  return bootstrapPercent
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => { sock.destroy(); resolve(false) })
    sock.setTimeout(500, () => { sock.destroy(); resolve(false) })
  })
}

function artiDataDir(): string {
  const dir = join(app.getPath('userData'), 'arti-data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function artiBinaryPath(): string {
  const platform = process.platform
  const arch = process.arch
  const name = platform === 'win32' ? 'arti.exe' : 'arti'
  // In dev, __dirname is out/main/ — resources/ is two levels up at project root.
  // In prod, app.getPath('resources') is the packaged app's Resources folder.
  const resourcesRoot = is.dev
    ? join(__dirname, '../../resources')
    : app.getPath('resources')
  return join(resourcesRoot, 'tor', `${platform}-${arch}`, name)
}

/** Write a minimal arti TOML config and return the path. */
function writeArtiConfig(dataDir: string, socksPort: number): string {
  const configPath = join(dataDir, 'arti.toml')
  const config = `
[proxy]
socks_listen = "127.0.0.1:${socksPort}"

[storage]
cache_dir = "${dataDir}/cache"
state_dir = "${dataDir}/state"

[logging]
console = "info"
`.trimStart()
  writeFileSync(configPath, config, 'utf8')
  return configPath
}

function spawnArti(): Promise<number> {
  return new Promise((resolve, reject) => {
    const binPath = artiBinaryPath()

    if (!existsSync(binPath)) {
      const err = `arti binary not found at ${binPath}`
      torLog('error', err)
      status = 'error'
      return reject(new Error(err))
    }

    const dataDir = artiDataDir()
    const configPath = writeArtiConfig(dataDir, SOCKS_MANAGED_PORT)

    torLog('info', `spawning arti (port ${SOCKS_MANAGED_PORT})`)
    status = 'bootstrapping'
    bootstrapPercent = 0

    const proc = spawn(binPath, ['proxy', '--config', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    artiProcess = proc
    activeSocksPort = SOCKS_MANAGED_PORT

    const timeout = setTimeout(() => {
      torLog('error', 'bootstrap timed out')
      status = 'error'
      reject(new Error('arti bootstrap timed out'))
    }, BOOTSTRAP_TIMEOUT_MS)

    function onData(chunk: Buffer): void {
      const text = chunk.toString()

      // Arti signals readiness with: "Sufficiently bootstrapped; proxy now functional."
      if (text.includes('Sufficiently bootstrapped')) {
        clearTimeout(timeout)
        bootstrapPercent = 100
        status = 'ready'
        torLog('info', `ready — SOCKS5 on port ${SOCKS_MANAGED_PORT}`)
        resolve(SOCKS_MANAGED_PORT)
        return
      }

      // These are normal Tor network maintenance messages — routine circuit
      // lifecycle, guard quality scoring, and preemptive HS circuit building.
      // They appear constantly and obscure wallet traffic in the console.
      const isBackgroundNoise =
        text.includes('Questionable guard') ||
        text.includes('circuits died under mysterious circumstances') ||
        text.includes('Too many preemptive onion service circuits') ||
        text.includes('tor_circmgr') ||
        text.includes('tor_guardmgr') ||
        text.includes('hspool') ||
        text.includes('connection exited with error')

      if (!isBackgroundNoise) {
        process.stdout.write(`[tor] ${text}`)
      }

      // Surface real errors (not routine WARNs) to the activity log.
      if (text.includes('ERROR') || text.includes('FATAL')) {
        torLog('error', text.trim())
      }
    }

    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)

    proc.on('error', (err) => {
      clearTimeout(timeout)
      torLog('error', `process error: ${err.message}`)
      status = 'error'
      reject(err)
    })

    proc.on('exit', (code, signal) => {
      if (status !== 'stopped') {
        torLog('error', `arti exited unexpectedly (code=${code} signal=${signal})`)
        status = 'error'
        artiProcess = null
        activeSocksPort = null
      }
    })
  })
}
