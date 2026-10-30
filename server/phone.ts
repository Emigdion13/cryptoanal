/**
 * The iPhone page (phone.html) over Tailscale, as btcAnalyzerV2 does it (its docs/kalshi-phone.md).
 *
 * `tailscale serve` on this computer publishes the app at https://<computer>.<tailnet>.ts.net:<port>
 * to the owner's own devices only, proxying to http://127.0.0.1:5190. Those requests reach this
 * server from loopback, like the computer's own, so they are told apart by what the proxy adds (a
 * `*.ts.net` host, `X-Forwarded-*`, `Tailscale-User-*`) and must then carry a phone session: a
 * cookie given for the passcode or for Face ID (a passkey made on the phone, WebAuthn).
 *
 * Off until turned on in ⚙ → Phone access on the computer, where the passcode is set too. A phone
 * may only read: every /api/ request through the proxy needs a session and is refused unless it is
 * a GET, so it never changes the workspace. Five wrong passcodes lock it for 15 minutes. Kept in
 * `phone.json` next to the workspace file: the passcode as a scrypt hash, sessions as SHA-256 of
 * their tokens, passkeys as public keys only.
 */
import { createHash, createPublicKey, randomBytes, scryptSync, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'
import { header, isLoopback, isProxied, requestHost } from './proxy'
import { workspaceFile } from './workspace'

export const PHONE_COOKIE = 'cryptoanal_phone'
/** A phone stays signed in this long ("remember this phone"). */
export const PHONE_SESSION_MS = 30 * 24 * 3_600_000
export const PHONE_MAX_TRIES = 5
export const PHONE_LOCK_MS = 15 * 60_000
/** The header the pages send on every POST: a cross-site form can't, and a cross-site fetch needs a preflight this server never grants. */
export const PHONE_HEADER = 'x-cryptoanal-phone'
const CHALLENGE_MS = 2 * 60_000
const BODY_LIMIT = 64 * 1024
const PASSKEY_USER_ID = createHash('sha256').update('cryptoanal-phone').digest().subarray(0, 16)

export class PhoneError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

interface PhoneSession {
  /** SHA-256 of the cookie's token, base64url. */
  id: string
  created: number
  expires: number
  via: 'passcode' | 'passkey'
}

interface Passkey {
  /** The credential id, base64url. */
  id: string
  /** The address it was made for (its WebAuthn relying party). */
  host: string
  jwk: JsonWebKey
  counter: number
  created: number
}

interface PhoneFile {
  enabled: boolean
  passcode: { salt: string; hash: string } | null
  sessions: PhoneSession[]
  passkeys: Passkey[]
}

/** What the desktop's Phone access dialog shows. */
export interface PhoneView {
  enabled: boolean
  passcodeSet: boolean
  sessions: number
  passkeys: number
}

const b64 = (bytes: Buffer | Uint8Array) => Buffer.from(bytes).toString('base64url')
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest()

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Whether an Origin is the phone page's own: https at the phone's address. The port is not
 * compared: Tailscale may serve on 443 or another port and not pass it on, and both are this
 * computer's page on the owner's own network.
 */
export function isPhoneOrigin(origin: unknown, host: string): boolean {
  if (typeof origin !== 'string') return false
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' && url.hostname === host && url.origin === origin
  } catch {
    return false
  }
}

/**
 * The computer's own browser only: loopback, no proxy, a local Host (defeats DNS rebinding), and
 * for a POST its own Origin and the app's header (defeats another site's page posting).
 */
export function guardLocal(req: IncomingMessage): void {
  if (!isLoopback(req) || isProxied(req)) throw new PhoneError(403, 'Only this computer can change phone access.', 'NOT_LOCAL')
  const host = header(req, 'host')
  if (!LOCAL_HOSTS.has(requestHost(req))) throw new PhoneError(403, 'Open the app at localhost.', 'BAD_HOST')
  const origin = header(req, 'origin')
  if (origin) {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = ''
    }
    if (originHost !== host) throw new PhoneError(403, 'Changes must come from this app.', 'BAD_ORIGIN')
  }
  if (req.method === 'POST') {
    if (!origin || header(req, PHONE_HEADER) !== '1') throw new PhoneError(403, 'Changes must come from this app.', 'BAD_ORIGIN')
    if (!header(req, 'content-type').includes('application/json')) throw new PhoneError(415, 'Send JSON.', 'BAD_BODY')
  }
}

