/**
 * Talking to Kalshi for the trading engine: signed REST calls, and the WebSocket that pushes the
 * order book and the account's fills, positions and orders as they happen.
 *
 * Kalshi signs every request with the account key: `timestamp + METHOD + path` (no query), RSA-PSS
 * SHA-256 or Ed25519, base64. The WebSocket is signed the same way, as a GET of its own path.
 */
import { constants, sign, type KeyObject } from 'node:crypto'
import type { TradeEnv } from '../../src/trade/kalshiTrade'
import type { TradeCredentials } from './keys'

export const API_ROOT = '/trade-api/v2'
const WS_PATH = '/trade-api/ws/v2'
export const REST_ORIGIN: Record<TradeEnv, string> = { demo: 'https://external-api.demo.kalshi.co', live: 'https://external-api.kalshi.com' }
export const WS_ORIGIN: Record<TradeEnv, string> = { demo: 'wss://demo-api.kalshi.co', live: 'wss://api.elections.kalshi.com' }
/** After a 429 the request was not processed, so an order or cancel is safe to send again. */
const RATE_RETRY_MS = [300, 700, 1500]

export class TradeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'FAILED',
  ) {
    super(message)
  }
}

export function kalshiSignature(key: KeyObject, text: string): string {
  const data = Buffer.from(text, 'utf8')
  return (
    key.asymmetricKeyType === 'ed25519'
      ? sign(null, data, key)
      : sign('sha256', data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST })
  ).toString('base64')
}

export function authHeaders(creds: TradeCredentials, method: string, path: string, timestampMs: number): Record<string, string> {
  return {
    'KALSHI-ACCESS-KEY': creds.keyId,
    'KALSHI-ACCESS-SIGNATURE': kalshiSignature(creds.key, `${timestampMs}${method.toUpperCase()}${path.split('?')[0]}`),
    'KALSHI-ACCESS-TIMESTAMP': String(timestampMs),
  }
}

/** Kalshi's own words for a refusal: `{"error":{"message":…}}`. */
function kalshiMessage(body: unknown, status: number): string {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const e = b.error
  const text =
    e && typeof e === 'object'
      ? ((e as Record<string, unknown>).message ?? (e as Record<string, unknown>).details)
      : typeof e === 'string'
        ? e
        : b.message
  if (status === 401 || status === 403) return 'Kalshi refused the key. Check it in ⚙ → Kalshi trading on the computer.'
  return typeof text === 'string' && text ? `Kalshi: ${text}` : `Kalshi answered ${status}.`
}

