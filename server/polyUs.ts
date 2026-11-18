/**
 * `/api/poly/*`: REAL orders on Polymarket US's 5-minute BTC Up/Down rounds, for the phone page
 * polymarket.html. Polymarket US (api.polymarket.us) is the US exchange, not polymarket.com.
 *
 * - The key: a Key ID and a Secret Key from polymarket.us/developer. The secret stays a file on this
 *   computer; `polymarket-us.json` next to the workspace keeps only its PATH, the Key ID and the
 *   real-money switch, which is off until turned on on the computer (⚙ → Polymarket US trading).
 * - Every request is signed with Ed25519: timestamp + method + path (docs.polymarket.us).
 * - The instrument is the round's Yes (= Up) side; every price sent is a Yes price. Before the first
 *   order of each kind, a preview asks the exchange how it reads it, and nothing is sent unless it
 *   reads it as meant (Down bought = Yes sold, at the Yes price sent).
 * - Buys and Sell now are limit orders, immediate-or-cancel, at most 2¢ past the best price.
 *   Every buy leaves its auto-sell on the book (good till cancelled); Sell now cancels it first.
 * - Holdings, their cost and every play are kept in `polymarket-us-plays.json`; what is held is
 *   always checked against the account's own positions.
 *
 * Open to this computer and to a signed-in phone (server/phone.ts lets buy / sell-now / auto-sell
 * through). The key and the switch can be changed on this computer only.
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'
import {
  autoSellPrice,
  intentOf,
  isPolySide,
  parseUsBook,
  planBuy,
  POLY_AUTO_SELL_UNDER_PCT,
  POLY_SLIPPAGE,
  polyFee,
  polyTotals,
  priceText,
  usRoundSlug,
  yesPrice,
  type PolyBook,
  type PolyKeysView,
  type PolyPlay,
  type PolyPosition,
  type PolyResult,
  type PolySide,
  type PolyState,
  type PolyStats,
} from '../src/trade/polyUs'
import { PhoneAccess, PhoneError, guardLocal, readJson } from './phone'
import { expandPath } from './trade/keys'
import { workspaceFile } from './workspace'

const GATEWAY = 'https://gateway.polymarket.us'
const API = 'https://api.polymarket.us'
const COINBASE = 'https://api.exchange.coinbase.com'
const ROUND_SECONDS = 300
const TICK_MS = 2_000
/** The page polls; with nobody looking and nothing held, the loop stops. */
const VIEWER_IDLE_MS = 60_000
const BOOK_TTL_MS = 800
const ROUND_TTL_MS = 15_000
const ACCOUNT_TTL_MS = 2_000
const BTC_TTL_MS = 2_000
/** A holding changed this recently is not checked against the account's positions, ms. */
const SETTLE_POSITIONS_MS = 15_000
/** A finished round's result is asked for this often. */
const RESULT_EVERY_MS = 10_000
/** No buys this close to the close, seconds. */
const LAST_BUY_S = 5
const MAX_BUY_DOLLARS = 500
const SECRET_FILE_LIMIT = 16 * 1024
/** An Ed25519 seed as PKCS#8 DER: this prefix, then the 32 bytes. */
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')

/** The phone may use these; the rest (settings, check) is this computer's. */
export const POLY_PHONE_ROUTES = new Set(['state', 'stats', 'buy', 'sell-now', 'auto-sell'])

export class PolyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6
const money = (v: number) => `$${v.toFixed(2)}`
const cents = (v: number) => `${Number((v * 100).toFixed(1))}¢`
const word = (side: PolySide) => (side === 'up' ? 'Up' : 'Down')
const amount = (v: unknown): number => {
  const n = Number((v as { value?: unknown } | null | undefined)?.value ?? v)
  return Number.isFinite(n) ? n : NaN
}

// ── The key ─────────────────────────────────────────────────────────────────────────────────

interface KeysFile {
  version: 1
  keyId: string
  path: string
  liveTrading: boolean
}

export interface PolyCreds {
  keyId: string
  key: KeyObject
}

/** The Secret Key in the file at `path` (base64, as polymarket.us/developer shows it); or why not. */
export function readSecret(path: string): { key: KeyObject } | { error: string } {
  const file = expandPath(path)
  let text: string
  try {
    const buffer = readFileSync(file)
    if (buffer.length > SECRET_FILE_LIMIT) return { error: `${file} is too big to be a secret key file.` }
    text = buffer.toString('utf8').trim()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { error: `There is no file at ${file}.` }
    if (code === 'EACCES' || code === 'EPERM') return { error: `The app is not allowed to read ${file}.` }
    return { error: `Could not read ${file}.` }
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(text)) return { error: `${file} should hold only the Secret Key polymarket.us/developer showed.` }
  const bytes = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (bytes.length < 32) return { error: `${file} is not a Polymarket US Secret Key (too short).` }
  try {
    return { key: createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, bytes.subarray(0, 32)]), format: 'der', type: 'pkcs8' }) }
  } catch {
    return { error: `${file} is not a Polymarket US Secret Key.` }
  }
}

