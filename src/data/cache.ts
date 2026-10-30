import { fetchCandles, fetchTrades, PAGE, type Trade } from './coinbase'
import { TRADE_GRANULARITY } from './intervals'
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
  /** The newest trade folded in: every chart on this product and granularity hands it the same trades. */
  protected lastTradeId = 0

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

  /** Pages back until at least `count` candles are loaded; `progress` runs after each batch. */
  async ensureCount(count: number, progress?: () => void): Promise<void> {
    while (!this.exhausted && this.candles.length < count) {
      const missing = Math.ceil((count - this.candles.length) / PAGE)
      if (!(await this.loadOlder(Math.min(4, missing))) && !this.exhausted) break
      progress?.()
    }
  }

  protected async fetchOlder(pages: number): Promise<number> {
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
   * Folds a trade into the newest candle, once however many charts pass it on. Returns false when
   * the trade is older than the newest candle or nothing is loaded yet.
   */
  applyTrade(price: number, size: number, time: number, id?: number): boolean {
    const last = this.candles[this.candles.length - 1]
    if (!last) return false
    const start = Math.floor(time / this.granularity) * this.granularity
    if (start < last.time) return false
    if (id !== undefined && Number.isFinite(id)) {
      if (id <= this.lastTradeId) return true
      this.lastTradeId = id
    }
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

/** Trade pages read at most to fill a seconds chart when it opens; scrolling back reads more. */
const TRADE_PAGES_INITIAL = 30

/**
 * One-second candles built from Coinbase's trades, which have no candles under a minute. Trades
 * page back by id, one page at a time, so history comes slower than candles do.
 */
export class TradeCache extends CandleCache {
  /** The oldest trade read: the cursor for the next older page. */
  private oldestTradeId = 0
  /** Live trades that came before the first page: folded in once it lands. */
  private early: Trade[] = []

  constructor(product: string) {
    super(product, TRADE_GRANULARITY)
  }

  async loadLatest(): Promise<void> {
    const trades = await fetchTrades(this.product)
    if (!trades.length) return
    const oldest = trades[trades.length - 1].id
    // Nothing yet, or away for more than a page: start over rather than keep a hole.
    if (!this.candles.length || oldest > this.lastTradeId + 1) {
      this.candles = secondCandles(trades)
      this.oldestTradeId = oldest
      this.lastTradeId = trades[0].id
      this.exhausted = false
      for (const t of this.early) super.applyTrade(t.price, t.size, t.time, t.id)
      this.early = []
      return
    }
    for (let k = trades.length - 1; k >= 0; k--) {
      const t = trades[k]
      if (t.id > this.lastTradeId) super.applyTrade(t.price, t.size, t.time, t.id)
    }
  }

  async ensureFrom(time: number, maxPages = 60): Promise<void> {
    for (let pages = 0; !this.exhausted && pages < maxPages && (this.oldest ?? Infinity) > time; pages++)
      await this.loadOlder(1)
  }

  /** `count` one-second candles means that many seconds back from the newest. */
  async ensureCount(count: number, progress?: () => void): Promise<void> {
    for (let pages = 0; !this.exhausted && pages < TRADE_PAGES_INITIAL; pages++) {
      const newest = this.candles[this.candles.length - 1]?.time
      if (newest !== undefined && (this.oldest ?? Infinity) <= newest - count) break
      await this.loadOlder(1)
      progress?.()
    }
  }

  applyTrade(price: number, size: number, time: number, id?: number): boolean {
    if (!this.candles.length && id !== undefined && this.early.length < 5000) this.early.push({ id, time, price, size })
    return super.applyTrade(price, size, time, id)
  }

  /** Resolves with how many trades were read: a busy second can take a page without adding a candle. */
  protected async fetchOlder(pages: number): Promise<number> {
    let read = 0
    for (let p = 0; p < pages && !this.exhausted; p++) {
      if (!this.oldestTradeId) {
        await this.loadLatest()
        read += this.candles.length
        continue
      }
      const trades = await fetchTrades(this.product, this.oldestTradeId)
      if (!trades.length) {
        this.exhausted = true
        break
      }
      this.oldestTradeId = trades[trades.length - 1].id
      this.prepend(secondCandles(trades))
      read += trades.length
    }
    return read
  }

  /** Older candles go in front; one may share its second with the current oldest. */
  private prepend(older: Candle[]) {
    const first = this.candles[0]
    const last = older[older.length - 1]
    if (first && last && last.time === first.time) {
      first.open = last.open
      if (last.high > first.high) first.high = last.high
      if (last.low < first.low) first.low = last.low
      first.volume += last.volume
      older.pop()
    }
    this.candles = older.concat(this.candles)
  }
}

/** Trades (newest first) as one-second candles, oldest first. */
export function secondCandles(trades: readonly Trade[]): Candle[] {
  const out: Candle[] = []
  for (let k = trades.length - 1; k >= 0; k--) {
    const { price, size } = trades[k]
    const time = Math.floor(trades[k].time)
    const last = out[out.length - 1]
    if (last && last.time === time) {
      if (price > last.high) last.high = price
      if (price < last.low) last.low = price
      last.close = price
      last.volume += size
    } else out.push({ time, open: price, high: price, low: price, close: price, volume: size })
  }
  return out
}

const caches = new Map<string, CandleCache>()

export function getCache(product: string, granularity: number): CandleCache {
  const key = `${product}|${granularity}`
  let cache = caches.get(key)
  if (!cache)
    caches.set(key, (cache = granularity === TRADE_GRANULARITY ? new TradeCache(product) : new CandleCache(product, granularity)))
  return cache
}
