/**
 * The phone page through Tailscale, as V2's (its server/kalshi-phone.test.ts): a phone request is
 * told apart from this computer's browser, needs phone access on and a session, gets one for the
 * passcode (five wrong ones lock it) or for a Face ID passkey, and can only read. The passkey round
 * trip below plays the iPhone's part with a real P-256 key.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPhoneApi, guardLocal, isPhoneOrigin, PHONE_LOCK_MS, PHONE_SESSION_MS, PhoneAccess } from './phone'
import { createWorkspaceApi } from './workspace'

const dir = mkdtempSync(join(tmpdir(), 'cryptoanal-phone-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const HOST = 'mac.tail1234.ts.net'
const ORIGIN = `https://${HOST}:8443`
/** What `tailscale serve --https=8443` adds in front of a request from the phone. */
const TAILSCALE = { host: `${HOST}:8443`, 'x-forwarded-for': '100.101.102.103', 'tailscale-user-login': 'me@example.com' }

const fakeReq = (headers: Record<string, string>, { address = '127.0.0.1', method = 'GET' }: { address?: string; method?: string } = {}) =>
  ({ headers, method, socket: { remoteAddress: address } }) as unknown as IncomingMessage

const b64 = (bytes: Buffer) => bytes.toString('base64url')
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest()

/** Just enough CBOR to build what an iPhone sends. */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n])
    if (n < 256) return Buffer.from([(major << 5) | 24, n])
    const b = Buffer.alloc(3)
    b[0] = (major << 5) | 25
    b.writeUInt16BE(n, 1)
    return b
  }
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
  if (typeof value === 'string') {
    const bytes = Buffer.from(value)
    return Buffer.concat([head(3, bytes.length), bytes])
  }
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])])
  throw new Error('unsupported')
}

/** The phone's side of Face ID: a P-256 key and the bytes Safari hands back. */
function fakeIphone(host = HOST) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const credId = randomBytes(16)
  const cose = new Map<unknown, unknown>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x!, 'base64url')],
    [-3, Buffer.from(jwk.y!, 'base64url')],
  ])
  const authData = (flags: number, counter: number, attested = false) => {
    const head = Buffer.alloc(37)
    sha256(host).copy(head, 0)
    head[32] = flags
    head.writeUInt32BE(counter, 33)
    if (!attested) return head
    const length = Buffer.alloc(2)
    length.writeUInt16BE(credId.length)
    return Buffer.concat([head, Buffer.alloc(16), length, credId, cbor(cose)])
  }
  const clientData = (type: string, challenge: string, origin = ORIGIN) => Buffer.from(JSON.stringify({ type, challenge, origin }))
  return {
    id: b64(credId),
    create: (challenge: string, origin?: string) => ({
      id: b64(credId),
      clientDataJSON: b64(clientData('webauthn.create', challenge, origin)),
      attestationObject: b64(
        cbor(
          new Map<unknown, unknown>([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', authData(0x45, 0, true)],
          ]),
        ),
      ),
    }),
    get: (challenge: string, { counter = 0, flags = 0x05 } = {}) => {
      const cd = clientData('webauthn.get', challenge)
      const ad = authData(flags, counter)
      return {
        id: b64(credId),
        clientDataJSON: b64(cd),
        authenticatorData: b64(ad),
        signature: b64(sign('sha256', Buffer.concat([ad, sha256(cd)]), privateKey)),
      }
    },
  }
}

