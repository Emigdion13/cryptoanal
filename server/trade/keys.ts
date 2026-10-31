/**
 * Which Kalshi keys the trading engine signs with, and whether real-money orders are on.
 *
 * cryptoanal's own settings file (`kalshi.json` next to the workspace) holds key ids and the PATHS
 * of the private key files, never a key itself. An environment without a key there uses the one
 * btcAnalyzerV2 already set up (`~/.atlas/kalshi-keys.json`), so nothing has to be entered twice.
 * Real-money orders are cryptoanal's own switch, off until turned on in ⚙ on the computer.
 */
import { createPrivateKey, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { TradeEnv } from '../../src/trade/kalshiTrade'

export interface TradeCredentials {
  keyId: string
  key: KeyObject
}

interface StoredKey {
  keyId: string
  path: string
}

interface KeysFile {
  version: 1
  demo: StoredKey | null
  live: StoredKey | null
  liveTrading: boolean
}

/** One environment's key as ⚙ shows it. The private key never leaves the server. */
export interface KeyStatus {
  keyId: string
  path: string
  /** Saved here, borrowed from btcAnalyzerV2's settings, or not set. */
  source: 'settings' | 'btcAnalyzerV2' | null
  error: string | null
}

export interface KeysView {
  file: string
  demo: KeyStatus
  live: KeyStatus
  liveTrading: boolean
}

export interface ResolvedKeys {
  demo: TradeCredentials | null
  live: TradeCredentials | null
  liveEnabled: boolean
  view: KeysView
}

const EMPTY: KeysFile = { version: 1, demo: null, live: null, liveTrading: false }
const KEY_FILE_LIMIT = 64 * 1024

export class KeyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** A path as people paste it: quotes around it, `~` for the home folder. */
export function expandPath(raw: string, home = homedir()): string {
  let path = raw.trim()
  if (path.length >= 2 && /^(["']).*\1$/.test(path)) path = path.slice(1, -1).trim()
  if (path === '~') return home
  if (path.startsWith('~/')) path = join(home, path.slice(2))
  return resolve(path)
}

/** The private key in the file at `path`, checked to be one Kalshi can use; or why not. */
export function readPrivateKey(path: string): { key: KeyObject } | { error: string } {
  const file = expandPath(path)
  let text: string
  try {
    const buffer = readFileSync(file)
    if (buffer.length > KEY_FILE_LIMIT) return { error: `${file} is too big to be a private key file.` }
    text = buffer.toString('utf8').trim()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { error: `There is no file at ${file}.` }
    if (code === 'EACCES' || code === 'EPERM') return { error: `The app is not allowed to read ${file}.` }
    return { error: `Could not read ${file}.` }
  }
  let key: KeyObject
  try {
    key = createPrivateKey(text)
  } catch {
    return { error: `${file} is not a private key. Use the file Kalshi gave you when you made the key.` }
  }
  const type = key.asymmetricKeyType
  if (type !== 'ed25519' && type !== 'rsa' && type !== 'rsa-pss') return { error: `${file} holds a ${type ?? 'unknown'} key; Kalshi keys are Ed25519 or RSA.` }
  return { key }
}

const isStoredKey = (value: unknown): value is StoredKey =>
  !!value && typeof value === 'object' && typeof (value as StoredKey).keyId === 'string' && typeof (value as StoredKey).path === 'string'

function readKeysFile(file: string): KeysFile {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<KeysFile>
    return {
      version: 1,
      demo: isStoredKey(parsed.demo) ? parsed.demo : null,
      live: isStoredKey(parsed.live) ? parsed.live : null,
      liveTrading: parsed.liveTrading === true,
    }
  } catch {
    return { ...EMPTY }
  }
}

export class KalshiKeyStore {
  constructor(
    readonly file: string,
    /** btcAnalyzerV2's key settings, borrowed for an environment this file has no key for. */
    private readonly v2File = join(homedir(), '.atlas', 'kalshi-keys.json'),
  ) {}

  private async write(data: KeysFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.file)
    await chmod(this.file, 0o600).catch(() => undefined)
  }

  resolve(): ResolvedKeys {
    const own = readKeysFile(this.file)
    const v2 = readKeysFile(this.v2File)
    const one = (env: TradeEnv): { creds: TradeCredentials | null; status: KeyStatus } => {
      const stored = own[env] ?? v2[env]
      if (!stored) return { creds: null, status: { keyId: '', path: '', source: null, error: null } }
      const key = readPrivateKey(stored.path)
      return {
        creds: 'key' in key ? { keyId: stored.keyId, key: key.key } : null,
        status: { keyId: stored.keyId, path: stored.path, source: own[env] ? 'settings' : 'btcAnalyzerV2', error: 'error' in key ? key.error : null },
      }
    }
    const demo = one('demo')
    const live = one('live')
    const liveEnabled = own.liveTrading && live.creds !== null
    return { demo: demo.creds, live: live.creds, liveEnabled, view: { file: this.file, demo: demo.status, live: live.status, liveTrading: liveEnabled } }
  }

  /** Save one environment's key id and key file path; refuses a key file that does not work. */
  async saveKey(env: TradeEnv, keyId: unknown, path: unknown): Promise<ResolvedKeys> {
    if (typeof keyId !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(keyId.trim())) throw new KeyError(400, 'Paste the key id Kalshi shows next to the key.')
    if (typeof path !== 'string' || !path.trim()) throw new KeyError(400, 'Type where the private key file is.')
    const key = readPrivateKey(path)
    if ('error' in key) throw new KeyError(400, key.error)
    const data = readKeysFile(this.file)
    data[env] = { keyId: keyId.trim(), path: path.trim() }
    await this.write(data)
    return this.resolve()
  }

  /** Forget one environment's own key (btcAnalyzerV2's, if any, applies again). */
  async clearKey(env: TradeEnv): Promise<ResolvedKeys> {
    const data = readKeysFile(this.file)
    data[env] = null
    if (env === 'live') data.liveTrading = false
    await this.write(data)
    return this.resolve()
  }

  /** Real-money orders on or off. On needs a working live key. */
  async setLiveTrading(on: boolean): Promise<ResolvedKeys> {
    if (on && !this.resolve().live) throw new KeyError(409, 'Add a working live key first.')
    const data = readKeysFile(this.file)
    data.liveTrading = on
    await this.write(data)
    return this.resolve()
  }
}