/** The headers of a signed request: Ed25519 over `timestamp + method + path` (no query). */
export function signedHeaders(creds: PolyCreds, method: string, path: string, nowMs: number): Record<string, string> {
  const timestamp = String(Math.floor(nowMs))
  const signature = sign(null, Buffer.from(`${timestamp}${method.toUpperCase()}${path.split('?')[0]}`), creds.key).toString('base64')
  return { 'X-PM-Access-Key': creds.keyId, 'X-PM-Timestamp': timestamp, 'X-PM-Signature': signature }
}

export class PolyKeyStore {
  constructor(readonly file: string) {}

  private read(): KeysFile {
    try {
      const p = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<KeysFile>
      return { version: 1, keyId: typeof p.keyId === 'string' ? p.keyId : '', path: typeof p.path === 'string' ? p.path : '', liveTrading: p.liveTrading === true }
    } catch {
      return { version: 1, keyId: '', path: '', liveTrading: false }
    }
  }

  private async write(data: KeysFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.file)
    await chmod(this.file, 0o600).catch(() => undefined)
  }

  resolve(): { creds: PolyCreds | null; live: boolean; view: PolyKeysView } {
    const data = this.read()
    const secret = data.path ? readSecret(data.path) : null
    const creds = data.keyId && secret && 'key' in secret ? { keyId: data.keyId, key: secret.key } : null
    const live = data.liveTrading && creds !== null
    return {
      creds,
      live,
      view: { file: this.file, keyId: data.keyId, path: data.path, error: secret && 'error' in secret ? secret.error : null, liveTrading: live },
    }
  }

  async save(keyId: unknown, path: unknown) {
    if (typeof keyId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(keyId.trim())) throw new PolyError(400, 'Paste the Key ID polymarket.us/developer shows.')
    if (typeof path !== 'string' || !path.trim()) throw new PolyError(400, 'Type where the Secret Key file is.')
    const secret = readSecret(path)
    if ('error' in secret) throw new PolyError(400, secret.error)
    const data = this.read()
    await this.write({ ...data, keyId: keyId.trim(), path: path.trim() })
    return this.resolve()
  }

  async clear() {
    await this.write({ version: 1, keyId: '', path: '', liveTrading: false })
    return this.resolve()
  }

  async setLive(on: boolean) {
    if (on && !this.resolve().creds) throw new PolyError(409, 'Add a working key first.')
    await this.write({ ...this.read(), liveTrading: on })
    return this.resolve()
  }
}

// ── What Polymarket US answers ──────────────────────────────────────────────────────────────

export interface UsRound {
  slug: string
  start: number
  end: number
  strike: number | null
  tick: number
  open: boolean
  resolved: boolean
}

/** `/v1/market/slug/{slug}`: a 5-minute BTC Up/Down round, or null. */
export function parseUsRound(payload: unknown): UsRound | null {
  const m = (payload as { market?: Record<string, unknown> } | null)?.market
  const terms = m?.assetPriceTerms as Record<string, unknown> | null | undefined
  if (!m || !terms || terms.marketType !== 'ASSET_PRICE_MARKET_TYPE_UP_DOWN' || terms.horizon !== '5m') return null
  if ((terms.asset as { symbol?: unknown } | undefined)?.symbol !== 'btc') return null
  const start = Date.parse(String(terms.windowStart ?? '')) / 1000
  const end = Date.parse(String(terms.windowEnd ?? '')) / 1000
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start !== ROUND_SECONDS) return null
  const strike = amount(terms.priceToBeat)
  const tick = Number(m.orderPriceMinTickSize)
  return {
    slug: String(m.slug ?? ''),
    start,
    end,
    strike: strike > 0 ? strike : null,
    tick: tick > 0 && tick < 1 ? tick : 0.01,
    open: m.status === 'MARKET_STATUS_OPEN' && m.active === true && m.closed !== true,
    resolved: m.status === 'MARKET_STATUS_RESOLVED',
  }
}

/** The account's net position in each round: + Up (long Yes), − Down (short Yes). */
export function parsePositions(payload: unknown): Map<string, number> {
  const out = new Map<string, number>()
  const rows = (payload as { positions?: Record<string, { netPositionDecimal?: unknown; netPosition?: unknown; expired?: unknown }> } | null)?.positions
  for (const [slug, p] of Object.entries(rows ?? {})) {
    const net = Number(p?.netPositionDecimal ?? p?.netPosition)
    if (Number.isFinite(net) && Math.abs(net) > 1e-9 && p?.expired !== true) out.set(slug, net)
  }
  return out
}

export function parseBuyingPower(payload: unknown): number | null {
  const rows = (payload as { balances?: { currency?: unknown; buyingPower?: unknown }[] } | null)?.balances
  const usd = rows?.find((b) => b?.currency === 'USD') ?? rows?.[0]
  const value = amount(usd?.buyingPower)
  return Number.isFinite(value) ? value : null
}

interface UsOrder {
  id: string
  side: string
  price: number
  quantity: number
  filled: number
  /** Average fill price, Yes terms. */
  avgYes: number
  fee: number | null
  state: string
  reject: string
}

export function parseOrder(raw: unknown, fallbackId = ''): UsOrder {
  const o = (raw ?? {}) as Record<string, unknown>
  const fee = amount(o.commissionNotionalTotalCollected)
  return {
    id: String(o.id ?? fallbackId),
    side: String(o.side ?? ''),
    price: amount(o.price),
    quantity: Number(o.quantity),
    filled: Number(o.cumQuantity ?? 0) || 0,
    avgYes: amount(o.avgPx),
    fee: Number.isFinite(fee) ? fee : null,
    state: String(o.state ?? ''),
    reject: '',
  }
}