export class KalshiRest {
  constructor(
    readonly env: TradeEnv,
    public creds: TradeCredentials | null,
    private readonly fetcher: typeof fetch = fetch,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  async call(method: 'GET' | 'POST' | 'DELETE', path: string, { authed = true, body }: { authed?: boolean; body?: unknown } = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(method, path, authed, body)
      } catch (error) {
        const wait = RATE_RETRY_MS[attempt]
        if (!(error instanceof TradeError && error.status === 429) || wait === undefined) throw error
        if (attempt === 0) this.log(`[trade] ${this.env} rate limited on ${method} ${path.split('?')[0]}; trying again`)
        await new Promise((done) => setTimeout(done, wait))
      }
    }
  }

  private async once(method: string, path: string, authed: boolean, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'cryptoanal/0.1 (trade)' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (authed) {
      if (!this.creds) throw new TradeError(401, `No ${this.env} key. Add one in ⚙ → Kalshi trading on the computer.`, 'NO_KEY')
      Object.assign(headers, authHeaders(this.creds, method, `${API_ROOT}${path}`, Date.now()))
    }
    let response: Response
    try {
      response = await this.fetcher(`${REST_ORIGIN[this.env]}${API_ROOT}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      })
    } catch {
      throw new TradeError(502, `Kalshi ${this.env} did not answer.`, 'UNREACHABLE')
    }
    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    if (!response.ok) throw new TradeError(response.status === 403 ? 401 : response.status, kalshiMessage(parsed, response.status), 'KALSHI_REJECTED')
    return parsed
  }
}

export interface StreamHandlers {
  /** `orderbook_snapshot` or `orderbook_delta` for a ticker. */
  book(ticker: string, type: 'snapshot' | 'delta', msg: Record<string, unknown>): void
  /** A fill, position or order change on the account. */
  account(type: string): void
  /** The stream opened or closed (prices fall back to polling while it is down). */
  status(open: boolean): void
}

/**
 * Kalshi's WebSocket for one account: one order-book subscription per watched ticker, plus the
 * account's fills, positions and orders. Reconnects by itself while it is wanted; a gap in a
 * subscription's sequence numbers resubscribes it, which sends a fresh snapshot.
 */
export class KalshiStream {
  private ws: WebSocket | null = null
  private wanted = new Set<string>()
  /** Subscriptions: ticker → sid, and the reverse; pending commands by id. */
  private sidOf = new Map<string, number>()
  private tickerOf = new Map<number, string>()
  private seqOf = new Map<number, number>()
  private pending = new Map<number, string>()
  private nextId = 1
  private retry = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  open = false

  constructor(
    readonly env: TradeEnv,
    private readonly creds: TradeCredentials,
    private readonly on: StreamHandlers,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  /** Watch exactly these tickers' books (an empty list closes the stream). */
  watch(tickers: Iterable<string>): void {
    this.wanted = new Set(tickers)
    if (!this.wanted.size) return this.close()
    if (!this.ws) return this.connect()
    if (!this.open) return
    for (const [ticker, sid] of this.sidOf) if (!this.wanted.has(ticker)) this.unsubscribe(ticker, sid)
    for (const ticker of this.wanted) if (!this.sidOf.has(ticker) && ![...this.pending.values()].includes(ticker)) this.subscribe(ticker)
  }

  close(): void {
    this.wanted.clear()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const ws = this.ws
    this.reset()
    ws?.close()
  }

  private reset(): void {
    this.ws = null
    this.sidOf.clear()
    this.tickerOf.clear()
    this.seqOf.clear()
    this.pending.clear()
    if (this.open) {
      this.open = false
      this.on.status(false)
    }
  }

  private send(cmd: string, params: Record<string, unknown>): number {
    const id = this.nextId++
    this.ws?.send(JSON.stringify({ id, cmd, params }))
    return id
  }

  private subscribe(ticker: string): void {
    this.pending.set(this.send('subscribe', { channels: ['orderbook_delta'], market_tickers: [ticker] }), ticker)
  }

  private unsubscribe(ticker: string, sid: number): void {
    this.send('unsubscribe', { sids: [sid] })
    this.sidOf.delete(ticker)
    this.tickerOf.delete(sid)
    this.seqOf.delete(sid)
  }

  private connect(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    let ws: WebSocket
    try {
      // Node's WebSocket (undici) takes headers, which the signed handshake needs.
      ws = new WebSocket(`${WS_ORIGIN[this.env]}${WS_PATH}`, { headers: authHeaders(this.creds, 'GET', WS_PATH, Date.now()) } as unknown as string[])
    } catch {
      return this.again()
    }
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.open = true
      this.retry = 0
      this.on.status(true)
      this.send('subscribe', { channels: ['fill', 'market_positions', 'user_orders'] })
      for (const ticker of this.wanted) this.subscribe(ticker)
    }
    ws.onmessage = (event) => {
      if (this.ws === ws) this.message(String(event.data))
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.reset()
      this.again()
    }
    ws.onerror = () => undefined
  }

  private again(): void {
    if (!this.wanted.size || this.timer) return
    const wait = [500, 1000, 2000, 5000, 10_000][Math.min(this.retry++, 4)]
    if (this.retry === 3) this.log(`[trade] ${this.env} stream keeps dropping; prices are polled meanwhile`)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.wanted.size) this.connect()
    }, wait)
  }

  private message(text: string): void {
    let data: Record<string, unknown>
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    const msg = (data.msg && typeof data.msg === 'object' ? data.msg : {}) as Record<string, unknown>
    const sid = Number(data.sid ?? msg.sid)
    switch (data.type) {
      case 'subscribed': {
        const ticker = this.pending.get(Number(data.id))
        if (ticker === undefined) return
        this.pending.delete(Number(data.id))
        if (!this.wanted.has(ticker)) return void this.send('unsubscribe', { sids: [sid] })
        this.sidOf.set(ticker, sid)
        this.tickerOf.set(sid, ticker)
        return
      }
      case 'orderbook_snapshot':
      case 'orderbook_delta': {
        const ticker = typeof msg.market_ticker === 'string' ? msg.market_ticker : this.tickerOf.get(sid)
        if (!ticker || !this.wanted.has(ticker)) return
        const seq = Number(data.seq)
        const last = this.seqOf.get(sid)
        if (data.type === 'orderbook_delta' && last !== undefined && seq !== last + 1) {
          // A missed message: the book is wrong until a fresh snapshot.
          this.unsubscribe(ticker, sid)
          this.subscribe(ticker)
          return
        }
        this.seqOf.set(sid, seq)
        this.on.book(ticker, data.type === 'orderbook_snapshot' ? 'snapshot' : 'delta', msg)
        return
      }
      case 'error':
        this.log(`[trade] ${this.env} stream: ${JSON.stringify(msg).slice(0, 160)}`)
        return
      case 'ok':
      case 'unsubscribed':
        return
      default:
        // Fills, positions and orders: what changed is read back over REST, so the shape is not needed.
        this.on.account(String(data.type))
    }
  }
}
