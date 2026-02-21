import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { privateKeyToAccount } from 'viem/accounts'
import type { PrivateKeyAccount } from 'viem/accounts'
import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from 'bip39'
import { HDNodeWallet } from 'ethers'

const HD_PATH = "m/44'/60'/0'/0/0"

function keystorePath(): string {
  return join(app.getPath('userData'), 'keystore.bin')
}

/**
 * Validate and normalize a private key hex string.
 * Accepts with or without 0x prefix.
 */
function normalizeKey(raw: string): `0x${string}` {
  const hex = raw.startsWith('0x') ? raw : `0x${raw}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('Invalid private key: must be 32 bytes (64 hex chars)')
  }
  return hex as `0x${string}`
}

/**
 * Encrypt and persist a private key using OS-level safeStorage.
 * Replaces any existing keystore.
 */
export function importKey(rawHex: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS safeStorage encryption is not available on this system')
  }
  const hex = normalizeKey(rawHex)
  // Verify the key is valid before storing it
  privateKeyToAccount(hex)
  const encrypted = safeStorage.encryptString(hex)
  writeFileSync(keystorePath(), encrypted)
}

/**
 * Load and decrypt the stored private key, returning a viem account.
 */
export function loadKey(): PrivateKeyAccount {
  if (!hasKey()) {
    throw new Error('No key stored. Import a private key first.')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS safeStorage encryption is not available on this system')
  }
  const encrypted = readFileSync(keystorePath())
  const hex = safeStorage.decryptString(encrypted) as `0x${string}`
  return privateKeyToAccount(hex)
}

/**
 * Returns true if a keystore file exists.
 */
export function hasKey(): boolean {
  return existsSync(keystorePath())
}

/**
 * Generate a new BIP39 mnemonic, derive the first Ethereum key, store it,
 * and return the mnemonic + address so the renderer can display it.
 */
export function generateAccount(): { mnemonic: string; address: string } {
  const mnemonic = generateMnemonic()
  const seed = mnemonicToSeedSync(mnemonic)
  const root = HDNodeWallet.fromSeed(seed)
  const child = root.derivePath(HD_PATH)
  const privateKeyHex = child.privateKey as `0x${string}`
  importKey(privateKeyHex)
  const account = privateKeyToAccount(privateKeyHex)
  return { mnemonic, address: account.address }
}

/**
 * Derive the first Ethereum private key from a BIP39 mnemonic and store it.
 */
export function importFromMnemonic(phrase: string): void {
  const normalized = phrase.trim().replace(/\s+/g, ' ')
  if (!validateMnemonic(normalized)) {
    throw new Error('Invalid seed phrase. Check each word and try again.')
  }
  const seed = mnemonicToSeedSync(normalized)
  const root = HDNodeWallet.fromSeed(seed)
  const child = root.derivePath(HD_PATH)
  importKey(child.privateKey as `0x${string}`)
}

/**
 * Delete the keystore file (irreversible without a backup).
 */
export function clearKey(): void {
  const path = keystorePath()
  if (existsSync(path)) {
    unlinkSync(path)
  }
}