function cookieToken(req: IncomingMessage): string | null {
  for (const part of header(req, 'cookie').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === PHONE_COOKIE) return rest.join('=') || null
  }
  return null
}

/** A minimal CBOR reader, enough for WebAuthn's attestation object and COSE keys. */
function cborItem(b: Buffer, at: number): [unknown, number] {
  const fail = () => new PhoneError(400, 'The passkey data could not be read.', 'BAD_PASSKEY')
  if (at >= b.length) throw fail()
  const major = b[at] >> 5
  const info = b[at] & 31
  at += 1
  let n: number
  if (info < 24) n = info
  else if (info === 24) n = b.readUInt8(at++)
  else if (info === 25) {
    n = b.readUInt16BE(at)
    at += 2
  } else if (info === 26) {
    n = b.readUInt32BE(at)
    at += 4
  } else throw fail()
  if (major === 0) return [n, at]
  if (major === 1) return [-1 - n, at]
  if (major === 2 || major === 3) {
    if (at + n > b.length) throw fail()
    const slice = b.subarray(at, at + n)
    return [major === 2 ? Buffer.from(slice) : slice.toString('utf8'), at + n]
  }
  if (major === 4) {
    const out: unknown[] = []
    for (let i = 0; i < n; i++) {
      const [value, next] = cborItem(b, at)
      out.push(value)
      at = next
    }
    return [out, at]
  }
  if (major === 5) {
    const out = new Map<unknown, unknown>()
    for (let i = 0; i < n; i++) {
      const [key, a] = cborItem(b, at)
      const [value, next] = cborItem(b, a)
      out.set(key, value)
      at = next
    }
    return [out, at]
  }
  if (major === 7 && info < 24) return [n === 21 ? true : n === 20 ? false : null, at]
  throw fail()
}

/** WebAuthn authenticator data: who it is for, what was checked, and the new key when made. */
function parseAuthData(data: Buffer) {
  if (data.length < 37) throw new PhoneError(400, 'The passkey data is too short.', 'BAD_PASSKEY')
  const flags = data[32]
  const parsed = {
    rpIdHash: data.subarray(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    counter: data.readUInt32BE(33),
    credentialId: null as Buffer | null,
    cose: null as Map<unknown, unknown> | null,
  }
  if (flags & 0x40) {
    const length = data.readUInt16BE(53)
    parsed.credentialId = Buffer.from(data.subarray(55, 55 + length))
    const [cose] = cborItem(data, 55 + length)
    if (!(cose instanceof Map)) throw new PhoneError(400, 'The passkey has no key.', 'BAD_PASSKEY')
    parsed.cose = cose
  }
  return parsed
}

/** A COSE ES256 key (the kind iPhones make) as a JWK. */
function coseToJwk(cose: Map<unknown, unknown>): JsonWebKey {
  const x = cose.get(-2)
  const y = cose.get(-3)
  if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1)
    throw new PhoneError(400, 'Only ES256 passkeys are supported.', 'BAD_PASSKEY')
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32)
    throw new PhoneError(400, 'The passkey key is malformed.', 'BAD_PASSKEY')
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64(x), y: b64(y) }
  createPublicKey({ key: jwk, format: 'jwk' })
  return jwk
}

export class PhoneAccess {
  private tries = { count: 0, lockedUntil: 0 }
  private challenges: { value: string; host: string; kind: 'create' | 'get'; expires: number }[] = []

  constructor(
    readonly file: string,
    private now: () => number = Date.now,
  ) {}

