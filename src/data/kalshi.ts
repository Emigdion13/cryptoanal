/**
 * Kalshi's strike for a coin, polled through the dev server (/api/kalshi/strike) while some chart
 * shows the Kalshi Strike indicator, and shared by every chart of that coin.
 */
import type { KalshiStrikeReply } from '../../server/kalshi'

export type { KalshiCurrent, KalshiStrikeReply, KalshiWindow } from '../../server/kalshi'

/** Coins Kalshi runs a 15-minute up/down market on. */
export const KALSHI_PRODUCTS = new Set(['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD', 'HYPE-USD', 'BNB-USD'])
export const KALSHI_WINDOW = 900

export interface KalshiState {
  status: 'loading' | 'live' | 'waiting' | 'unavailable' | 'unsupported'
  message: string
  reply: KalshiStrikeReply | null
}

interface Watch {
  state: KalshiState
  listeners: Set<() => void>
  timer?: ReturnType<typeof setTimeout>
  controller: AbortController
}

const watches = new Map<string, Watch>()

/**
 * How long to wait before asking again. Hard either side of a window boundary, when Kalshi
 * publishes the next strike (V2's rhythm), and every 5 seconds otherwise for the Yes price.
 */
export function kalshiPollDelay(nowMs: number): number {
  const into = (nowMs / 1000) % KALSHI_WINDOW
  return into < 20 || KALSHI_WINDOW - into < 20 ? 2500 : 5000
}

export function kalshiState(product: string): KalshiState {
  return (
    watches.get(product)?.state ??
    (KALSHI_PRODUCTS.has(product)
      ? { status: 'loading', message: 'Asking Kalshi…', reply: null }
      : { status: 'unsupported', message: 'Kalshi runs no 15-minute market on this coin.', reply: null })
  )
}

async function poll(product: string, w: Watch) {
  try {
    const res = await fetch(`/api/kalshi/strike?product=${encodeURIComponent(product)}`, { cache: 'no-store', signal: w.controller.signal })
    const body = (await res.json().catch(() => null)) as (KalshiStrikeReply & { error?: string }) | null
    if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`)
    w.state = { status: body.current ? 'live' : 'waiting', message: body.message, reply: body }
  } catch (error) {
    if (w.controller.signal.aborted) return
    // A dropped poll keeps the last good strike on screen.
    w.state = {
      status: 'unavailable',
      message: `Kalshi unavailable: ${error instanceof Error ? error.message : String(error)}`,
      reply: w.state.reply,
    }
  }
  w.listeners.forEach((fn) => fn())
  if (!w.controller.signal.aborted) w.timer = setTimeout(() => void poll(product, w), kalshiPollDelay(Date.now()))
}

/** Keeps `product`'s strike fresh while anyone watches; `fn` hears every update. */
export function watchKalshi(product: string, fn: () => void): () => void {
  if (!KALSHI_PRODUCTS.has(product)) return () => {}
  let w = watches.get(product)
  if (!w) {
    w = { state: kalshiState(product), listeners: new Set(), controller: new AbortController() }
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
