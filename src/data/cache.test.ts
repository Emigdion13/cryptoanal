import { describe, expect, it } from 'vitest'
import { CandleCache } from './cache'

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
