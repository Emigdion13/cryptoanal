import { fetchCandles, PAGE } from './coinbase'
import type { Candle } from './types'

/**
 * Coinbase candles for one product and granularity, kept for the whole session so switching
 * back to a chart is instant. History is paged backwards on demand; live trades update the tail.
 */
export class CandleCache {
  candles: Candle[] = []
  /** No older candles exist. */
  exhausted = false
  private older: Promise<number> | null = null
  private lastPageWasEmpty = false

  constructor(
    readonly product: string,
    readonly granularity: number,
  ) {}

  get oldest(): number | null {
    return this.candles.length ? this.candles[0].time : null
  }

  /** Fetches the newest page and merges it in. */
  async loadLatest(): Promise<void> {
    const g = this.granularity
    const end = Math.floor(Date.now() / 1000 / g) * g
    const fresh = await fetchCandles(this.product, g, end - (PAGE - 1) * g, end)
    const last = this.candles[this.candles.length - 1]
    // Away from this chart for more than a page: start over rather than keep a hole.
    if (last && fresh.length && fresh[0].time > last.time + g) {
      this.candles = []
      this.exhausted = false
    }
    this.mergeIn(fresh)
  }

  /** Fetches up to `pages` pages before the oldest candle. Resolves with how many were added. */
  loadOlder(pages = 1): Promise<number> {
    if (this.older) return this.older
    this.older = this.fetchOlder(pages).finally(() => (this.older = null))
    return this.older
  }

  /** Pages back until the oldest candle is at or before `time`, or history runs out. */
  async ensureFrom(time: number, maxPages = 60): Promise<void> {
    let pages = 0
    while (!this.exhausted && pages < maxPages && (this.oldest ?? Infinity) > time) {
      // Only the pages that reach `time`, four at a time at most.
      const needed = this.oldest === null ? 1 : Math.ceil((this.oldest - time) / (PAGE * this.granularity))
      const step = Math.max(1, Math.min(4, needed, maxPages - pages))
      await this.loadOlder(step)
      pages += step
    }
  }

  /** Pages back until at least `count` candles are loaded. */
  async ensureCount(count: number): Promise<void> {
    while (!this.exhausted && this.candles.length < count) {
      const missing = Math.ceil((count - this.candles.length) / PAGE)
      if (!(await this.loadOlder(Math.min(4, missing))) && !this.exhausted) break
    }
  }

  private async fetchOlder(pages: number): Promise<number> {
    const g = this.granularity
    const before = this.oldest ?? Math.floor(Date.now() / 1000 / g) * g + g
    const ends = Array.from({ length: pages }, (_, i) => before - g - i * PAGE * g)
    const results = await Promise.all(
      ends.map((end) => fetchCandles(this.product, g, end - (PAGE - 1) * g, end)),
    )
    // An empty page means the product didn't trade yet — unless it is just a gap (an outage),
    // which is why only a run of empty pages at the far end counts as the start of history.
    let emptyTail = 0
    for (let i = results.length - 1; i >= 0 && !results[i].length; i--) emptyTail++
    if (emptyTail >= 2 || (results.length === 1 && emptyTail === 1 && this.lastPageWasEmpty))
      this.exhausted = true
    this.lastPageWasEmpty = emptyTail > 0
    const count = this.candles.length
    this.mergeIn(results.flat())
    return this.candles.length - count
  }

  /**
   * Folds a trade into the newest candle. Returns false when the trade is older than the
   * newest candle or nothing is loaded yet.
   */
  applyTrade(price: number, size: number, time: number): boolean {
    const last = this.candles[this.candles.length - 1]
    if (!last) return false
    const start = Math.floor(time / this.granularity) * this.granularity
    if (start < last.time) return false
    if (start === last.time) {
      if (price > last.high) last.high = price
      if (price < last.low) last.low = price
      last.close = price
      last.volume += size
    } else {
      this.candles.push({ time: start, open: price, high: price, low: price, close: price, volume: size })
    }
    return true
  }

  private mergeIn(fresh: Candle[]) {
    if (!fresh.length) return
    const byTime = new Map<number, Candle>()
    for (const c of this.candles) byTime.set(c.time, c)
    const newest = this.candles[this.candles.length - 1]
    for (const c of fresh) {
      const mine = byTime.get(c.time)
      // The newest candle is live: REST can lag the trades the socket already folded in.
      if (mine && mine === newest && mine.volume > c.volume) continue
      byTime.set(c.time, c)
    }
    this.candles = [...byTime.values()].sort((a, b) => a.time - b.time)
  }
}

const caches = new Map<string, CandleCache>()

export function getCache(product: string, granularity: number): CandleCache {
  const key = `${product}|${granularity}`
  let cache = caches.get(key)
  if (!cache) caches.set(key, (cache = new CandleCache(product, granularity)))
  return cache
}
