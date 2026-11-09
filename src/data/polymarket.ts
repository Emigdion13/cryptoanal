/**
 * Polymarket's strike for a coin, polled through the dev server (/api/polymarket/strike) while some
 * chart shows the Polymarket Strike indicator, and shared by every chart of that coin.
 */
import type { PolymarketStrikeReply } from '../../server/polymarket'
import { underlying } from './chainlink'

export type { PolymarketCurrent, PolymarketStrikeReply, PolymarketWindow } from '../../server/polymarket'

/** Coins the indicator follows Polymarket's 5-minute up/down market on. */
export const POLYMARKET_PRODUCTS = new Set(['BTC-USD'])
export const POLYMARKET_WINDOW = 300

export interface PolymarketState {
  status: 'loading' | 'live' | 'waiting' | 'unavailable' | 'unsupported'
  message: string
  reply: PolymarketStrikeReply | null
}

interface Watch {
  state: PolymarketState
  listeners: Set<() => void>
  timer?: ReturnType<typeof setTimeout>
  controller: AbortController
}

const watches = new Map<string, Watch>()

/**
 * How long to wait before asking again. Hard either side of a window boundary, when Polymarket
 * publishes the next strike, and every 5 seconds otherwise for the Up price.
 */
export function polymarketPollDelay(nowMs: number): number {
  const into = (nowMs / 1000) % POLYMARKET_WINDOW
  return into < 20 || POLYMARKET_WINDOW - into < 20 ? 2500 : 5000
}

export function polymarketState(chartProduct: string): PolymarketState {
  // A Chainlink chart of a coin shows the same market as its Coinbase chart.
  const product = underlying(chartProduct)
  return (
    watches.get(product)?.state ??
    (POLYMARKET_PRODUCTS.has(product)
      ? { status: 'loading', message: 'Asking Polymarket…', reply: null }
      : { status: 'unsupported', message: 'Polymarket Strike follows Bitcoin only.', reply: null })
  )
}

async function poll(product: string, w: Watch) {
  try {
    const res = await fetch(`/api/polymarket/strike?product=${encodeURIComponent(product)}`, { cache: 'no-store', signal: w.controller.signal })
    const body = (await res.json().catch(() => null)) as (PolymarketStrikeReply & { error?: string }) | null
    if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`)
    w.state = { status: body.current ? 'live' : 'waiting', message: body.message, reply: body }
  } catch (error) {
    if (w.controller.signal.aborted) return
    // A dropped poll keeps the last good strike on screen.
    w.state = {
      status: 'unavailable',
      message: `Polymarket unavailable: ${error instanceof Error ? error.message : String(error)}`,
      reply: w.state.reply,
    }
  }
  w.listeners.forEach((fn) => fn())
  if (!w.controller.signal.aborted) w.timer = setTimeout(() => void poll(product, w), polymarketPollDelay(Date.now()))
}

/** Keeps `product`'s strike fresh while anyone watches; `fn` hears every update. */
export function watchPolymarket(chartProduct: string, fn: () => void): () => void {
  const product = underlying(chartProduct)
  if (!POLYMARKET_PRODUCTS.has(product)) return () => {}
  let w = watches.get(product)
  if (!w) {
    w = { state: polymarketState(product), listeners: new Set(), controller: new AbortController() }
    watches.set(product, w)
    void poll(product, w)
  }
  w.listeners.add(fn)
  const watch = w
  return () => {
    watch.listeners.delete(fn)
    if (watch.listeners.size) return
    watch.controller.abort()
    clearTimeout(watch.timer)
    watches.delete(product)
  }
}
