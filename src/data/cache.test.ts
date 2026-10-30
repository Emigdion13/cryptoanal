import { afterEach, describe, expect, it, vi } from 'vitest'
import { CandleCache, secondCandles, TradeCache } from './cache'

describe('CandleCache.applyTrade', () => {
  const seeded = () => {
    const c = new CandleCache('BTC-USD', 60)
    c.candles = [{ time: 600, open: 10, high: 10, low: 10, close: 10, volume: 1 }]
    return c
  }

  it('counts a trade once however many charts hand it on', () => {
    const c = seeded()
    expect(c.applyTrade(11, 2, 610, 7)).toBe(true)
    expect(c.applyTrade(11, 2, 610, 7)).toBe(true)
    expect(c.candles[0]).toMatchObject({ high: 11, close: 11, volume: 3 })
    c.applyTrade(9, 1, 620, 8)
    expect(c.candles[0]).toMatchObject({ low: 9, close: 9, volume: 4 })
  })

  it('opens the next candle, and ignores trades older than the newest', () => {
    const c = seeded()
    expect(c.applyTrade(12, 1, 665, 3)).toBe(true)
    expect(c.candles.map((x) => x.time)).toEqual([600, 660])
    expect(c.applyTrade(5, 1, 590, 4)).toBe(false)
  })
})

describe('TradeCache', () => {
  const trade = (id: number, time: number, price: number, size = 1) => ({ trade_id: id, time: new Date(time * 1000).toISOString(), price: String(price), size: String(size) })
  /** A fake Coinbase with trades 1..n, one every half second from t=1000; pages of 1000 by `after`. */
  const serve = (n: number) => {
    const all = Array.from({ length: n }, (_, k) => trade(k + 1, 1000 + k / 2, 100 + (k % 7)))
    vi.stubGlobal('fetch', async (url: string) => {
      const after = Number(new URL(url).searchParams.get('after') ?? Infinity)
      const page = all.filter((t) => t.trade_id < after).reverse().slice(0, 1000)
      return { ok: true, status: 200, json: async () => page }
    })
    return all
  }
  afterEach(() => vi.unstubAllGlobals())

  it('builds one-second candles from trades', () => {
    const candles = secondCandles([
      { id: 3, time: 11.2, price: 7, size: 1 },
      { id: 2, time: 10.9, price: 9, size: 2 },
      { id: 1, time: 10.1, price: 8, size: 1 },
    ])
    expect(candles).toEqual([
      { time: 10, open: 8, high: 9, low: 8, close: 9, volume: 3 },
      { time: 11, open: 7, high: 7, low: 7, close: 7, volume: 1 },
    ])
  })

  it('pages back through trades and stitches the seconds the pages share', async () => {
    serve(2500)
    const c = new TradeCache('BTC-USD')
    await c.loadLatest()
    expect(c.candles.length).toBe(500)
    await c.loadOlder(2)
    // 2500 trades, two a second: 1250 seconds, none counted twice where pages meet.
    expect(c.candles.length).toBe(1250)
    expect(c.candles.every((x) => x.volume === 2)).toBe(true)
    expect(c.candles[0].time).toBe(1000)
    await c.loadOlder(1)
    expect(c.exhausted).toBe(true)
  })

  it('keeps live trades that arrive before the first page', async () => {
    serve(10)
    const c = new TradeCache('BTC-USD')
    expect(c.applyTrade(200, 1, 1010, 11)).toBe(false)
    await c.loadLatest()
    expect(c.candles[c.candles.length - 1]).toMatchObject({ time: 1010, close: 200, volume: 1 })
  })
})