  private read(): PhoneFile {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PhoneFile>
      return {
        enabled: raw.enabled === true,
        passcode:
          raw.passcode && typeof raw.passcode.salt === 'string' && typeof raw.passcode.hash === 'string' ? raw.passcode : null,
        sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
        passkeys: Array.isArray(raw.passkeys) ? raw.passkeys : [],
      }
    } catch {
      return { enabled: false, passcode: null, sessions: [], passkeys: [] }
    }
  }

  private write(data: PhoneFile): void {
    const now = this.now()
    data.sessions = data.sessions.filter((s) => s.expires > now)
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.file)
    try {
      chmodSync(this.file, 0o600)
    } catch {
      // Windows keeps its own permissions.
    }
  }

  view(): PhoneView {
    const data = this.read()
    const now = this.now()
    return {
      enabled: data.enabled,
      passcodeSet: data.passcode !== null,
      sessions: data.sessions.filter((s) => s.expires > now).length,
      passkeys: data.passkeys.length,
    }
  }

  setEnabled(on: boolean): PhoneView {
    const data = this.read()
    if (on && !data.passcode) throw new PhoneError(409, 'Set a 6-digit passcode first.', 'NO_PASSCODE')
    data.enabled = on
    this.write(data)
    return this.view()
  }

  /** A new passcode signs every phone out; Face ID stays (it is tied to the phone, not the code). */
  setPasscode(code: unknown): PhoneView {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new PhoneError(400, 'The passcode is 6 digits.', 'BAD_PASSCODE')
    const data = this.read()
    const salt = randomBytes(16)
    data.passcode = { salt: b64(salt), hash: b64(scryptSync(code, salt, 32)) }
    data.sessions = []
    this.write(data)
    this.tries = { count: 0, lockedUntil: 0 }
    return this.view()
  }

  /** Signs every phone out and forgets their Face ID passkeys. */
  signOutAll(): PhoneView {
    const data = this.read()
    data.sessions = []
    data.passkeys = []
    this.write(data)
    return this.view()
  }

  /**
   * The phone's address when `req` is a phone request: proxied by Tailscale from this computer's
   * loopback to a `*.ts.net` name. Null for this computer's own browser. Throws for a request that
   * carries proxy headers but did not come through the local proxy (something on the network
   * pretending to be Tailscale).
   */
  phoneHost(req: IncomingMessage): string | null {
    if (!isProxied(req)) return null
    if (!isLoopback(req)) throw new PhoneError(403, 'Phones connect through Tailscale only.', 'NOT_TAILSCALE')
    const host = requestHost(req)
    if (!host.endsWith('.ts.net')) throw new PhoneError(403, 'Open the phone page at its .ts.net address.', 'BAD_HOST')
    return host
  }

  /**
   * Everything a phone request must have: phone access on, the page's own origin, the page's
   * header on POSTs, and (unless `session` is false) a signed-in session. Answers the phone's address.
   */
  guard(req: IncomingMessage, { session = true }: { session?: boolean } = {}): string {
    const host = this.phoneHost(req)
    if (host === null) throw new PhoneError(403, 'Not a phone request.', 'NOT_PHONE')
    const data = this.read()
    if (!data.enabled) throw new PhoneError(403, 'Phone access is off. Turn it on in ⚙ → Phone access on the computer.', 'PHONE_OFF')
    const origin = header(req, 'origin')
    if (origin && !isPhoneOrigin(origin, host)) throw new PhoneError(403, 'Requests must come from the phone page.', 'BAD_ORIGIN')
    if (req.method === 'POST') {
      if (!origin || header(req, PHONE_HEADER) !== '1') throw new PhoneError(403, 'Requests must come from the phone page.', 'BAD_ORIGIN')
      if (!header(req, 'content-type').includes('application/json')) throw new PhoneError(415, 'Send JSON.', 'BAD_BODY')
    }
    if (session && !this.sessionOf(req, data)) throw new PhoneError(401, 'Sign in on the phone first.', 'SIGNED_OUT')
    return host
  }

  private sessionOf(req: IncomingMessage, data = this.read()): PhoneSession | null {
    const token = cookieToken(req)
    if (!token) return null
    const id = b64(sha256(token))
    return data.sessions.find((s) => s.id === id && s.expires > this.now()) ?? null
  }

  signedIn(req: IncomingMessage): boolean {
    return this.sessionOf(req) !== null
  }

  /** How many Face ID passkeys this phone address has. */
  passkeysFor(host: string): number {
    return this.read().passkeys.filter((p) => p.host === host).length
  }

  private newSession(via: PhoneSession['via']): string {
    const data = this.read()
    const token = b64(randomBytes(32))
    data.sessions.push({ id: b64(sha256(token)), created: this.now(), expires: this.now() + PHONE_SESSION_MS, via })
    this.write(data)
    return token
  }

  /** The Set-Cookie value for a session token (Tailscale serves HTTPS, so Secure works). */
  cookie(token: string | null): string {
    return token
      ? `${PHONE_COOKIE}=${token}; Path=/; Max-Age=${PHONE_SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`
      : `${PHONE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
  }

  /** The passcode: a session token, or why not (a wrong code, or locked after five). */
  login(code: unknown): string {
    const now = this.now()
    if (this.tries.lockedUntil > now) {
      const minutes = Math.ceil((this.tries.lockedUntil - now) / 60_000)
      throw new PhoneError(429, `Too many wrong passcodes. Locked for ${minutes} more minute${minutes === 1 ? '' : 's'}.`, 'LOCKED')
    }
    const data = this.read()
    if (!data.passcode) throw new PhoneError(409, 'No passcode is set on the computer.', 'NO_PASSCODE')
    const given =
      typeof code === 'string' && /^\d{6}$/.test(code)
        ? scryptSync(code, Buffer.from(data.passcode.salt, 'base64url'), 32)
        : randomBytes(32)
    if (!timingSafeEqual(given, Buffer.from(data.passcode.hash, 'base64url'))) {
      this.tries.count += 1
      if (this.tries.count >= PHONE_MAX_TRIES) {
        this.tries = { count: 0, lockedUntil: now + PHONE_LOCK_MS }
        throw new PhoneError(429, 'Too many wrong passcodes. Locked for 15 minutes.', 'LOCKED')
      }
      const left = PHONE_MAX_TRIES - this.tries.count
      throw new PhoneError(401, `Wrong passcode. ${left} ${left === 1 ? 'try' : 'tries'} left.`, 'WRONG_PASSCODE')
    }
    this.tries = { count: 0, lockedUntil: 0 }
    return this.newSession('passcode')
  }

  logout(req: IncomingMessage): void {
    const token = cookieToken(req)
    if (!token) return
    const data = this.read()
    const id = b64(sha256(token))
    data.sessions = data.sessions.filter((s) => s.id !== id)
    this.write(data)
  }

  private challenge(host: string, kind: 'create' | 'get'): string {
    const now = this.now()
    this.challenges = this.challenges.filter((c) => c.expires > now).slice(-20)
    const value = b64(randomBytes(32))
    this.challenges.push({ value, host, kind, expires: now + CHALLENGE_MS })
    return value
  }

  private takeChallenge(value: unknown, host: string, kind: 'create' | 'get'): void {
    const now = this.now()
    const index = this.challenges.findIndex((c) => c.value === value && c.host === host && c.kind === kind && c.expires > now)
    if (index < 0) throw new PhoneError(400, 'The Face ID request expired. Try again.', 'BAD_CHALLENGE')
    this.challenges.splice(index, 1)
  }

  /** Options for `navigator.credentials.create`: a Face ID passkey for this phone address. */
  passkeyCreateOptions(host: string) {
    return {
      challenge: this.challenge(host, 'create'),
      rp: { id: host, name: 'CryptoAnal' },
      user: { id: b64(PASSKEY_USER_ID), name: 'CryptoAnal phone', displayName: 'CryptoAnal phone' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
      attestation: 'none',
      timeout: 60_000,
      excludeCredentials: this.read()
        .passkeys.filter((p) => p.host === host)
        .map((p) => ({ type: 'public-key', id: p.id })),
    }
  }

  /** Options for `navigator.credentials.get`, or null when this address has no passkey yet. */
  passkeyGetOptions(host: string) {
    const keys = this.read().passkeys.filter((p) => p.host === host)
    if (!keys.length) return null
    return {
      challenge: this.challenge(host, 'get'),
      rpId: host,
      allowCredentials: keys.map((p) => ({ type: 'public-key', id: p.id })),
      userVerification: 'required',
      timeout: 60_000,
    }
  }

  private clientData(raw: unknown, host: string, kind: 'create' | 'get'): Buffer {
    if (typeof raw !== 'string') throw new PhoneError(400, 'Missing Face ID data.', 'BAD_PASSKEY')
    const bytes = Buffer.from(raw, 'base64url')
    let data: { type?: unknown; challenge?: unknown; origin?: unknown }
    try {
      data = JSON.parse(bytes.toString('utf8')) as typeof data
    } catch {
      throw new PhoneError(400, 'The Face ID data could not be read.', 'BAD_PASSKEY')
    }
    if (data.type !== (kind === 'create' ? 'webauthn.create' : 'webauthn.get'))
      throw new PhoneError(400, 'Wrong kind of Face ID answer.', 'BAD_PASSKEY')
    if (!isPhoneOrigin(data.origin, host)) throw new PhoneError(403, 'The Face ID answer is for another address.', 'BAD_PASSKEY')
    this.takeChallenge(data.challenge, host, kind)
    return bytes
  }

  /** Saves the passkey the phone just made (the phone is already signed in with the passcode). */
  passkeyCreate(host: string, body: Record<string, unknown>): PhoneView {
    this.clientData(body.clientDataJSON, host, 'create')
    if (typeof body.attestationObject !== 'string' || typeof body.id !== 'string')
      throw new PhoneError(400, 'Missing Face ID data.', 'BAD_PASSKEY')
    const [attestation] = cborItem(Buffer.from(body.attestationObject, 'base64url'), 0)
    const authData = attestation instanceof Map ? attestation.get('authData') : null
    if (!Buffer.isBuffer(authData)) throw new PhoneError(400, 'The passkey data could not be read.', 'BAD_PASSKEY')
    const auth = parseAuthData(authData)
    if (!auth.rpIdHash.equals(sha256(host))) throw new PhoneError(403, 'The passkey is for another address.', 'BAD_PASSKEY')
    if (!auth.userPresent || !auth.userVerified) throw new PhoneError(403, 'Face ID did not confirm it was you.', 'BAD_PASSKEY')
    if (!auth.credentialId || !auth.cose || b64(auth.credentialId) !== body.id)
      throw new PhoneError(400, 'The passkey data does not match.', 'BAD_PASSKEY')
    const jwk = coseToJwk(auth.cose)
    const data = this.read()
    data.passkeys = data.passkeys.filter((p) => p.id !== body.id)
    data.passkeys.push({ id: body.id, host, jwk, counter: auth.counter, created: this.now() })
    this.write(data)
    return this.view()
  }

  /** Face ID sign-in: a session token when the phone's passkey signed this server's challenge. */
  passkeyGet(host: string, body: Record<string, unknown>): string {
    const clientData = this.clientData(body.clientDataJSON, host, 'get')
    if (typeof body.id !== 'string' || typeof body.authenticatorData !== 'string' || typeof body.signature !== 'string')
      throw new PhoneError(400, 'Missing Face ID data.', 'BAD_PASSKEY')
    const data = this.read()
    const key = data.passkeys.find((p) => p.id === body.id && p.host === host)
    if (!key) throw new PhoneError(401, 'This Face ID is not known here. Use the passcode.', 'UNKNOWN_PASSKEY')
    const authData = Buffer.from(body.authenticatorData, 'base64url')
    const auth = parseAuthData(authData)
    if (!auth.rpIdHash.equals(sha256(host))) throw new PhoneError(403, 'The passkey is for another address.', 'BAD_PASSKEY')
    if (!auth.userPresent || !auth.userVerified) throw new PhoneError(403, 'Face ID did not confirm it was you.', 'BAD_PASSKEY')
    // Synced passkeys always count 0; a counter that goes back means a copied key.
    if ((auth.counter !== 0 || key.counter !== 0) && auth.counter <= key.counter)
      throw new PhoneError(403, 'This passkey looks copied. Sign in with the passcode.', 'BAD_PASSKEY')
    const ok = verify(
      'sha256',
      Buffer.concat([authData, sha256(clientData)]),
      createPublicKey({ key: key.jwk, format: 'jwk' }),
      Buffer.from(body.signature, 'base64url'),
    )
    if (!ok) throw new PhoneError(401, 'Face ID did not check out. Use the passcode.', 'BAD_PASSKEY')
    key.counter = auth.counter
    this.write(data)
    return this.newSession('passkey')
  }
}

/** Where Tailscale's command line usually is, per system. */
const TAILSCALE_CLI = ['tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']

async function tailscaleJson(args: string[]): Promise<unknown> {
  for (const cli of TAILSCALE_CLI) {
    const out = await new Promise<string | null>((resolve) =>
      execFile(cli, args, { timeout: 4_000, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout)),
    )
    if (out === null) continue
    try {
      return JSON.parse(out)
    } catch {
      return null
    }
  }
  return null
}

/**
 * The phone page's address: the https://… that `tailscale serve` proxies to this server's port,
 * or, when nothing is served to it yet, null with this computer's Tailscale name (null too when
 * Tailscale isn't installed, running or signed in).
 */
export async function tailscaleAddress(port: number): Promise<{ name: string | null; url: string | null }> {
  const status = (await tailscaleJson(['status', '--json'])) as { Self?: { DNSName?: unknown } } | null
  const dns = status?.Self?.DNSName
  const name = typeof dns === 'string' && dns ? dns.replace(/\.$/, '') : null
  if (!name) return { name: null, url: null }
  const serve = (await tailscaleJson(['serve', 'status', '--json'])) as {
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
  } | null
  for (const [hostPort, web] of Object.entries(serve?.Web ?? {})) {
    const proxy = web.Handlers?.['/']?.Proxy ?? ''
    if (!new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost)?:?${port}$`).test(proxy.replace(/\/$/, ''))) continue
    const servedPort = hostPort.split(':').pop()
    return { name, url: `https://${name}${servedPort && servedPort !== '443' ? `:${servedPort}` : ''}/phone.html` }
  }
  return { name, url: null }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > BODY_LIMIT) throw new PhoneError(413, 'Request too large.', 'BAD_BODY')
    chunks.push(chunk as Buffer)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    throw new PhoneError(400, 'Request is not valid JSON.', 'BAD_BODY')
  }
}