/** `POST /v1/orders` with synchronous execution: the order as its last execution left it. */
export function parseCreated(payload: unknown): UsOrder {
  const p = (payload ?? {}) as { id?: unknown; executions?: { order?: unknown; type?: unknown; text?: unknown; orderRejectReason?: unknown }[] }
  const last = p.executions?.at(-1)
  const order = parseOrder(last?.order, String(p.id ?? ''))
  if (last?.type === 'EXECUTION_TYPE_REJECTED') order.reject = String(last.text || last.orderRejectReason || 'rejected')
  return order
}

/**
 * A fill's average on the holding's own side. The API's `avgPx` is a Yes price; should it come
 * back already as the Down price, the one nearer the price aimed at is taken.
 */
export function sideAvg(side: PolySide, avgYes: number, aimed: number): number {
  if (side === 'up' || !Number.isFinite(avgYes)) return avgYes
  const flipped = round6(1 - avgYes)
  return Math.abs(flipped - aimed) <= Math.abs(avgYes - aimed) ? flipped : avgYes
}

// ── The engine ──────────────────────────────────────────────────────────────────────────────

interface Holding {
  slug: string
  side: PolySide
  contracts: number
  /** Before fees, and with them. */
  value: number
  cost: number
  start: number
  end: number
  tick: number
  autoSell: { orderId: string; price: number; contracts: number; recorded: number } | null
  /** Ms; the account's positions can lag a fill, so a holding this new is not checked against them. */
  changedAt?: number
}

interface Ledger {
  version: 1
  autoSellPct: number
  /** Off for what is held now. */
  autoSellOff: boolean
  holdings: Holding[]
  settling: Holding[]
  plays: PolyPlay[]
}

function readLedger(file: string): Ledger {
  try {
    const a = JSON.parse(readFileSync(file, 'utf8')) as Partial<Ledger>
    return {
      version: 1,
      autoSellPct: typeof a.autoSellPct === 'number' ? a.autoSellPct : POLY_AUTO_SELL_UNDER_PCT,
      autoSellOff: a.autoSellOff === true,
      holdings: Array.isArray(a.holdings) ? a.holdings : [],
      settling: Array.isArray(a.settling) ? a.settling : [],
      plays: Array.isArray(a.plays) ? a.plays : [],
    }
  } catch {
    return { version: 1, autoSellPct: POLY_AUTO_SELL_UNDER_PCT, autoSellOff: false, holdings: [], settling: [], plays: [] }
  }
}

type Kind = `${PolySide}-${'buy' | 'sell'}`
/** How the exchange must read each kind of order: Down is the Yes side sold. */
const EXPECTED_SIDE: Record<Kind, string> = {
  'up-buy': 'ORDER_SIDE_BUY',
  'up-sell': 'ORDER_SIDE_SELL',
  'down-buy': 'ORDER_SIDE_SELL',
  'down-sell': 'ORDER_SIDE_BUY',
}

