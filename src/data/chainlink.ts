/**
 * Chainlink prices, the ones Polymarket's crypto up/down markets settle on, as chart products:
 * `CL:BTC-USD` and the like. Live prices come straight from Polymarket's Real-Time Data Socket,
 * the same push Polymarket's own page draws from, so the chart moves when Polymarket's does;
 * history comes from the dev server, which records the socket while it runs (server/chainlink.ts).
 */
import type { ChainlinkCandlesReply } from '../../server/chainlink'
import { parseRtds, RTDS_URL } from './rtds'
import type { Candle, Product } from './types'

export const CHAINLINK_PREFIX = 'CL:'

/** Chainlink products in the symbol list, in Coinbase's spelling after the prefix. */
export const CHAINLINK_PRODUCTS = ['CL:BTC-USD', 'CL:ETH-USD', 'CL:SOL-USD', 'CL:XRP-USD'] as const

export const isChainlink = (id: string) => id.startsWith(CHAINLINK_PREFIX)
/** `CL:BTC-USD` → `BTC-USD`; anything else as it is. */
export const underlying = (id: string) => (isChainlink(id) ? id.slice(CHAINLINK_PREFIX.length) : id)
/** `CL:BTC-USD` → `btc/usd`, the socket's spelling. */
export const rtdsSymbol = (id: string) => underlying(id).replace('-', '/').toLowerCase()
const productOf = (symbol: string) => `${CHAINLINK_PREFIX}${symbol.replace('/', '-').toUpperCase()}`

export function chainlinkProduct(id: string): Product {
  const [base, quote] = underlying(id).split('-')
  return { id, base, quote, ticker: `${base}${quote}.CL`, precision: base === 'XRP' ? 4 : 2 }
}

export interface ChainlinkPage {
  candles: Candle[]
  earliest: number | null
  lastTick: number | null
}

/** Recorded candles of `granularity` seconds with their open in [start, end], oldest first. */
export async function fetchChainlinkCandles(product: string, granularity: number, start: number, end: number): Promise<ChainlinkPage> {
  const params = new URLSearchParams({ symbol: rtdsSymbol(product), granularity: String(granularity), start: String(start), end: String(end) })
  const res = await fetch(`/api/chainlink/candles?${params}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Chainlink history ${res.status}`)
  const body = (await res.json()) as ChainlinkCandlesReply
  return { candles: body.candles, earliest: body.earliest, lastTick: body.lastTick }
}

/** One price as the chart takes it: `ms` doubles as a rising id. */
export interface ChainlinkPrice {
  product: string
  price: number
  /** Seconds since the epoch. */
  time: number
  ms: number
}

type Listener = (p: ChainlinkPrice) => void

/** One socket to Polymarket for every Chainlink chart, kept open while any of them is. */
class ChainlinkFeed {
  private ws: WebSocket | null = null
  private listeners = new Map<string, Set<Listener>>()
  private reconnectListeners = new Set<() => void>()
  /** The newest price passed on per coin: a new subscription's minute repeats what came before. */
  private last = new Map<string, number>()
  private retry = 0
  private lastMessage = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private opened = false

  subscribe(product: string, fn: Listener): () => void {
    const symbol = rtdsSymbol(product)
    let set = this.listeners.get(symbol)
    if (!set) {
      set = new Set()
      this.listeners.set(symbol, set)
      this.send(symbol)
    }
    set.add(fn)
    this.ensure()
    return () => {
      const s = this.listeners.get(symbol)
      if (!s) return
      s.delete(fn)
      if (s.size) return
      this.listeners.delete(symbol)
      if (!this.listeners.size) this.close()
    }
  }

  onReconnect(fn: () => void): () => void {
    this.reconnectListeners.add(fn)
    return () => this.reconnectListeners.delete(fn)
  }

  /** Folds in one socket message (exported through `chainlinkFeed` for tests). */
  dispatch(text: string) {
    for (const tick of parseRtds(text)) {
      const set = this.listeners.get(tick.symbol)
      if (!set) continue
      if (tick.ms <= (this.last.get(tick.symbol) ?? 0)) continue
      this.last.set(tick.symbol, tick.ms)
      const p: ChainlinkPrice = { product: productOf(tick.symbol), price: tick.value, time: tick.ms / 1000, ms: tick.ms }
      for (const fn of set) fn(p)
    }
  }

  private send(symbol: string) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: JSON.stringify({ symbol }) }] }))
  }

  private close() {
    const ws = this.ws
    this.ws = null
    clearInterval(this.timer)
    ws?.close()
  }

  private ensure() {
    if (this.ws) return
    const ws = new WebSocket(RTDS_URL)
    this.ws = ws
    this.lastMessage = Date.now()
    ws.onopen = () => {
      this.retry = 0
      for (const symbol of this.listeners.keys()) this.send(symbol)
      if (this.opened) for (const fn of this.reconnectListeners) fn()
      this.opened = true
    }
    ws.onmessage = (event) => {
      this.lastMessage = Date.now()
      this.dispatch(String(event.data))
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      clearInterval(this.timer)
      if (!this.listeners.size) return
      setTimeout(() => this.ensure(), Math.min(15000, 500 * 2 ** this.retry++))
    }
    ws.onerror = () => ws.close()
    clearInterval(this.timer)
    this.timer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
      // Polymarket drops a socket that says nothing; a price a second means silence is a dead one.
      ws.send('PING')
      if (Date.now() - this.lastMessage > 20000) ws.close()
    }, 5000)
  }
}

export const chainlinkFeed = new ChainlinkFeed()
