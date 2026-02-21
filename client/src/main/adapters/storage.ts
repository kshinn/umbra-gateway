/**
 * storage.ts — Electron adapter for the ambire-common Storage interface.
 *
 * Uses electron-store (JSON file in userData) for general state.
 * Sensitive keys (keystore secrets, keys, seeds) are additionally encrypted
 * with Electron's safeStorage (OS keychain / credential manager).
 */

import { safeStorage } from 'electron'
import Store from 'electron-store'
import type { Storage } from '@ambire-common/interfaces/storage'
import { parse, stringify } from '@ambire-common/libs/richJson/richJson'

const store = new Store<Record<string, unknown>>({ name: 'ambire-state' })

// These keys contain private key material and must be encrypted at rest.
const ENCRYPTED_KEYS = new Set(['keystoreSecrets', 'keystoreKeys', 'keystoreSeeds'])

export const electronStorage: Storage = {
  async get(key?: string, defaultValue?: unknown): Promise<unknown> {
    if (!key) return defaultValue

    const raw = store.get(key)
    if (raw === undefined) return defaultValue

    try {
      // electron-store serializes Buffers to { type: 'Buffer', data: [...] } via JSON round-trip
      const buf = Buffer.isBuffer(raw)
        ? raw
        : raw !== null && typeof raw === 'object' && (raw as any).type === 'Buffer' && Array.isArray((raw as any).data)
          ? Buffer.from((raw as any).data)
          : null
      let result: unknown
      if (ENCRYPTED_KEYS.has(key) && buf) {
        result = parse(safeStorage.decryptString(buf))
      } else {
        result = typeof raw === 'string' ? parse(raw) : raw
      }
      // If the caller expects an array but got something else, fall back to the default
      if (Array.isArray(defaultValue) && !Array.isArray(result)) return defaultValue
      return result
    } catch {
      return defaultValue
    }
  },

  async set(key: string, value: unknown): Promise<null> {
    const serialized = stringify(value)
    if (ENCRYPTED_KEYS.has(key) && safeStorage.isEncryptionAvailable()) {
      store.set(key, safeStorage.encryptString(serialized))
    } else {
      store.set(key, serialized)
    }
    return null
  },

  async remove(key: string): Promise<null> {
    store.delete(key)
    return null
  },
}