export class PolyUsEngine {
  private ledger: Ledger
  private round: { value: UsRound | null; at: number; slug: string } = { value: null, at: 0, slug: '' }
  private book: { slug: string; at: number; value: Record<PolySide, PolyBook> | null } = { slug: '', at: 0, value: null }
  private account: { at: number; positions: Map<string, number>; buyingPower: number | null } = { at: 0, positions: new Map(), buyingPower: null }
  private btc: { value: number | null; at: number } = { value: null, at: 0 }
  private results = new Map<string, number>()
  /** Kinds of order the exchange was seen to read as meant (a preview), this run. */
  private checked = new Set<Kind>()
  private timer: ReturnType<typeof setInterval> | null = null
  private viewedAt = 0
  private problem = ''
  /** One change at a time: a tap and the loop never sell the same contracts twice. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly keys: PolyKeyStore,
    readonly file: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = (line) => console.log(line),
  ) {
    this.ledger = readLedger(file)
    if (this.ledger.holdings.length || this.ledger.settling.length) this.wake()
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.ledger, null, 2)}\n`, 'utf8')
    await rename(temporary, this.file)
  }

  private nowSec = () => Math.floor(this.now() / 1000)

  private async request(base: string, method: string, path: string, body?: unknown, creds?: PolyCreds): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (creds) Object.assign(headers, signedHeaders(creds, method, path, this.now()))
    const res = await this.fetcher(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) })
    const text = await res.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!res.ok) {
      const said = (data as { message?: unknown } | null)?.message
      const why = typeof said === 'string' && said ? said : `answered ${res.status}`
      if (res.status === 401 || res.status === 403) throw new PolyError(502, `Polymarket US refused the key: ${why}. Check it in ⚙ → Polymarket US trading.`)
      if (res.status === 429) throw new PolyError(429, 'Polymarket US says too many requests. Try again in a second.')
      throw new PolyError(502, `Polymarket US: ${why}`)
    }
    return data
  }

  private gateway = (path: string) => this.request(GATEWAY, 'GET', path)

  private authed(method: string, path: string, body?: unknown): Promise<unknown> {
    const { creds } = this.keys.resolve()
    if (!creds) throw new PolyError(409, 'Add your Polymarket US key on the computer: ⚙ → Polymarket US trading.')
    return this.request(API, method, path, body, creds)
  }

  private async roundAt(startSec: number): Promise<UsRound | null> {
    const slug = usRoundSlug(startSec)
    if (this.round.slug === slug && this.now() - this.round.at < ROUND_TTL_MS) return this.round.value
    const value = parseUsRound(await this.gateway(`/v1/market/slug/${slug}`).catch(() => null))
    this.round = { value: value?.slug === slug ? value : null, at: this.now(), slug }
    return this.round.value
  }

  private currentRound(): Promise<UsRound | null> {
    const nowSec = this.nowSec()
    return this.roundAt(nowSec - (nowSec % ROUND_SECONDS))
  }

  private async books(round: UsRound, fresh = false): Promise<Record<PolySide, PolyBook>> {
    if (!fresh && this.book.slug === round.slug && this.book.value && this.now() - this.book.at < BOOK_TTL_MS) return this.book.value
    const value = parseUsBook(await this.gateway(`/v1/markets/${round.slug}/book`))
    this.book = { slug: round.slug, at: this.now(), value }
    return value
  }

  private async readAccount(fresh = false) {
    if (!this.keys.resolve().creds) {
      this.account = { at: this.now(), positions: new Map(), buyingPower: null }
      return this.account
    }
    if (!fresh && this.now() - this.account.at < ACCOUNT_TTL_MS) return this.account
    const [positions, balances] = await Promise.all([this.authed('GET', '/v1/portfolio/positions'), this.authed('GET', '/v1/account/balances')])
    this.account = { at: this.now(), positions: parsePositions(positions), buyingPower: parseBuyingPower(balances) }
    return this.account
  }

  private async btcPrice(): Promise<number | null> {
    if (this.now() - this.btc.at < BTC_TTL_MS) return this.btc.value
    this.btc.at = this.now()
    const reply = (await this.request(COINBASE, 'GET', '/products/BTC-USD/ticker').catch(() => null)) as { price?: unknown } | null
    const price = Number(reply?.price)
    if (Number.isFinite(price) && price > 0) this.btc.value = price
    return this.btc.value
  }

  /** What the account holds in `slug`, by side; 0 when nothing (or the other side). */
  private heldOn(slug: string, side: PolySide): number {
    const net = this.account.positions.get(slug) ?? 0
    return side === 'up' ? Math.max(0, net) : Math.max(0, -net)
  }

  private wake(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
  }

  private async tick(): Promise<void> {
    const idle = this.now() - this.viewedAt > VIEWER_IDLE_MS
    if (idle && !this.ledger.holdings.length && !this.ledger.settling.length) {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      return
    }
    try {
      await this.serial(() => this.step())
      this.problem = ''
    } catch (error) {
      this.problem = error instanceof Error ? error.message : String(error)
    }
  }

  private record(h: Holding, contracts: number, proceeds: number, outcome: PolyPlay['outcome']): void {
    const share = h.contracts > 0 ? Math.min(1, contracts / h.contracts) : 1
    const cost = round6(h.cost * share)
    this.ledger.plays.push({
      slug: h.slug,
      side: h.side,
      contracts: round6(contracts),
      cost,
      proceeds: round6(proceeds),
      pnl: round6(proceeds - cost),
      outcome,
      start: h.start,
      end: h.end,
      closedAt: this.nowSec(),
    })
    h.value = round6(h.value * (1 - share))
    h.cost = round6(h.cost - cost)
    h.contracts = round6(h.contracts - contracts)
  }

  /** Records what the holding's auto-sell sold since last looked. True when it changed anything. */
  private async collectAutoSell(h: Holding): Promise<boolean> {
    const a = h.autoSell
    if (!a) return false
    const o = parseOrder(((await this.authed('GET', `/v1/order/${a.orderId}`)) as { order?: unknown } | null)?.order, a.orderId)
    const fresh = round6(Math.min(o.filled, a.contracts) - a.recorded)
    const done = ['ORDER_STATE_FILLED', 'ORDER_STATE_CANCELED', 'ORDER_STATE_EXPIRED', 'ORDER_STATE_REJECTED', 'ORDER_STATE_REPLACED'].includes(o.state)
    if (fresh > 1e-9) {
      const avg = Number.isFinite(o.avgYes) ? sideAvg(h.side, o.avgYes, a.price) : a.price
      // A sale resting on the book is a maker's: no taker fee unless it crossed when placed.
      const fee = o.fee !== null && o.filled > 0 ? (o.fee * fresh) / o.filled : 0
      a.recorded = round6(a.recorded + fresh)
      this.record(h, fresh, fresh * avg - fee, 'auto-sold')
      this.log(`[poly] auto-sold ${fresh} ${h.side} at ${cents(avg)}`)
    }
    if (done) h.autoSell = null
    return fresh > 1e-9 || done
  }

  private async cancelAutoSell(h: Holding): Promise<void> {
    const a = h.autoSell
    if (!a) return
    await this.authed('POST', `/v1/order/${a.orderId}/cancel`, { marketSlug: h.slug }).catch(() => undefined)
    await this.collectAutoSell(h)
    h.autoSell = null
  }