describe('telling the phone from this computer', () => {
  const phone = new PhoneAccess(join(dir, 'tell.json'))

  it("passes this computer's own browser to the local guard", () => {
    const local = fakeReq({ host: 'localhost:5190' })
    expect(phone.phoneHost(local)).toBeNull()
    expect(() => guardLocal(local)).not.toThrow()
  })

  it('sees a request through Tailscale as a phone, never as this computer', () => {
    expect(phone.phoneHost(fakeReq(TAILSCALE))).toBe(HOST)
    // Even if the proxy rewrote the host to the backend, its headers keep it off the local path.
    const rewritten = fakeReq({ ...TAILSCALE, host: '127.0.0.1:5190', 'x-forwarded-host': HOST })
    expect(phone.phoneHost(rewritten)).toBe(HOST)
    expect(() => guardLocal(rewritten)).toThrow('Only this computer can change phone access.')
  })

  it('refuses proxy headers from anywhere but the local Tailscale proxy', () => {
    // A device on the Wi-Fi pretending to be Tailscale.
    expect(() => phone.phoneHost(fakeReq(TAILSCALE, { address: '192.168.1.40' }))).toThrow('Phones connect through Tailscale only.')
    expect(() => phone.phoneHost(fakeReq({ ...TAILSCALE, host: 'evil.example.com' }))).toThrow('Open the phone page at its .ts.net address.')
  })

  it("takes the page's origin on any port, never another host or plain http", () => {
    expect(isPhoneOrigin(ORIGIN, HOST)).toBe(true)
    expect(isPhoneOrigin(`https://${HOST}`, HOST)).toBe(true)
    expect(isPhoneOrigin(`http://${HOST}:8443`, HOST)).toBe(false)
    expect(isPhoneOrigin('https://evil.ts.net:8443', HOST)).toBe(false)
    expect(isPhoneOrigin(`https://${HOST}.evil.com`, HOST)).toBe(false)
  })
})

describe('passcode and sessions', () => {
  let now = Date.parse('2026-10-28T15:00:00Z')
  const phone = new PhoneAccess(join(dir, 'passcode.json'), () => now)
  const withCookie = (token: string, extra: Record<string, string> = {}) =>
    fakeReq({ ...TAILSCALE, cookie: `other=1; cryptoanal_phone=${token}`, ...extra })

  it('stays off until a passcode is set and access is turned on', () => {
    expect(() => phone.guard(fakeReq(TAILSCALE), { session: false })).toThrow('Phone access is off')
    expect(() => phone.setEnabled(true)).toThrow('Set a 6-digit passcode first.')
    expect(() => phone.setPasscode('12345')).toThrow('The passcode is 6 digits.')
    phone.setPasscode('482913')
    expect(phone.setEnabled(true)).toMatchObject({ enabled: true, passcodeSet: true })
  })

  it('keeps the passcode only as a scrypt hash, readable by this user only', () => {
    const text = readFileSync(join(dir, 'passcode.json'), 'utf8')
    expect(text).not.toContain('482913')
  })

  it('locks for 15 minutes after five wrong passcodes, even for the right one', () => {
    for (const left of [4, 3, 2, 1]) expect(() => phone.login('111111')).toThrow(`Wrong passcode. ${left} `)
    expect(() => phone.login('111111')).toThrow('Locked for 15 minutes.')
    expect(() => phone.login('482913')).toThrow('Locked for 15 more minutes.')
    now += PHONE_LOCK_MS
    expect(typeof phone.login('482913')).toBe('string')
  })

  it('signs in with a cookie that lasts 30 days', () => {
    const token = phone.login('482913')
    expect(phone.cookie(token)).toBe(`cryptoanal_phone=${token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`)
    expect(phone.guard(withCookie(token))).toBe(HOST)
    expect(() => phone.guard(fakeReq(TAILSCALE))).toThrow('Sign in on the phone first.')
    now += PHONE_SESSION_MS + 1
    expect(phone.signedIn(withCookie(token))).toBe(false)
  })

  it('a new passcode signs every phone out', () => {
    const token = phone.login('482913')
    phone.setPasscode('555000')
    expect(phone.signedIn(withCookie(token))).toBe(false)
  })

  it("POSTs need the page's own origin and its header", () => {
    const token = phone.login('555000')
    const post = (headers: Record<string, string>) => fakeReq({ ...TAILSCALE, cookie: `cryptoanal_phone=${token}`, ...headers }, { method: 'POST' })
    expect(() => phone.guard(post({ 'content-type': 'application/json' }))).toThrow('Requests must come from the phone page.')
    expect(() =>
      phone.guard(post({ origin: 'https://evil.ts.net', 'x-cryptoanal-phone': '1', 'content-type': 'application/json' })),
    ).toThrow('Requests must come from the phone page.')
    expect(phone.guard(post({ origin: ORIGIN, 'x-cryptoanal-phone': '1', 'content-type': 'application/json' }))).toBe(HOST)
  })
})