/**
 * `/api/phone/*` (the phone's sign-in, and the computer's Phone access settings), and the gate in
 * front of everything else for requests through Tailscale: the desktop page sends them to
 * phone.html, and any other /api/ request needs a signed-in phone and is read-only.
 */
export function createPhoneApi(
  phone = new PhoneAccess(join(dirname(workspaceFile()), 'phone.json')),
  port = () => 5190,
  log: (line: string) => void = (line) => console.log(line),
) {
  const json = (res: ServerResponse, status: number, value: unknown) => {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(JSON.stringify(value))
  }

  const settings = async (req: IncomingMessage, res: ServerResponse) => {
    guardLocal(req)
    if (req.method === 'POST') {
      const body = await readJson(req)
      if (body.passcode !== undefined) {
        phone.setPasscode(body.passcode)
        log('[phone] passcode changed; phones signed out')
      }
      if (body.signOutAll === true) {
        phone.signOutAll()
        log('[phone] all phones signed out, Face ID forgotten')
      }
      if (typeof body.enabled === 'boolean') {
        phone.setEnabled(body.enabled)
        log(`[phone] phone access ${body.enabled ? 'ON' : 'off'}`)
      }
    } else if (req.method !== 'GET') throw new PhoneError(405, 'Use GET or POST.', 'METHOD')
    json(res, 200, { ...phone.view(), ...(await tailscaleAddress(port())), port: port() })
  }

  const dispatch = async (req: IncomingMessage, res: ServerResponse, route: string) => {
    if (route === 'settings') return settings(req, res)
    // phone.html opened on this computer itself: already trusted, no sign-in.
    if (route === 'session' && phone.phoneHost(req) === null) {
      guardLocal(req)
      return json(res, 200, { host: 'this computer', signedIn: true, passkeys: 0, local: true })
    }
    const host = phone.guard(req, { session: false })
    const who = header(req, 'tailscale-user-login') || 'a phone'
    if (route === 'session') {
      if (req.method !== 'GET') throw new PhoneError(405, 'Use GET.', 'METHOD')
      return json(res, 200, { host, signedIn: phone.signedIn(req), passkeys: phone.passkeysFor(host) })
    }
    if (req.method !== 'POST') throw new PhoneError(405, 'Use POST.', 'METHOD')
    const body = await readJson(req)
    if (route === 'login') {
      try {
        res.setHeader('Set-Cookie', phone.cookie(phone.login(body.passcode)))
      } catch (error) {
        log(`[phone] passcode refused for ${who} at ${host}`)
        throw error
      }
      log(`[phone] ${who} signed in with the passcode at ${host}`)
      return json(res, 200, { ok: true })
    }
    if (route === 'logout') {
      phone.logout(req)
      res.setHeader('Set-Cookie', phone.cookie(null))
      return json(res, 200, { ok: true })
    }
    if (route === 'passkey/create-options') {
      phone.guard(req)
      return json(res, 200, phone.passkeyCreateOptions(host))
    }
    if (route === 'passkey/create') {
      phone.guard(req)
      phone.passkeyCreate(host, body)
      log(`[phone] Face ID set up for ${who} at ${host}`)
      return json(res, 200, { ok: true, passkeys: phone.passkeysFor(host) })
    }
    if (route === 'passkey/get-options') {
      const options = phone.passkeyGetOptions(host)
      if (!options) throw new PhoneError(404, 'Face ID is not set up for this address.', 'NO_PASSKEY')
      return json(res, 200, options)
    }
    if (route === 'passkey/get') {
      res.setHeader('Set-Cookie', phone.cookie(phone.passkeyGet(host, body)))
      log(`[phone] ${who} signed in with Face ID at ${host}`)
      return json(res, 200, { ok: true })
    }
    throw new PhoneError(404, 'Not found.', 'NOT_FOUND')
  }

  const fail = (res: ServerResponse, error: unknown) => {
    const e = error instanceof PhoneError ? error : new PhoneError(500, 'The phone request failed.', 'FAILED')
    if (e.status >= 500) log(`[phone] ${error instanceof Error ? error.message : 'failed'}`)
    json(res, e.status, { error: e.code, message: e.message })
  }

  return {
    phone,
    /** True when the request was answered (or refused) here; false to pass it on. */
    handle(req: IncomingMessage, res: ServerResponse): boolean {
      const path = req.url?.split('?')[0] ?? ''
      if (path.startsWith('/api/phone/')) {
        void dispatch(req, res, path.slice('/api/phone/'.length)).catch((error: unknown) => fail(res, error))
        return true
      }
      let host: string | null
      try {
        host = phone.phoneHost(req)
      } catch (error) {
        fail(res, error)
        return true
      }
      if (host === null) return false
      if (path === '/' || path === '/index.html') {
        res.writeHead(302, { Location: '/phone.html', 'Cache-Control': 'no-store' })
        res.end()
        return true
      }
      if (!path.startsWith('/api/')) return false
      try {
        phone.guard(req)
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new PhoneError(403, 'The phone can only look, not change anything.', 'READ_ONLY')
      } catch (error) {
        if (error instanceof PhoneError && error.code === 'READ_ONLY') log(`[phone] refused ${req.method} ${path}`)
        fail(res, error)
        return true
      }
      return false
    },
  }
}

/** The phone gate for `npm run dev` and `npm run preview`. Listed first, so it runs before the other APIs. */
export function phonePlugin(): Plugin {
  let port = 5190
  const api = createPhoneApi(undefined, () => port)
  const use = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!api.handle(req, res)) next()
  }
  return {
    name: 'cryptoanal-phone',
    configureServer(server) {
      port = server.config.server.port ?? port
      server.middlewares.use(use)
    },
    configurePreviewServer(server) {
      port = server.config.preview.port ?? port
      server.middlewares.use(use)
    },
  }
}