  /** The exchange must read this order as meant before the first of its kind goes out. */
  private async check(kind: Kind, body: Record<string, unknown>): Promise<void> {
    if (this.checked.has(kind)) return
    const preview = (await this.authed('POST', '/v1/order/preview', { request: body })) as { order?: unknown } | null
    const o = parseOrder(preview?.order)
    const sent = Number((body.price as { value: string }).value)
    if (o.side !== EXPECTED_SIDE[kind] || (Number.isFinite(o.price) && Math.abs(o.price - sent) > 1e-9)) {
      this.log(`[poly] preview of ${kind} read as ${o.side} at ${o.price}; expected ${EXPECTED_SIDE[kind]} at ${sent}`)
      throw new PolyError(502, `Not sent: Polymarket US would read this ${kind.replace('-', ' ')} as ${o.side || 'something else'} at ${o.price}. Nothing was traded.`)
    }
    this.checked.add(kind)
  }

  private orderBody(round: UsRound, side: PolySide, action: 'buy' | 'sell', sidePrice: number, contracts: number, tif: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      marketSlug: round.slug,
      type: 'ORDER_TYPE_LIMIT',
      price: { value: priceText(yesPrice(side, sidePrice), round.tick), currency: 'USD' },
      quantity: contracts,
      tif,
      intent: intentOf(side, action),
    }
    if (tif === 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL') Object.assign(body, { synchronousExecution: true, maxBlockTime: '3' })
    return body
  }

  /** Sends an order (checked first); the order as it ended, for immediate-or-cancel ones. */
  private async send(kind: Kind, body: Record<string, unknown>): Promise<UsOrder> {
    await this.check(kind, body)
    const created = parseCreated(await this.authed('POST', '/v1/orders', body))
    if (created.reject) throw new PolyError(409, `Polymarket US rejected the order: ${created.reject}.`)
    if (!created.state && created.id) {
      const again = (await this.authed('GET', `/v1/order/${created.id}`).catch(() => null)) as { order?: unknown } | null
      if (again?.order) return parseOrder(again.order, created.id)
    }
    return created
  }

  /** Leaves the holding's sale on the book, at its target. */
  private async placeAutoSell(h: Holding, round: UsRound): Promise<void> {
    if (this.ledger.autoSellOff || h.contracts < 1 || h.slug !== round.slug) return
    const target = autoSellPrice(h.value / h.contracts, this.ledger.autoSellPct, round.tick)
    if (target === null) return
    const contracts = Math.floor(h.contracts)
    const o = await this.send(`${h.side}-sell`, this.orderBody(round, h.side, 'sell', target, contracts, 'TIME_IN_FORCE_GOOD_TILL_CANCEL'))
    h.autoSell = { orderId: o.id, price: target, contracts, recorded: 0 }
    this.log(`[poly] auto-sell ${contracts} ${h.side} at ${cents(target)} (${o.id})`)
  }

  /** Rounds that ended start waiting for their result; auto-sells are collected; results settle. */
  private async step(): Promise<void> {
    const nowSec = this.nowSec()
    let changed = false
    const ended = this.ledger.holdings.filter((h) => h.end <= nowSec)
    if (ended.length) {
      this.ledger.holdings = this.ledger.holdings.filter((h) => h.end > nowSec)
      for (const h of ended) {
        await this.collectAutoSell(h).catch(() => false)
        h.autoSell = null
        if (h.contracts > 1e-9) this.ledger.settling.push(h)
      }
      changed = true
    }
    if (this.ledger.holdings.length) {
      await this.readAccount(true)
      for (const h of [...this.ledger.holdings]) {
        if (await this.collectAutoSell(h)) changed = true
        // Sold some other way (the Polymarket app): what the account holds is what is held.
        const held = this.heldOn(h.slug, h.side)
        if (this.now() - (h.changedAt ?? 0) >= SETTLE_POSITIONS_MS && held < h.contracts - 1e-6) {
          this.log(`[poly] ${h.slug} ${h.side}: the account holds ${held}, not ${h.contracts}`)
          h.value = round6((h.value * held) / h.contracts)
          h.cost = round6((h.cost * held) / h.contracts)
          h.contracts = held
          changed = true
        }
        if (h.contracts <= 1e-9) {
          await this.cancelAutoSell(h).catch(() => undefined)
          this.ledger.holdings = this.ledger.holdings.filter((x) => x !== h)
        }
      }
    }
    for (const h of [...this.ledger.settling]) {
      if (this.now() - (this.results.get(h.slug) ?? 0) < RESULT_EVERY_MS) continue
      this.results.set(h.slug, this.now())
      const round = parseUsRound(await this.gateway(`/v1/market/slug/${h.slug}`).catch(() => null))
      if (!round?.resolved) continue
      const settled = (await this.gateway(`/v1/markets/${h.slug}/settlement`).catch(() => null)) as { settlement?: unknown } | null
      const yes = amount(settled?.settlement)
      if (yes !== 0 && yes !== 1) continue
      const won = (yes === 1) === (h.side === 'up')
      this.ledger.settling = this.ledger.settling.filter((s) => s !== h)
      this.record(h, h.contracts, won ? h.contracts : 0, won ? 'won' : 'lost')
      this.results.delete(h.slug)
      this.log(`[poly] ${h.slug}: ${yes === 1 ? 'Up' : 'Down'}, ${h.side} ${won ? 'won' : 'lost'}`)
      changed = true
    }
    if (changed) await this.save()
  }