describe('Face ID passkeys', () => {
  const phone = new PhoneAccess(join(dir, 'passkey.json'))
  phone.setPasscode('482913')
  phone.setEnabled(true)
  const iphone = fakeIphone()

  it('saves the key the iPhone makes, then signs in with it', () => {
    expect(phone.passkeyGetOptions(HOST)).toBeNull()
    const create = phone.passkeyCreateOptions(HOST)
    expect(create).toMatchObject({ rp: { id: HOST }, authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' } })
    expect(phone.passkeyCreate(HOST, iphone.create(create.challenge))).toMatchObject({ passkeys: 1 })
    const get = phone.passkeyGetOptions(HOST)!
    expect(get.allowCredentials).toEqual([{ type: 'public-key', id: iphone.id }])
    const token = phone.passkeyGet(HOST, iphone.get(get.challenge))
    expect(phone.signedIn(fakeReq({ ...TAILSCALE, cookie: `cryptoanal_phone=${token}` }))).toBe(true)
  })

  it('refuses a replayed challenge, another address, a forged signature and no Face ID', () => {
    const answer = iphone.get(phone.passkeyGetOptions(HOST)!.challenge)
    phone.passkeyGet(HOST, answer)
    expect(() => phone.passkeyGet(HOST, answer)).toThrow('The Face ID request expired.')
    expect(() => phone.passkeyCreate(HOST, iphone.create(phone.passkeyCreateOptions(HOST).challenge, 'https://evil.ts.net'))).toThrow(
      'The Face ID answer is for another address.',
    )
    const forged = iphone.get(phone.passkeyGetOptions(HOST)!.challenge)
    forged.signature = b64(randomBytes(70))
    expect(() => phone.passkeyGet(HOST, forged)).toThrow()
    // User present but not verified (no Face ID): refused.
    expect(() => phone.passkeyGet(HOST, iphone.get(phone.passkeyGetOptions(HOST)!.challenge, { flags: 0x01 }))).toThrow(
      'Face ID did not confirm it was you.',
    )
  })

  it('a key from another phone is not let in', () => {
    const stranger = fakeIphone()
    expect(() => phone.passkeyGet(HOST, stranger.get(phone.passkeyGetOptions(HOST)!.challenge))).toThrow('This Face ID is not known here.')
  })

  it('"sign out all phones" forgets Face ID too', () => {
    expect(phone.signOutAll()).toMatchObject({ sessions: 0, passkeys: 0 })
    expect(phone.passkeyGetOptions(HOST)).toBeNull()
  })
})

describe('the gate in front of the app', () => {
  let server: Server
  let port = 0
  const workspace = join(dir, 'workspace.json')
  beforeAll(async () => {
    // The phone gate, then the workspace API behind it, as vite.config.ts orders them.
    const phoneApi = createPhoneApi(new PhoneAccess(join(dir, 'routes.json')), () => 5190, () => {})
    const workspaceApi = createWorkspaceApi(workspace, false)
    server = createServer((req, res) => {
      if (!phoneApi.handle(req, res) && !workspaceApi.handle(req, res)) res.writeHead(404).end('page')
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    port = (server.address() as { port: number }).port
  })
  afterAll(() => new Promise<void>((done) => server.close(() => done())))

  /** A request to the test server, as this computer's browser or as the phone through Tailscale. */
  const call = (method: string, path: string, { body, from = 'phone', cookie }: { body?: unknown; from?: 'phone' | 'local'; cookie?: string } = {}) =>
    new Promise<{ status: number; body: Record<string, unknown> | null; setCookie: string; location?: string }>((done, fail) => {
      const local = `localhost:${port}`
      const headers: Record<string, string> = from === 'phone' ? { ...TAILSCALE } : { host: local }
      if (method !== 'GET')
        Object.assign(headers, {
          origin: from === 'phone' ? ORIGIN : `http://${local}`,
          'x-cryptoanal-phone': '1',
          'content-type': 'application/json',
        })
      if (cookie) headers.cookie = cookie
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => {
          let parsed: Record<string, unknown> | null = null
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = null
          }
          done({ status: res.statusCode ?? 0, body: parsed, setCookie: String(res.headers['set-cookie'] ?? ''), location: res.headers.location })
        })
      })
      req.on('error', fail)
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })

  it('is off until the computer turns it on, and only the computer can', async () => {
    expect((await call('GET', '/api/phone/session')).body).toMatchObject({ error: 'PHONE_OFF' })
    expect((await call('POST', '/api/phone/settings', { body: { enabled: true } })).body).toMatchObject({ error: 'NOT_LOCAL' })
    const set = await call('POST', '/api/phone/settings', { from: 'local', body: { passcode: '482913', enabled: true } })
    expect(set.body).toMatchObject({ enabled: true, passcodeSet: true, port: 5190 })
  })

  it('keeps the workspace from a phone that has not signed in', async () => {
    expect((await call('GET', '/api/workspace')).body).toMatchObject({ error: 'SIGNED_OUT' })
    expect((await call('GET', '/api/kalshi/strike?product=BTC-USD')).body).toMatchObject({ error: 'SIGNED_OUT' })
  })

  it('sends the phone from the desktop page to phone.html, and lets the page itself load', async () => {
    const home = await call('GET', '/')
    expect(home.status).toBe(302)
    expect(home.location).toBe('/phone.html')
    expect((await call('GET', '/phone.html')).status).toBe(404) // passed on to the next handler
    expect((await call('GET', '/', { from: 'local' })).status).toBe(404) // the computer gets the desktop page
  })

  it('signs the phone in; it reads the workspace and can never change it', async () => {
    await call('PATCH', '/api/workspace', { from: 'local', body: { changes: { settings: { layout: '2v' } } } })
    expect((await call('POST', '/api/phone/login', { body: { passcode: '000000' } })).status).toBe(401)
    const login = await call('POST', '/api/phone/login', { body: { passcode: '482913' } })
    expect(login.status).toBe(200)
    expect(login.setCookie).toContain('HttpOnly; Secure; SameSite=Strict')
    const cookie = login.setCookie.split(';')[0]
    expect((await call('GET', '/api/phone/session', { cookie })).body).toMatchObject({ signedIn: true, host: HOST, passkeys: 0 })

    const read = await call('GET', '/api/workspace', { cookie })
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({ writable: false, data: { settings: { layout: '2v' } } })

    const write = await call('PATCH', '/api/workspace', { cookie, body: { changes: { settings: { layout: '1' } } } })
    expect(write.status).toBe(403)
    expect(write.body).toMatchObject({ error: 'READ_ONLY' })
    expect(JSON.parse(readFileSync(workspace, 'utf8')).settings).toEqual({ layout: '2v' })
    expect((await call('POST', '/api/phone/settings', { cookie, body: { enabled: false } })).body).toMatchObject({ error: 'NOT_LOCAL' })
  })

  it("the computer's own browser is unaffected", async () => {
    expect((await call('GET', '/api/workspace', { from: 'local' })).body).toMatchObject({ writable: true })
    expect((await call('GET', '/api/phone/session', { from: 'local' })).body).toMatchObject({ local: true, signedIn: true })
  })
})