  private view(h: Holding): PolyPosition {
    return {
      slug: h.slug,
      side: h.side,
      contracts: h.contracts,
      cost: h.cost,
      avg: h.contracts > 0 ? round6(h.value / h.contracts) : null,
      start: h.start,
      end: h.end,
      autoSell: h.autoSell ? { price: h.autoSell.price, contracts: h.autoSell.contracts - h.autoSell.recorded } : null,
    }
  }

  async state(): Promise<PolyState> {
    this.viewedAt = this.now()
    this.wake()
    const { creds, live } = this.keys.resolve()
    let round: PolyState['round'] = null
    let problem = ''
    let current: UsRound | null = null
    try {
      current = await this.currentRound()
      if (current) {
        const b = await this.books(current)
        const side = (x: PolyBook) => ({ bid: x.bids[0]?.price ?? null, ask: x.asks[0]?.price ?? null })
        round = { slug: current.slug, start: current.start, end: current.end, strike: current.strike, up: side(b.up), down: side(b.down), tick: current.tick, open: current.open }
      }
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
    try {
      await this.readAccount()
    } catch (error) {
      problem ||= error instanceof Error ? error.message : String(error)
    }
    const positions = this.ledger.holdings.map((h) => this.view(h))
    // Held in this round but not bought here (the Polymarket app): shown, and Sell now works.
    if (current) {
      for (const side of ['up', 'down'] as const) {
        const held = this.heldOn(current.slug, side)
        if (held > 0 && !positions.some((p) => p.slug === current.slug && p.side === side))
          positions.push({ slug: current.slug, side, contracts: held, cost: null, avg: null, start: current.start, end: current.end, autoSell: null })
      }
    }
    return {
      asOf: this.now(),
      round,
      btc: await this.btcPrice(),
      buyingPower: this.account.buyingPower,
      positions,
      settling: this.ledger.settling.map((h) => this.view(h)),
      autoSellPct: this.ledger.autoSellPct,
      keyed: creds !== null,
      live,
      problem:
        problem ||
        this.problem ||
        (!creds ? 'Add your Polymarket US key on the computer: ⚙ → Polymarket US trading.' : !live ? 'Real-money orders are off. Turn them on on the computer: ⚙ → Polymarket US trading.' : '') ||
        (round ? '' : 'Polymarket US has not opened this round yet.'),
    }
  }

  stats(from: number): PolyStats {
    const plays = this.ledger.plays.filter((p) => p.closedAt >= from).sort((a, b) => b.closedAt - a.closedAt)
    return { from, plays, totals: polyTotals(plays) }
  }

  private requireLive(): void {
    const { creds, live } = this.keys.resolve()
    if (!creds) throw new PolyError(409, 'Add your Polymarket US key on the computer: ⚙ → Polymarket US trading.')
    if (!live) throw new PolyError(409, 'Real-money orders are off. Turn them on on the computer: ⚙ → Polymarket US trading.')
  }

  buy(raw: Record<string, unknown>): Promise<PolyResult> {
    return this.serial(async () => {
      this.requireLive()
      const side = raw.side
      const dollars = Number(raw.dollars)
      if (!isPolySide(side)) throw new PolyError(400, 'Choose Up or Down.')
      if (!(dollars >= 1 && dollars <= MAX_BUY_DOLLARS)) throw new PolyError(400, `Buy between $1 and ${money(MAX_BUY_DOLLARS)}.`)
      const round = await this.currentRound()
      if (!round || !round.open) throw new PolyError(409, 'Polymarket US has not opened this round yet.')
      if (round.end - this.nowSec() < LAST_BUY_S) throw new PolyError(409, 'The round is closing. Wait for the next one.')
      const account = await this.readAccount(true)
      if (this.heldOn(round.slug, side === 'up' ? 'down' : 'up') > 0)
        throw new PolyError(409, `You hold ${word(side === 'up' ? 'down' : 'up')} in this round. Sell it first: buying ${word(side)} would cash it out.`)
      const book = (await this.books(round, true))[side]
      const ask = book.asks[0]?.price
      if (ask === undefined) throw new PolyError(409, `Nobody is selling ${word(side)} right now.`)
      const cap = Math.min(1 - round.tick, round6(ask + POLY_SLIPPAGE))
      const plan = planBuy(book.asks, dollars, cap)
      if (!plan) throw new PolyError(409, `${money(dollars)} does not buy a contract at ${cents(ask)}.`)
      if (account.buyingPower !== null && plan.value + plan.fee > account.buyingPower)
        throw new PolyError(409, `Only ${money(account.buyingPower)} to buy with on Polymarket US.`)
      const o = await this.send(`${side}-buy`, this.orderBody(round, side, 'buy', cap, plan.contracts, 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL'))
      this.account.at = 0
      if (!(o.filled > 0)) return { ok: false, message: `Nothing filled at ${cents(cap)} or better: the price moved. Nothing was bought.` }
      const avg = Number.isFinite(o.avgYes) ? sideAvg(side, o.avgYes, plan.avg) : plan.avg
      const value = round6(o.filled * avg)
      const fee = o.fee ?? polyFee(o.filled, avg)
      let h = this.ledger.holdings.find((x) => x.slug === round.slug && x.side === side)
      if (!h) {
        h = { slug: round.slug, side, contracts: 0, value: 0, cost: 0, start: round.start, end: round.end, tick: round.tick, autoSell: null }
        this.ledger.holdings.push(h)
      }
      await this.cancelAutoSell(h)
      h.contracts = round6(h.contracts + o.filled)
      h.value = round6(h.value + value)
      h.cost = round6(h.cost + value + fee)
      h.changedAt = this.now()
      await this.save()
      let note = ''
      try {
        await this.placeAutoSell(h, round)
        note = h.autoSell ? ` Auto-sell at ${cents(h.autoSell.price)}.` : ''
      } catch (error) {
        note = ` The auto-sell was not placed: ${error instanceof Error ? error.message : 'it failed'}.`
      }
      await this.save()
      this.wake()
      this.log(`[poly] bought ${o.filled} ${side} at ${cents(avg)} for ${money(value + fee)} (${o.id})`)
      return { ok: true, message: `Bought ${o.filled} ${word(side)} at ${cents(avg)} for ${money(value + fee)}.${note}` }
    })
  }

  sellNow(raw: Record<string, unknown>): Promise<PolyResult> {
    return this.serial(async () => {
      this.requireLive()
      const side = raw.side
      if (!isPolySide(side)) throw new PolyError(400, 'Choose Up or Down.')
      const round = await this.currentRound()
      if (!round || round.slug !== raw.slug) throw new PolyError(409, 'That round has closed; it settles on its result.')
      let h = this.ledger.holdings.find((x) => x.slug === round.slug && x.side === side)
      if (h) await this.cancelAutoSell(h)
      await this.readAccount(true)
      const held = Math.floor(this.heldOn(round.slug, side))
      if (held < 1) {
        if (h && h.contracts > 0) h.contracts = 0
        this.ledger.holdings = this.ledger.holdings.filter((x) => x.contracts > 1e-9)
        await this.save()
        throw new PolyError(404, `No ${word(side)} held in this round any more.`)
      }
      if (!h) {
        // Bought in the Polymarket app: sold all the same, its cost not known here.
        h = { slug: round.slug, side, contracts: held, value: 0, cost: 0, start: round.start, end: round.end, tick: round.tick, autoSell: null }
      }
      const book = (await this.books(round, true))[side]
      const bid = book.bids[0]?.price
      if (bid === undefined) {
        await this.placeAutoSell(h, round).catch(() => undefined)
        await this.save()
        throw new PolyError(409, 'Nobody is buying right now.')
      }
      const floor = Math.max(round.tick, round6(bid - POLY_SLIPPAGE))
      const o = await this.send(`${side}-sell`, this.orderBody(round, side, 'sell', floor, held, 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL'))
      this.account.at = 0
      if (!(o.filled > 0)) {
        await this.placeAutoSell(h, round).catch(() => undefined)
        await this.save()
        return { ok: false, message: `Nothing sold at ${cents(floor)} or better: the price moved.` }
      }
      const avg = Number.isFinite(o.avgYes) ? sideAvg(side, o.avgYes, bid) : bid
      const fee = o.fee ?? polyFee(o.filled, avg)
      const proceeds = round6(o.filled * avg - fee)
      if (this.ledger.holdings.includes(h)) {
        this.record(h, Math.min(o.filled, h.contracts), proceeds, 'sold')
        h.changedAt = this.now()
        if (h.contracts > 1e-9) await this.placeAutoSell(h, round).catch(() => undefined)
        else this.ledger.holdings = this.ledger.holdings.filter((x) => x !== h)
      }
      await this.save()
      const left = held - o.filled
      this.log(`[poly] sold ${o.filled} ${side} at ${cents(avg)} for ${money(proceeds)} (${o.id})`)
      return { ok: true, message: `Sold ${o.filled} at ${cents(avg)} for ${money(proceeds)}.${left > 0 ? ` ${left} still held.` : ''}` }
    })
  }

  /** The auto-sell's %, for the next buys and everything held now; null turns it off. */
  setAutoSell(raw: Record<string, unknown>): Promise<PolyResult> {
    return this.serial(async () => {
      const pct = raw.pct === null ? null : Number(raw.pct)
      if (pct !== null && !(pct >= 1 && pct <= 90)) throw new PolyError(400, 'Choose between 1% and 90%.')
      if (pct !== null) this.ledger.autoSellPct = pct
      this.ledger.autoSellOff = pct === null
      const round = await this.currentRound()
      const problems: string[] = []
      for (const h of this.ledger.holdings) {
        if (!round || h.slug !== round.slug) continue
        try {
          this.requireLive()
          await this.cancelAutoSell(h)
          await this.placeAutoSell(h, round)
        } catch (error) {
          problems.push(error instanceof Error ? error.message : 'failed')
        }
      }
      this.ledger.holdings = this.ledger.holdings.filter((h) => h.contracts > 1e-9)
      await this.save()
      const said = pct === null ? 'Auto-sell off.' : `Auto-sell at the top less ${pct}%.`
      return { ok: !problems.length, message: problems.length ? `${said} ${problems[0]}` : said }
    })
  }

  /**
   * ⚙ → Check orders: previews all four kinds at prices far from the market (nothing is placed)
   * and says how Polymarket US reads each.
   */
  checkOrders(): Promise<PolyResult> {
    return this.serial(async () => {
      if (!this.keys.resolve().creds) throw new PolyError(409, 'Add a working key first.')
      const round = await this.currentRound()
      if (!round) throw new PolyError(409, 'No round is open right now. Try again in a minute.')
      const lines: string[] = []
      for (const kind of ['up-buy', 'up-sell', 'down-buy', 'down-sell'] as const) {
        const [side, action] = kind.split('-') as [PolySide, 'buy' | 'sell']
        // A buy far under the market and a sale far over it: what a preview fills is nothing.
        const sidePrice = action === 'buy' ? round.tick : 1 - round.tick
        const body = this.orderBody(round, side, action, sidePrice, 1, 'TIME_IN_FORCE_GOOD_TILL_CANCEL')
        this.checked.delete(kind)
        try {
          await this.check(kind, body)
          lines.push(`${word(side)} ${action}: read as meant`)
        } catch (error) {
          lines.push(`${word(side)} ${action}: ${error instanceof Error ? error.message : 'failed'}`)
        }
      }
      const ok = lines.every((l) => l.endsWith('read as meant'))
      return { ok, message: `${ok ? 'All four kinds of order are read as meant.' : 'Some orders would be refused.'} ${lines.join(' · ')}` }
    })
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

// ── The routes ──────────────────────────────────────────────────────────────────────────────

export function createPolyUsApi(dir = dirname(workspaceFile()), phone = new PhoneAccess(join(dir, 'phone.json')), engine = new PolyUsEngine(new PolyKeyStore(join(dir, 'polymarket-us.json')), join(dir, 'polymarket-us-plays.json'))) {
  const json = (res: ServerResponse, status: number, value: unknown) => {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(JSON.stringify(value))
  }

  const settings = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST') {
      const body = await readJson(req)
      if (body.save && typeof body.save === 'object') {
        const save = body.save as Record<string, unknown>
        await engine.keys.save(save.keyId, save.path)
        console.log('[poly] key saved')
      }
      if (body.clear === true) {
        await engine.keys.clear()
        console.log('[poly] key removed')
      }
      if (typeof body.liveTrading === 'boolean') {
        await engine.keys.setLive(body.liveTrading)
        console.log(`[poly] real-money orders ${body.liveTrading ? 'ON' : 'off'}`)
      }
    } else if (req.method !== 'GET') throw new PolyError(405, 'Use GET or POST.')
    json(res, 200, engine.keys.resolve().view)
  }

  const dispatch = async (req: IncomingMessage, res: ServerResponse, route: string) => {
    if (phone.phoneHost(req) !== null) {
      phone.guard(req)
      if (!POLY_PHONE_ROUTES.has(route)) throw new PolyError(403, 'Change that on the computer.')
    } else guardLocal(req)
    if (route === 'settings') return settings(req, res)
    if (route === 'state' || route === 'stats') {
      if (req.method !== 'GET') throw new PolyError(405, 'Use GET.')
      if (route === 'state') return json(res, 200, await engine.state())
      const from = Number(new URL(req.url ?? '/', 'http://poly.internal').searchParams.get('from'))
      return json(res, 200, engine.stats(Number.isFinite(from) ? from : 0))
    }
    if (req.method !== 'POST') throw new PolyError(405, 'Use POST.')
    const body = await readJson(req)
    console.log(`[poly] ${route} from the ${phone.phoneHost(req) ? 'phone' : 'computer'}`)
    if (route === 'buy') return json(res, 200, await engine.buy(body))
    if (route === 'sell-now') return json(res, 200, await engine.sellNow(body))
    if (route === 'auto-sell') return json(res, 200, await engine.setAutoSell(body))
    if (route === 'check') return json(res, 200, await engine.checkOrders())
    throw new PolyError(404, 'Not found.')
  }

  return {
    engine,
    handle(req: IncomingMessage, res: ServerResponse): boolean {
      const path = req.url?.split('?')[0] ?? ''
      if (!path.startsWith('/api/poly/')) return false
      void dispatch(req, res, path.slice('/api/poly/'.length)).catch((error: unknown) => {
        const status = error instanceof PolyError || error instanceof PhoneError ? error.status : 502
        if (!(error instanceof PolyError) && !(error instanceof PhoneError)) console.log(`[poly] ${error instanceof Error ? error.stack : String(error)}`)
        json(res, status, { ok: false, message: error instanceof Error ? error.message : 'The request failed.' })
      })
      return true
    },
  }
}

/** Serves /api/poly/* from `npm run dev` and `npm run preview`, behind the phone gate. */
export function polyUsPlugin(): Plugin {
  let api: ReturnType<typeof createPolyUsApi> | null = null
  const use = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    api ??= createPolyUsApi()
    if (!api.handle(req, res)) next()
  }
  const stop = () => {
    api?.engine.close()
    api = null
  }
  return {
    name: 'cryptoanal-poly-us',
    configureServer(server) {
      server.middlewares.use(use)
      server.httpServer?.on('close', stop)
    },
    configurePreviewServer(server) {
      server.middlewares.use(use)
      server.httpServer?.on('close', stop)
    },
  }
}
